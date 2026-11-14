import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "../server.js";
import { CORS_ALLOWED_REQUEST_HEADERS, CORS_EXPOSED_RESPONSE_HEADERS } from "../request-handler.js";

describe("CORS origin policy", () => {
  it("allows absent origins for same-origin requests and CLI/curl clients", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true);
  });

  it("allows loopback browser origins used by local dashboard/dev servers", () => {
    expect(isAllowedCorsOrigin("http://localhost:7777")).toBe(true);
    expect(isAllowedCorsOrigin("http://app.localhost:5173")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:7777")).toBe(true);
    expect(isAllowedCorsOrigin("http://0.0.0.0:7777")).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:7777")).toBe(true);
  });

  it("rejects arbitrary web origins instead of reflecting a wildcard", () => {
    expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("https://localhost.evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("file://localhost/tmp/x.html")).toBe(false);
    expect(isAllowedCorsOrigin("not a url")).toBe(false);
  });

  it("allows same-origin requests where the Origin host matches the request Host", () => {
    // Dashboard served by this same gateway over Tailscale/LAN: the browser's
    // Origin host equals the request's Host header, so it is genuinely same-origin.
    expect(
      isAllowedCorsOrigin(
        "https://operator-mac-mini.tail0b18b3.ts.net",
        "operator-mac-mini.tail0b18b3.ts.net",
      ),
    ).toBe(true);
    // LAN access by IP with an explicit port on the Host header.
    expect(isAllowedCorsOrigin("http://192.168.1.50:7777", "192.168.1.50:7777")).toBe(true);
  });

  it("still rejects cross-origin requests even when a Host header is present", () => {
    expect(
      isAllowedCorsOrigin("https://evil.example", "operator-mac-mini.tail0b18b3.ts.net"),
    ).toBe(false);
  });
});

describe("CORS header policy", () => {
  it("lets an allowed cross-origin caller both send and read the config revision", () => {
    // One without the other is the silent half-failure: a PUT the preflight
    // strips the revision from still saves, which is exactly the clobber the
    // revision exists to prevent.
    expect(CORS_ALLOWED_REQUEST_HEADERS).toContain("X-Hundredfold-Config-Revision");
    expect(CORS_EXPOSED_RESPONSE_HEADERS).toContain("X-Hundredfold-Config-Revision");
  });

  it("keeps the headers the gateway already accepted", () => {
    expect(CORS_ALLOWED_REQUEST_HEADERS).toContain("Content-Type");
    expect(CORS_ALLOWED_REQUEST_HEADERS).toContain("Authorization");
    expect(CORS_ALLOWED_REQUEST_HEADERS).toContain("X-Hundredfold-Bootstrap-Grant");
  });
});
