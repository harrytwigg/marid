import { describe, expect, it } from "vitest";
import { classifyOpencodeFailure, isOpencodeRefusal } from "../opencode-failure.js";

/** opencode's `{type, message, status}` as both transports put it into a turn's error text. */

describe("classifyOpencodeFailure", () => {
  it.each([
    ["provider.quota: Insufficient account funds (HTTP 402)", { kind: "quota", type: "provider.quota", status: 402 }],
    ["provider.quota: Insufficient balance. Top up at https://opencode.ai/console/wrk_1/billing?credits=1. (HTTP 402)", { kind: "quota", type: "provider.quota", status: 402 }],
    ["Error: provider.quota: Insufficient account funds (HTTP 402)", { kind: "quota", type: "provider.quota", status: 402 }],
    ["provider.quota: Go usage limit exceeded (HTTP 429)", { kind: "usage-limit", type: "provider.quota", status: 429 }],
    ["provider.rate-limit: Too many requests", { kind: "usage-limit", type: "provider.rate-limit" }],
    ["provider.auth: This API key has expired. Create a new API key in OpenCode Console. (HTTP 401)", { kind: "auth", type: "provider.auth", status: 401 }],
    ["provider.auth: Upstream request failed: Model access is disabled (HTTP 403)", { kind: "model-access", type: "provider.auth", status: 403 }],
    ["provider.auth: DeepSeek models require region opt-in", { kind: "model-access", type: "provider.auth" }],
    ["provider.auth: Invalid API key", { kind: "auth", type: "provider.auth" }],
  ])("reads %s", (text, expected) => {
    expect(classifyOpencodeFailure(text)).toEqual(expected);
  });

  it("reads a region refusal by its name, typed or not", () => {
    expect(classifyOpencodeFailure("RegionError: this model is not available in your region")).toEqual({ kind: "model-access" });
    expect(classifyOpencodeFailure("provider.auth: RegionError (HTTP 403)")).toMatchObject({ kind: "model-access", status: 403 });
  });

  it("takes the status that ends the text, not a number inside the message", () => {
    expect(classifyOpencodeFailure("provider.quota: workspace wrk_402 has insufficient funds (HTTP 402)")?.status).toBe(402);
  });

  it("leaves text with no provider type to the prose classifier, even with a status in it", () => {
    for (const text of ["HTTP 401 from the mcp server", "Insufficient balance (HTTP 402)", "something went wrong", "", undefined, null]) {
      expect(classifyOpencodeFailure(text)).toBeUndefined();
    }
  });

  it("does not classify a provider error that is none of the four", () => {
    expect(classifyOpencodeFailure("provider.no-route: no route for model (HTTP 404)")).toBeUndefined();
    expect(classifyOpencodeFailure("provider.auth: something unexpected")).toBeUndefined();
  });
});

describe("isOpencodeRefusal", () => {
  it("is a dead key or a model the account cannot use, and nothing else", () => {
    expect(isOpencodeRefusal("provider.auth: This API key has expired (HTTP 401)")).toBe(true);
    expect(isOpencodeRefusal("provider.auth: Model access is disabled (HTTP 403)")).toBe(true);
    expect(isOpencodeRefusal("provider.quota: Insufficient account funds (HTTP 402)")).toBe(false);
    expect(isOpencodeRefusal("provider.quota: Go usage limit exceeded (HTTP 429)")).toBe(false);
  });
});
