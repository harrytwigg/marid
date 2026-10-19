import { describe, expect, it } from "vitest";
import { renderSpawnPrompt, renderTemplate } from "../template.js";
import { basePayload, hookPayload } from "./fixtures.js";

describe("renderTemplate", () => {
  it("replaces dotted paths with the payload value", () => {
    const payload = hookPayload({ actor: { raw: "session:s1", kind: "employee", employee: "merger" }, prUrl: "https://github.com/o/r/pull/1" });
    expect(renderTemplate("{{todo.id}} moved {{from}} -> {{to}} by {{actor.employee}}; merge {{prUrl}}", payload))
      .toBe("PLA-12 moved executing -> in_review by merger; merge https://github.com/o/r/pull/1");
    expect(renderTemplate("{{ todo.title }}", payload)).toBe("Ship it");
  });

  it("renders a missing path, a null and an undefined value as an empty string", () => {
    const payload = hookPayload({ text: null });
    expect(renderTemplate("[{{nope}}][{{todo.nope.deeper}}][{{text}}][{{actor.employee}}]", payload)).toBe("[][][][]");
  });

  it("renders objects and arrays as JSON, and {{payload}} as the whole payload", () => {
    const payload = hookPayload();
    expect(renderTemplate("{{todo.labels}}", payload)).toBe('["auto-merge"]');
    expect(renderTemplate("{{actor}}", payload)).toBe('{"raw":"operator","kind":"operator"}');
    expect(JSON.parse(renderTemplate("{{payload}}", payload))).toEqual(payload);
  });

  it("has no logic: braces that are not a path are left alone", () => {
    expect(renderTemplate("{{#if x}} {single} {{ }}", hookPayload())).toBe("{{#if x}} {single} {{ }}");
  });
});

describe("renderSpawnPrompt", () => {
  it("always ends with the full payload in a fenced json block", () => {
    const payload = hookPayload();
    const prompt = renderSpawnPrompt("Merge {{prUrl}} now", payload);
    expect(prompt.startsWith("Merge  now\n\n```json\n")).toBe(true);
    const body = prompt.slice(prompt.indexOf("```json\n") + 8, prompt.lastIndexOf("\n```"));
    expect(JSON.parse(body)).toEqual(payload);
    expect(prompt.endsWith("\n```")).toBe(true);
  });

  it("uses a default that names the hook and the event when there is no prompt", () => {
    const prompt = renderSpawnPrompt(undefined, hookPayload());
    expect(prompt).toContain('Board hook "review-merge" fired on todo.status_changed for PLA-12: Ship it.');
    expect(renderSpawnPrompt("   ", hookPayload())).toContain('Board hook "review-merge"');
  });

  it("fences with more backticks than the payload contains, so a comment cannot close it", () => {
    const payload = hookPayload({ text: "look: ```code``` and ````four````" });
    const prompt = renderSpawnPrompt("x", payload);
    expect(prompt).toContain("\n`````json\n");
    expect(prompt.endsWith("\n`````")).toBe(true);
    expect(basePayload().text).toBeNull();
  });
});
