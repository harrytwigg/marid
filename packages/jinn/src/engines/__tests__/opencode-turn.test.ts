import { describe, it, expect } from "vitest";

import { OpencodeTurn } from "../opencode-turn.js";
import { v2ErrorLine } from "../opencode-v2-events.js";
import { detectRateLimit } from "../../shared/rateLimit.js";

/**
 * What an `error` line makes of a turn, whichever opencode printed it.
 *
 * 1.x prints `{name, data: {message}}`. OpenCode 2's `opencode run --format
 * json` prints `{type, message, status?}` — the shape its server events carry,
 * passed through unconverted, since a plain run does not go through
 * `v2ErrorLine`. A turn reading only the 1.x shape reported every OpenCode 2
 * failure as "no message".
 */

const SES = "ses_test0001";

function errorOf(...lines: unknown[]): string | undefined {
  const turn = new OpencodeTurn("");
  for (const line of lines) turn.readLine(typeof line === "string" ? line : JSON.stringify(line), null);
  return turn.result({ code: 1, terminationReason: null, stderr: "" }).error;
}

describe("OpencodeTurn — an `error` line", () => {
  it("reads OpenCode 2's plain-run error: its type and message", () => {
    // Printed verbatim by `opencode run --format json` on 2.0.32 for a model
    // the host cannot route to.
    const line = '{"type":"error","timestamp":1792322049258,"sessionID":"ses_test0001",'
      + '"error":{"type":"provider.no-route","message":"Model unavailable: opencode-go/deepseek-v4.1-flash"}}';

    expect(errorOf(line)).toBe("provider.no-route: Model unavailable: opencode-go/deepseek-v4.1-flash");
  });

  it("reads an interrupted OpenCode 2 step as the interrupt it was", () => {
    // The error both failed turns stored in opencode's own message store.
    expect(errorOf({ type: "error", sessionID: SES, error: { type: "aborted", message: "Step interrupted" } }))
      .toBe("aborted: Step interrupted");
  });

  it("says the same about an OpenCode 2 error on a plain run as on a server turn", () => {
    expect(errorOf({ type: "error", sessionID: SES, error: { type: "provider.server", message: "Upstream unavailable", status: 502 } }))
      .toBe("provider.server: Upstream unavailable (HTTP 502)");
  });

  it.each([
    ["type, message and status", { type: "provider.server", message: "Upstream unavailable", status: 502 }],
    ["type only", { type: "provider.server" }],
    ["message only", { message: "Upstream unavailable" }],
    ["status without a message", { type: "provider.server", status: 503 }],
  ])("reads an OpenCode 2 error with %s the way a server turn does", (_shape, error) => {
    // The server path converts each v2 error with v2ErrorLine; a plain run
    // prints it raw. One failure must not read two ways.
    expect(errorOf({ type: "error", sessionID: SES, error })).toBe(errorOf(v2ErrorLine(SES, error)));
  });

  it("marks an OpenCode 2 rate limit on a plain run as one", () => {
    const turn = new OpencodeTurn("");
    turn.readLine(JSON.stringify({
      type: "error",
      sessionID: SES,
      error: { type: "provider.rate-limit", message: "Too many requests", status: 429 },
    }), null);

    expect(detectRateLimit(turn.result({ code: 1, terminationReason: null, stderr: "" })).limited).toBe(true);
  });

  it("keeps reading 1.x's shape", () => {
    expect(errorOf({ type: "error", sessionID: SES, error: { name: "APIError", data: { message: "Bad Request" } } }))
      .toBe("APIError: Bad Request");
  });

  it("reads an error that is only a string", () => {
    expect(errorOf({ type: "error", sessionID: SES, error: "socket hang up" })).toBe("socket hang up");
  });

  it("carries the raw error when it has no name and no message", () => {
    const error = errorOf({ type: "error", sessionID: SES, error: { code: "E_GONE", detail: { retryable: false } } });

    expect(error).not.toBe("opencode reported an error with no message");
    expect(error).toBe('opencode reported an error with no message: {"code":"E_GONE","detail":{"retryable":false}}');
  });

  it("carries the rest of the event when it has no error field", () => {
    expect(errorOf({ type: "error", sessionID: SES, timestamp: 1, reason: "stream closed" }))
      .toBe('opencode reported an error with no message: {"reason":"stream closed"}');
  });

  it("says so in words when the event is only its envelope", () => {
    expect(errorOf({ type: "error", sessionID: SES, timestamp: 1 }))
      .toBe("opencode reported an error with no message and nothing else in its event");
  });

  it("does not read a 429 in the envelope's timestamp or session id as a rate limit", () => {
    // Quoting them would hand their digits to failure classification, which
    // matches a bare 429 anywhere in the text.
    const turn = new OpencodeTurn("");
    turn.readLine(JSON.stringify({ type: "error", sessionID: "ses_2b7c8f3a9ffe429", timestamp: 1792322429001 }), null);
    const result = turn.result({ code: 1, terminationReason: null, stderr: "" });

    expect(result.error).not.toContain("429");
    expect(detectRateLimit(result).limited).toBe(false);
  });

  it("caps a raw error so one huge event cannot flood the log", () => {
    const error = errorOf({ type: "error", sessionID: SES, error: { blob: "x".repeat(5000) } })!;

    expect(error.length).toBeLessThan(700);
    expect(error.endsWith("…")).toBe(true);
  });
});
