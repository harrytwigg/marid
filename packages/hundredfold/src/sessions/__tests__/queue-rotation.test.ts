import { describe, expect, it } from "vitest";
import { rotatePendingToFront } from "../queue-rotation.js";

const items = (...ids: string[]) => ids.map((id) => ({ id }));

describe("rotatePendingToFront", () => {
  it("moves the third of three to the head and keeps the other two in order", () => {
    expect(rotatePendingToFront(items("a", "b", "c"), "c")).toEqual(items("c", "a", "b"));
  });

  it("moves the middle one up without disturbing the pair around it", () => {
    expect(rotatePendingToFront(items("a", "b", "c"), "b")).toEqual(items("b", "a", "c"));
  });

  it("is a no-op on the head", () => {
    expect(rotatePendingToFront(items("a", "b", "c"), "a")).toEqual(items("a", "b", "c"));
  });

  it("is a no-op on a single-item queue", () => {
    expect(rotatePendingToFront(items("a"), "a")).toEqual(items("a"));
  });

  it("leaves the queue alone when the target is not in it", () => {
    expect(rotatePendingToFront(items("a", "b"), "gone")).toEqual(items("a", "b"));
  });

  it("does not mutate its input", () => {
    const original = items("a", "b", "c");
    rotatePendingToFront(original, "c");
    expect(original).toEqual(items("a", "b", "c"));
  });
});
