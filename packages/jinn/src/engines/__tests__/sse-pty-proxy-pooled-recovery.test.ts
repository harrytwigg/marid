import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { SsePtyProxy, type SsePtyProxyOpts } from "../sse-pty-proxy.js";
import { MAX_UPSTREAM_ATTEMPTS } from "../upstream-pool.js";
import {
  callProxy,
  fakeUpstreamRequest,
  fakeUpstreamResponse,
  startUpstream,
  wait,
  type Upstream,
} from "./helpers/sse-pty-upstream.js";

// Regression tests: a transient fault on the POOLED first attempt
// reached the claude CLI as a bare 502, which its harness reads as stream death.
// Every other sse-pty-proxy suite passes `primaryAgent: false`, so the attempt
// production actually makes — the pooled one — had no coverage at all.

describe("SsePtyProxy pooled-attempt recovery", () => {
  const proxies: SsePtyProxy[] = [];
  const upstreams: Upstream[] = [];
  const agents: http.Agent[] = [];

  afterEach(async () => {
    for (const p of proxies.splice(0)) p.stop();
    for (const u of upstreams.splice(0)) await u.close();
    for (const a of agents.splice(0)) a.destroy();
  });

  /** A proxy pointed at `u`. With no `primaryAgent` it builds its OWN pool — the
   *  production path — and `protocol` keeps that pool plaintext for the fake upstream. */
  const newProxy = (u: Upstream) => {
    const p = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: u.port, protocol: "http:" },
    });
    proxies.push(p);
    return p;
  };

  it("recovers from a `bad record mac` on the POOLED first attempt", async () => {
    // The reported fault verbatim: OpenSSL tears the pooled TLS socket down
    // before any response byte, because the record layer got bytes it could not
    // authenticate. Only the retry may leave the pool — the first attempt has to
    // be the pooled one, or the test is not covering the path that broke.
    const pool = new http.Agent({ keepAlive: true });
    agents.push(pool);
    const agentPerAttempt: (http.Agent | false | undefined)[] = [];
    const requestFn = ((o: { agent?: http.Agent | false }, cb: (r: http.IncomingMessage) => void) => {
      agentPerAttempt.push(o.agent);
      const attemptNo = agentPerAttempt.length;
      const request = fakeUpstreamRequest({
        onEnd: () => {
          if (attemptNo === 1) {
            const err: NodeJS.ErrnoException = new Error(
              "write EPROTO 00B1:error:0A000119:SSL routines:ssl3_get_record:bad record mac",
            );
            err.code = "EPROTO";
            setImmediate(() => request.emit("error", err));
            return;
          }
          setImmediate(() => {
            const response = fakeUpstreamResponse({ "content-type": "application/json" });
            cb(response);
            setImmediate(() => { response.emit("data", Buffer.from("recovered")); response.emit("end"); });
          });
        },
      });
      return request;
    }) as SsePtyProxyOpts["requestFn"];

    const proxy = new SsePtyProxy("test", () => {}, { requestFn, primaryAgent: pool });
    proxies.push(proxy);
    const port = await proxy.start();

    const out = await callProxy(port);
    await wait(500); // an unbounded retry would keep firing past the response

    expect(out.status).toBe(200);
    expect(out.body).toBe("recovered");
    expect(agentPerAttempt).toHaveLength(2);
    expect(agentPerAttempt[0]).toBe(pool); // the attempt production makes
    expect(agentPerAttempt[1]).toBe(false); // the retry, on a guaranteed-fresh socket
  });

  it("recovers when the fault outlives the first retry, instead of 502-ing", async () => {
    // The production trace: attempt 0 hit `bad record mac`, the fresh-socket retry
    // hit `socket hang up` one second later, and the CLI got a bare 502.
    const upstream = await startUpstream((n, _req, res) => {
      if (n <= 2) { res.socket?.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("recovered");
    });
    upstreams.push(upstream);
    const port = await newProxy(upstream).start();

    const out = await callProxy(port);

    expect(out.status).toBe(200);
    expect(out.body).toBe("recovered");
    expect(upstream.attempts()).toBe(3);
  });

  it("stops at the attempt budget — a dead upstream 502s without looping", async () => {
    const upstream = await startUpstream((_n, _req, res) => { res.socket?.destroy(); });
    upstreams.push(upstream);
    const port = await newProxy(upstream).start();

    const out = await callProxy(port);
    await wait(500); // any unbounded retry would keep firing past the 502

    expect(out.status).toBe(502);
    expect(upstream.attempts()).toBe(MAX_UPSTREAM_ATTEMPTS);
  });

  it("a superseded attempt that errors again does not fire an extra request", async () => {
    // A retried-past ClientRequest keeps its 'error' listener. Before the fix its
    // closure still satisfied the retry condition, so a second error re-entered
    // the retry branch and issued an upstream request nobody was waiting for.
    let calls = 0;
    const requestFn = ((_o: unknown, cb: (r: http.IncomingMessage) => void) => {
      calls += 1;
      const attemptNo = calls;
      const request = fakeUpstreamRequest({
        onEnd: () => {
          if (attemptNo === 1) {
            const fail = () => request.emit("error", new Error("socket hang up"));
            setImmediate(fail);
            setImmediate(fail); // the same dead socket reports twice
            return;
          }
          setImmediate(() => {
            const response = fakeUpstreamResponse({});
            cb(response);
            setImmediate(() => { response.emit("data", Buffer.from("ok")); response.emit("end"); });
          });
        },
      });
      return request;
    }) as SsePtyProxyOpts["requestFn"];

    const proxy = new SsePtyProxy("test", () => {}, { requestFn, primaryAgent: false });
    proxies.push(proxy);
    const port = await proxy.start();

    const out = await callProxy(port);
    await wait(500);

    expect(out.status).toBe(200);
    expect(calls).toBe(2);
  });
});
