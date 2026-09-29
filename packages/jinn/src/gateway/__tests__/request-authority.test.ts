import { describe, expect, it } from "vitest";
import { originMatchesAuthority, parseAuthority, parseRequestAuthority, singleRequestHeader } from "../request-authority.js";

describe("parseRequestAuthority", () => {
  it("reads one well-formed Host, noting whether it named a port", () => {
    expect(parseRequestAuthority({ headers: { host: "127.0.0.1:7777" } })).toEqual({ hostname: "127.0.0.1", port: 7777, explicitPort: true });
    expect(parseRequestAuthority({ headers: { host: "Jinn.Example.com" } })).toEqual({ hostname: "jinn.example.com", port: 80, explicitPort: false });
    expect(parseRequestAuthority({ headers: { host: "[::1]:7777" } })).toEqual({ hostname: "::1", port: 7777, explicitPort: true });
  });

  it("refuses a missing, repeated or malformed Host", () => {
    expect(parseRequestAuthority({ headers: {} })).toBeUndefined();
    expect(parseRequestAuthority({ headers: {}, rawHeaders: ["Host", "a.test", "Host", "b.test"] })).toBeUndefined();
    for (const raw of ["user@a.test", "a.test/x", "a.test:0", "a.test:65536", ".a.test", "a..test", "a.test,b.test", " a.test", "a.test\\x"]) {
      expect(parseAuthority(raw), raw).toBeUndefined();
    }
  });

  it("prefers rawHeaders, so a repeated header is seen as repeated", () => {
    expect(singleRequestHeader({ headers: { origin: "http://a.test" }, rawHeaders: ["Origin", "http://a.test", "origin", "http://b.test"] }, "origin")).toBeUndefined();
  });
});

describe("originMatchesAuthority", () => {
  const loopback = parseAuthority("127.0.0.1:7777")!;
  const bare = parseAuthority("jinn.example.com")!;

  it("admits only plain http by default, as the loopback same-origin trust needs", () => {
    expect(originMatchesAuthority("http://127.0.0.1:7777", loopback)).toBe(true);
    expect(originMatchesAuthority("https://127.0.0.1:7777", loopback)).toBe(false);
    expect(originMatchesAuthority("http://jinn.example.com", bare)).toBe(true);
    expect(originMatchesAuthority("https://jinn.example.com", bare)).toBe(false);
  });

  it("reads a portless Host as the origin scheme's default port when https is admitted", () => {
    const schemes = ["http:", "https:"] as const;
    expect(originMatchesAuthority("https://jinn.example.com", bare, { schemes })).toBe(true);
    expect(originMatchesAuthority("https://jinn.example.com", parseAuthority("jinn.example.com:443")!, { schemes })).toBe(true);
    expect(originMatchesAuthority("https://jinn.example.com", parseAuthority("jinn.example.com:80")!, { schemes })).toBe(false);
    expect(originMatchesAuthority("https://jinn.example.com:8443", bare, { schemes })).toBe(false);
  });

  it("refuses a different host, port, credentials or an opaque origin", () => {
    expect(originMatchesAuthority("http://127.0.0.1:8080", loopback)).toBe(false);
    expect(originMatchesAuthority("http://localhost:7777", loopback)).toBe(false);
    expect(originMatchesAuthority("http://u:p@127.0.0.1:7777", loopback)).toBe(false);
    expect(originMatchesAuthority("null", loopback)).toBe(false);
  });
});
