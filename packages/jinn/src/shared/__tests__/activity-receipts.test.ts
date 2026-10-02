import { describe, expect, it } from "vitest";
import { extractActivityReceiptId } from "../activity-receipts.js";
import type { GatewayEmit } from "../gateway-events.js";

// PLA-60 compile lock: widening `GatewayEmit` back to (string, unknown) leaves
// the expect-error directives below unsatisfied, which fails `tsc --noEmit`.
describe("GatewayEmit", () => {
  it("rejects an unknown event name and a wrong payload shape", () => {
    const emit = (() => {}) as GatewayEmit;
    // @ts-expect-error - not a member of GatewayEventMap
    emit("session:not-a-real-event", {});
    // @ts-expect-error - session:started carries { sessionId: string }
    emit("session:started", { sessionId: 1 });
    expect(typeof emit).toBe("function");
  });
});

describe("extractActivityReceiptId", () => {
  it("accepts only a bounded exact top-level JSON property from a successful result", () => {
    expect(extractActivityReceiptId('{"activityReceiptId":"todo:wi_release"}'))
      .toBe("todo:wi_release");
    expect(extractActivityReceiptId({ activityReceiptId: "todo:wi_release_2" }))
      .toBe("todo:wi_release_2");

    expect(extractActivityReceiptId('prefix {"activityReceiptId":"todo:forged"}'))
      .toBeUndefined();
    expect(extractActivityReceiptId({ nested: { activityReceiptId: "todo:forged" } }))
      .toBeUndefined();
    expect(extractActivityReceiptId({ activityReceiptId: "x".repeat(97) }))
      .toBeUndefined();
  });

  it("never extracts a receipt from an error result", () => {
    expect(extractActivityReceiptId(
      '{"activityReceiptId":"todo:wi_release"}',
      { isError: true },
    )).toBeUndefined();
  });
});
