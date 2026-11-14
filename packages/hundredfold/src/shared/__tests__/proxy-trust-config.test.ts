import { describe, expect, it } from "vitest";
import { validateConfigShape } from "../config.js";
import { normaliseIp, parseTrustEntry, proxyTrustProblems } from "../proxy-trust-config.js";

const problems = (gateway: Record<string, unknown>) => validateConfigShape({ gateway, engines: { claude: {} } });

describe("gateway.trustedProxies and gateway.clientIpHeader", () => {
  it("accept IPv4 and IPv6 addresses and CIDR ranges, and unset keys", () => {
    expect(problems({ trustedProxies: ["127.0.0.1", "::1", "10.0.0.0/8", "2001:db8::/32", "::ffff:10.0.0.1"], clientIpHeader: "cf-connecting-ip" })).toEqual([]);
    expect(problems({})).toEqual([]);
    expect(problems({ trustedProxies: [] })).toEqual([]);
  });

  it("name an entry that is not an IP or CIDR", () => {
    const out = problems({ trustedProxies: ["10.0.0.0/8", "proxy.example.test", "10.0.0.0/33", "2001:db8::/129", "1.2.3.4/x", "fe80::1%eth0", 5, ""] });
    expect(out).toHaveLength(6 + 1 + 0);
    for (const bad of ["proxy.example.test", "10.0.0.0/33", "2001:db8::/129", "1.2.3.4/x", "fe80::1%eth0", "5", '""']) {
      expect(out.some((p) => p.includes(bad))).toBe(true);
    }
    expect(out.every((p) => p.startsWith("gateway.trustedProxies entry"))).toBe(true);
  });

  it("reject a wrong type", () => {
    expect(problems({ trustedProxies: "127.0.0.1" })).toEqual(["gateway.trustedProxies must be a list of IP addresses or CIDR ranges (got string)"]);
    expect(problems({ clientIpHeader: 7 })[0]).toMatch(/gateway.clientIpHeader must be a single HTTP header name/);
    expect(problems({ clientIpHeader: "x-real-ip, x-other" })[0]).toMatch(/gateway.clientIpHeader/);
    expect(proxyTrustProblems({ clientIpHeader: "" })).toHaveLength(1);
  });
});

describe("normaliseIp / parseTrustEntry", () => {
  it("canonicalises spellings of one address", () => {
    expect(normaliseIp("::FFFF:1.2.3.4")).toBe("1.2.3.4");
    expect(normaliseIp("::ffff:102:304")).toBe("1.2.3.4");
    expect(normaliseIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normaliseIp("1.2.3")).toBeUndefined();
    expect(normaliseIp("1.2.3.4:80")).toBeUndefined();
  });

  it("gives a single address its full prefix and maps a mapped subnet to IPv4", () => {
    expect(parseTrustEntry("10.0.0.1")).toEqual({ address: "10.0.0.1", family: "ipv4", prefix: 32 });
    expect(parseTrustEntry("::1")).toEqual({ address: "::1", family: "ipv6", prefix: 128 });
    expect(parseTrustEntry("::ffff:10.0.0.0/104")).toEqual({ address: "10.0.0.0", family: "ipv4", prefix: 8 });
    expect(parseTrustEntry("::ffff:10.0.0.0/64")).toBeUndefined();
  });
});
