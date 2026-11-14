import { describe, expect, it } from "vitest";
import { resolveClientAddress } from "../client-address.js";
import type { ProxyTrustConfig } from "../../shared/proxy-trust-config.js";

interface Sent { peer?: string | undefined; headers?: Record<string, string>; raw?: Array<[string, string]> }

/** A request as the gateway sees it: the socket peer and the headers a client (or proxy) sent. */
function req({ peer, headers = {}, raw }: Sent) {
  return {
    socket: { remoteAddress: peer },
    headers,
    rawHeaders: (raw ?? Object.entries(headers)).flat(),
  } as never;
}
const resolve = (sent: Sent, trust?: ProxyTrustConfig) => resolveClientAddress(req(sent), trust);
const xff = (value: string) => ({ "x-forwarded-for": value });

describe("without trusted proxies", () => {
  it("is the socket peer, whatever the headers say", () => {
    for (const trust of [undefined, {}, { trustedProxies: [] }, { clientIpHeader: "cf-connecting-ip" }]) {
      const out = resolve({ peer: "203.0.113.9", headers: { ...xff("198.51.100.1"), "cf-connecting-ip": "198.51.100.2" } }, trust);
      expect(out).toEqual({ address: "203.0.113.9", shared: false });
    }
  });

  it("has no address when the socket gave none, and treats that as shared", () => {
    expect(resolve({ peer: undefined })).toEqual({ address: undefined, shared: true });
  });

  it("calls a loopback peer shared, in every spelling", () => {
    for (const peer of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(resolve({ peer, headers: xff("198.51.100.1") }).shared).toBe(true);
    }
  });

  it("strips a v4-mapped prefix and lowercases the peer", () => {
    expect(resolve({ peer: "::ffff:203.0.113.9" }).address).toBe("203.0.113.9");
    expect(resolve({ peer: "2001:DB8::ABCD" }).address).toBe("2001:db8::abcd");
  });
});

describe("X-Forwarded-For from a trusted peer", () => {
  const trust = { trustedProxies: ["127.0.0.1", "10.0.0.0/8"] };

  it("ignores a header from an untrusted peer (a spoofed client cannot pick its bucket)", () => {
    const out = resolve({ peer: "203.0.113.9", headers: xff("198.51.100.77") }, trust);
    expect(out).toEqual({ address: "203.0.113.9", shared: false });
  });

  it("uses the rightmost entry that is not a trusted proxy, not the spoofable leftmost", () => {
    const out = resolve({ peer: "127.0.0.1", headers: xff("6.6.6.6, 198.51.100.4") }, trust);
    expect(out).toEqual({ address: "198.51.100.4", shared: false });
  });

  it("walks through trusted intermediate hops, from the right", () => {
    const out = resolve({ peer: "127.0.0.1", headers: xff("6.6.6.6, 198.51.100.4, 10.1.2.3, 10.9.9.9") }, trust);
    expect(out.address).toBe("198.51.100.4");
  });

  it("takes the leftmost entry when every hop is a trusted proxy, and calls it shared", () => {
    const out = resolve({ peer: "127.0.0.1", headers: xff("10.0.0.2, 10.0.0.3") }, trust);
    expect(out).toEqual({ address: "10.0.0.2", shared: true });
  });

  it("falls back to the peer with no header", () => {
    expect(resolve({ peer: "10.0.0.5" }, trust)).toEqual({ address: "10.0.0.5", shared: true });
  });

  it("stops at an unreadable entry, believing nothing to its left", () => {
    const out = resolve({ peer: "127.0.0.1", headers: xff("198.51.100.4, not-an-ip, 10.0.0.3") }, trust);
    expect(out.address).toBe("10.0.0.3"); // the nearest trusted hop
    expect(resolve({ peer: "127.0.0.1", headers: xff("198.51.100.4, garbage") }, trust).address).toBe("127.0.0.1");
    expect(resolve({ peer: "127.0.0.1", headers: xff("198.51.100.4,,") }, trust).address).toBe("127.0.0.1");
  });

  it("does not let a malformed entry hide a valid untrusted one to its right", () => {
    expect(resolve({ peer: "127.0.0.1", headers: xff("garbage, 198.51.100.4") }, trust).address).toBe("198.51.100.4");
  });

  it("strips a port from IPv4 and bracketed IPv6 entries", () => {
    expect(resolve({ peer: "127.0.0.1", headers: xff("198.51.100.4:5678") }, trust).address).toBe("198.51.100.4");
    expect(resolve({ peer: "127.0.0.1", headers: xff("[2001:db8::1]:443") }, trust).address).toBe("2001:db8::1");
    expect(resolve({ peer: "127.0.0.1", headers: xff("[2001:DB8::1]") }, trust).address).toBe("2001:db8::1");
    expect(resolve({ peer: "127.0.0.1", headers: xff("2001:db8::1") }, trust).address).toBe("2001:db8::1");
    expect(resolve({ peer: "127.0.0.1", headers: xff("198.51.100.4:") }, trust).address).toBe("127.0.0.1");
  });

  it("calls a resolved address that is itself a trusted proxy shared, and a loopback one too", () => {
    expect(resolve({ peer: "127.0.0.1", headers: xff("127.0.0.2") }, { trustedProxies: ["127.0.0.1"] })).toEqual({ address: "127.0.0.2", shared: true });
  });

  it("matches a v4-mapped peer against a v4 CIDR, and v6 peers against v6 CIDRs", () => {
    expect(resolve({ peer: "::ffff:10.1.2.3", headers: xff("198.51.100.4") }, trust).address).toBe("198.51.100.4");
    const v6 = { trustedProxies: ["2001:db8:aa::/48"] };
    expect(resolve({ peer: "2001:db8:aa:1::5", headers: xff("198.51.100.4") }, v6).address).toBe("198.51.100.4");
    expect(resolve({ peer: "2001:db8:bb::5", headers: xff("198.51.100.4") }, v6).address).toBe("2001:db8:bb::5");
  });

  it("accepts a mapped-form entry as the v4 address it stands for", () => {
    expect(resolve({ peer: "10.1.2.3", headers: xff("198.51.100.4") }, { trustedProxies: ["::ffff:10.1.2.3"] }).address).toBe("198.51.100.4");
  });

  it("ignores a list entry that does not parse (fewer proxies is the safe side)", () => {
    const out = resolve({ peer: "127.0.0.1", headers: xff("198.51.100.4") }, { trustedProxies: ["nonsense", "10.0.0.0/99"] });
    expect(out.address).toBe("127.0.0.1");
  });
});

