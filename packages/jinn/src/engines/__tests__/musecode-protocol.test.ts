import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MUSECODE_EFFORT_LEVELS, MUSECODE_EFFORT_VOCABULARY } from "../../shared/musecode-effort.js";
import { allowingChoiceId, buildMuseServeArgs, buildMusecodePrompt, describeMusecodeLaunch, museReasoningEffort } from "../musecode-protocol.js";
import { buildOpencodePrompt } from "../opencode-protocol.js";
import { MAX_IMAGE_BYTES, loadMuseAttachments } from "../musecode-attachments.js";

describe("buildMuseServeArgs", () => {
  it("carries the base flags, then the model, then the operator's own flags", () => {
    expect(buildMuseServeArgs({})).toEqual([
      "serve", "--disable-sandbox", "--trust-workspace",
      "-c", "context.foreign_personal_rules=false",
      "-c", "context.foreign_personal_skills=false",
    ]);
    expect(buildMuseServeArgs({ model: "muse-spark-1.2", cliFlags: ["--provider", "echo"] }).slice(-4)).toEqual(["--model", "muse-spark-1.2", "--provider", "echo"]);
  });

  it("never puts the prompt on the command line", () => {
    expect(buildMuseServeArgs({ model: "m", cliFlags: [] }).join(" ")).not.toContain("hello");
  });

  it("names the model for a log line", () => {
    expect(describeMusecodeLaunch({ model: "muse-spark-1.3" })).toBe("--model muse-spark-1.3");
    expect(describeMusecodeLaunch({})).toBe("--model (muse default)");
  });
});

describe("museReasoningEffort", () => {
  it("passes every tier of the vocabulary except none", () => {
    for (const level of MUSECODE_EFFORT_VOCABULARY) {
      expect(museReasoningEffort(level)).toBe(level === "none" ? undefined : level);
    }
  });

  it("drops an unset or unknown level", () => {
    expect(museReasoningEffort(undefined)).toBeUndefined();
    expect(museReasoningEffort("")).toBeUndefined();
    expect(museReasoningEffort("turbo")).toBeUndefined();
  });

  it("offers employees minimal through max, all of which Muse accepts", () => {
    expect([...MUSECODE_EFFORT_LEVELS]).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const level of MUSECODE_EFFORT_LEVELS) expect(museReasoningEffort(level)).toBe(level);
  });
});

describe("buildMusecodePrompt", () => {
  it("is opencode's prompt: the system prompt on a fresh session only, attachments named", () => {
    const fresh = { prompt: "do it", cwd: "/w", systemPrompt: "You are Marid.", attachments: ["/a.txt"] };
    expect(buildMusecodePrompt(fresh)).toBe("You are Marid.\n\n---\n\ndo it\n\nAttached files:\n- /a.txt");
    expect(buildMusecodePrompt(fresh)).toBe(buildOpencodePrompt(fresh));
    expect(buildMusecodePrompt({ ...fresh, resumeSessionId: "s" })).toBe("do it\n\nAttached files:\n- /a.txt");
  });
});

describe("allowingChoiceId", () => {
  const choice = (choiceId: string, decision: string, scope: string) => ({ choiceId, decision, scope, label: choiceId });

  it("prefers a one-off approval, then any approval for the session", () => {
    expect(allowingChoiceId([choice("n", "denied", "once"), choice("s", "approvedForSession", "session"), choice("o", "approved", "once")])).toBe("o");
    expect(allowingChoiceId([choice("n", "denied", "once"), choice("s", "approvedForSession", "session")])).toBe("s");
  });

  it("never picks a choice that amends policy, denies, or aborts", () => {
    expect(allowingChoiceId([choice("p", "approvedPolicyAmendment", "localPersistent"), choice("n", "denied", "once"), choice("a", "abort", "once")])).toBeUndefined();
  });

  it("copes with a choice list that is missing or malformed", () => {
    expect(allowingChoiceId(undefined)).toBeUndefined();
    expect(allowingChoiceId([null, "x", { decision: "approved" }])).toBeUndefined();
  });
});

describe("loadMuseAttachments", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-attach-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, bytes: Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };

  it("turns images into base64 parts with their media type, and leaves everything else to be named", () => {
    const png = write("a.PNG", Buffer.from("png-bytes"));
    const jpg = write("b.jpeg", Buffer.from("jpg-bytes"));
    const txt = write("c.txt", Buffer.from("text"));
    expect(loadMuseAttachments([png, txt, jpg])).toEqual({
      images: [
        { type: "image", base64Data: Buffer.from("png-bytes").toString("base64"), mediaType: "image/png" },
        { type: "image", base64Data: Buffer.from("jpg-bytes").toString("base64"), mediaType: "image/jpeg" },
      ],
      remaining: [txt],
    });
  });

  it("names an image that is empty, unreadable or too large instead of dropping it", () => {
    const empty = write("e.png", Buffer.alloc(0));
    const big = write("big.png", Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const missing = path.join(dir, "missing.gif");
    expect(loadMuseAttachments([empty, big, missing])).toEqual({ images: [], remaining: [empty, big, missing] });
  });

  it("is empty for no attachments", () => {
    expect(loadMuseAttachments(undefined)).toEqual({ images: [], remaining: [] });
  });
});
