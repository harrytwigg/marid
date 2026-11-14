import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { SsePtyProxy, type SsePtyProxyOpts } from "../sse-pty-proxy.js";
import {
  callProxy,
  fakeUpstreamRequest,
  fakeUpstreamResponse,
  startUpstream,
  wait,
  withDeadline,
  type Upstream,
} from "./helpers/sse-pty-upstream.js";

// Regression tests: one stream's death took every other stream with
// it. Two blast radii are covered here — the socket pool (it was module scope,
// so every session drew from one 64-socket bucket) and the in-flight upstream
// handle a finished stream used to keep pointing at.

describe("SsePtyProxy cross-stream isolation", () => {
  const proxies: SsePtyProxy[] = [];
  const upstreams: Upstream[] = [];
  const agents: http.Agent[] = [];
  const clients: http.ClientRequest[] = [];
  const heldUpstreamResponses: http.ServerResponse[] = [];

  afterEach(async () => {
    for (const r of heldUpstreamResponses.splice(0)) { try { r.end(); } catch { /* gone */ } }
    for (const c of clients.splice(0)) c.destroy();
    for (const p of proxies.splice(0)) p.stop();
    for (const u of upstreams.splice(0)) await u.close();
    for (const a of agents.splice(0)) a.destroy();
  });

  /** A proxy pointed at `u`. With no `primaryAgent` it builds its OWN pool — the
   *  production path — and `protocol` keeps that pool plaintext for the fake upstream. */
  const newProxy = (u: Upstream, extra: Partial<SsePtyProxyOpts> = {}) => {
    const p = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: u.port, protocol: "http:" },
      ...extra,
    });
    proxies.push(p);
    return p;
  };

  it("one proxy's wedged streams do not starve another proxy's stream", async () => {
    // Stream A wedges: the upstream answers headers and then goes silent, holding
    // its socket exactly as a corrupted-but-not-yet-errored connection does.
    const upstream = await startUpstream((_n, req, res) => {
      if (req.headers["x-wedge"]) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {}\n\n");
        heldUpstreamResponses.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("B-COMPLETE-BODY");
    });
    upstreams.push(upstream);

    const portA = await newProxy(upstream).start();
    const portB = await newProxy(upstream).start();

    // Saturate proxy A's pool. `maxSockets` is not exported, so drive well past any
    // plausible bound; on a shared pool this leaves nothing for proxy B.
    const wedged = 80;
    for (let i = 0; i < wedged; i++) {
      const r = http.request(
        { hostname: "127.0.0.1", port: portA, path: "/v1/messages", method: "POST", agent: false, headers: { "x-wedge": "1" } },
        (res) => res.resume(),
      );
      r.on("error", () => { /* torn down in afterEach */ });
      r.end("{}");
      clients.push(r);
    }
    for (let i = 0; i < 100 && heldUpstreamResponses.length < wedged; i++) await wait(50);

    const outB = await withDeadline(callProxy(portB), 3000);

    expect(outB.status).toBe(200);
    expect(outB.body).toBe("B-COMPLETE-BODY");
  }, 20000);

  it("a mid-flight abort on a SHARED pool leaves the sibling stream whole", async () => {
    // Both proxies draw from ONE pool holding a single socket, so B is genuinely
    // queued behind A rather than merely concurrent with it. A's client hangs up
    // before a single response byte: the abandoned stream has to hand the socket
    // back AND stop consuming upstream capacity. On main it does neither cleanly —
    // the abort-destroyed request reports `socket hang up`, still satisfies the
    // retry condition, and issues a ghost upstream turn for a client that left.
    const upstream = await startUpstream((_n, req, res) => {
      if (req.headers["x-wedge"]) { heldUpstreamResponses.push(res); return; } // never answers
      res.writeHead(200, { "content-type": "application/json" });
      res.end("B-COMPLETE-BODY");
    });
    upstreams.push(upstream);

    const sharedPool = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(sharedPool);
    const portA = await newProxy(upstream, { primaryAgent: sharedPool }).start();
    const portB = await newProxy(upstream, { primaryAgent: sharedPool }).start();

    const reqA = http.request(
      { hostname: "127.0.0.1", port: portA, path: "/v1/messages", method: "POST", agent: false, headers: { "x-wedge": "1" } },
      (res) => res.resume(),
    );
    reqA.on("error", () => { /* aborted below */ });
    reqA.end("{}");
    for (let i = 0; i < 100 && upstream.attempts() < 1; i++) await wait(20);

    const bDone = callProxy(portB); // queued on the shared pool's only socket
    await wait(100);
    reqA.destroy(); // stream A's client goes away before any response

    const outB = await withDeadline(bDone, 3000);
    await wait(300); // a ghost turn for the dead client would have landed by now

    expect(outB.status).toBe(200);
    expect(outB.body).toBe("B-COMPLETE-BODY");
    expect(upstream.attempts()).toBe(2); // A's turn, then B's — nothing for the client that left
  }, 20000);

  it("a completed stream's late hang-up spares the socket now serving another stream", async () => {
    // A finishes upstream with 8 MB still queued to a client that never reads, so
    // its response is provably unflushed (writableFinished false) when the client
    // hangs up — the nearest the stack gets to a stale in-flight destroy. By then
    // keep-alive has handed A's socket to B, and destroying a request takes the
    // socket under it down. `pooledSocket` is that socket; the fake upstream is
    // what puts both streams provably on it.
    //
    // The second arm of the guard holds this up too: node marks a response
    // finished before it emits 'close', even on an RST mid-flush, so the destroy
    // is unreachable once a turn has ended. Clearing the handle on every terminal
    // path is what makes that an invariant of this proxy rather than a property
    // of node's event ordering.
    const pooledSocket = { destroyed: false };
    let liveResponse: http.IncomingMessage | undefined;
    const respond: ((r: http.IncomingMessage) => void)[] = [];
    const requestFn = ((_o: unknown, cb: (r: http.IncomingMessage) => void) =>
      fakeUpstreamRequest({
        onEnd: () => respond.push(cb),
        onDestroy: () => {
          pooledSocket.destroyed = true;
          liveResponse?.emit("error", new Error("pooled socket destroyed under a live stream"));
        },
      })) as SsePtyProxyOpts["requestFn"];

    const proxy = new SsePtyProxy("test", () => {}, { requestFn, primaryAgent: false });
    proxies.push(proxy);
    const port = await proxy.start();

    const reqA = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", agent: false },
      () => { /* never read, so A's body stays queued and A's response unfinished */ },
    );
    reqA.on("error", () => { /* hung up below */ });
    reqA.end("{}");
    for (let i = 0; i < 100 && respond.length < 1; i++) await wait(20);

    const aResponse = fakeUpstreamResponse({ "content-type": "application/json" });
    respond[0](aResponse);
    aResponse.emit("data", Buffer.alloc(8 * 1024 * 1024, "a"));
    aResponse.emit("end"); // A's turn is over; its socket goes back to the pool

    const bDone = callProxy(port);
    for (let i = 0; i < 100 && respond.length < 2; i++) await wait(20);
    const bResponse = fakeUpstreamResponse({ "content-type": "text/event-stream" });
    liveResponse = bResponse;
    respond[1](bResponse);
    bResponse.emit("data", Buffer.from("data: {}\n\n"));

    reqA.destroy(); // A's client hangs up only now, long after A's turn ended
    await wait(200);
    expect(pooledSocket.destroyed).toBe(false);

    bResponse.emit("data", Buffer.from('data: {"type":"done"}\n\n'));
    bResponse.emit("end");

    const outB = await withDeadline(bDone, 3000);
    expect(outB.status).toBe(200);
    expect(outB.body).toBe('data: {}\n\ndata: {"type":"done"}\n\n');
  }, 20000);
});