describe("clientIpHeader", () => {
  const trust = { trustedProxies: ["127.0.0.1"], clientIpHeader: "CF-Connecting-IP" };

  it("is used from a trusted peer, and X-Forwarded-For is then ignored", () => {
    const out = resolve({ peer: "127.0.0.1", headers: { "cf-connecting-ip": "198.51.100.4", ...xff("6.6.6.6") } }, trust);
    expect(out).toEqual({ address: "198.51.100.4", shared: false });
  });

  it("is ignored from an untrusted peer", () => {
    const out = resolve({ peer: "203.0.113.9", headers: { "cf-connecting-ip": "198.51.100.4" } }, trust);
    expect(out.address).toBe("203.0.113.9");
  });

  it("treats a repeated header, a comma list, junk or a missing header as absent: the peer", () => {
    const peer = "127.0.0.1";
    const repeated = resolve({ peer, headers: { "cf-connecting-ip": "198.51.100.4, 198.51.100.5" }, raw: [["cf-connecting-ip", "198.51.100.4"], ["CF-Connecting-IP", "198.51.100.5"]] }, trust);
    expect(repeated.address).toBe(peer);
    expect(resolve({ peer, headers: { "cf-connecting-ip": "198.51.100.4, 198.51.100.5" } }, trust).address).toBe(peer);
    expect(resolve({ peer, headers: { "cf-connecting-ip": "banana" } }, trust).address).toBe(peer);
    expect(resolve({ peer, headers: xff("198.51.100.4") }, trust).address).toBe(peer);
  });

  it("falls back to the peer, which is shared when it is the proxy", () => {
    expect(resolve({ peer: "127.0.0.1" }, trust)).toEqual({ address: "127.0.0.1", shared: true });
  });
});

describe("live config", () => {
  it("follows a changed trust list on the next request", () => {
    const sent = { peer: "10.0.0.5", headers: xff("198.51.100.4") };
    expect(resolve(sent, { trustedProxies: [] }).address).toBe("10.0.0.5");
    expect(resolve(sent, { trustedProxies: ["10.0.0.0/8"] }).address).toBe("198.51.100.4");
    expect(resolve(sent, { trustedProxies: [] }).address).toBe("10.0.0.5");
  });
});
