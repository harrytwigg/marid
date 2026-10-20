import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The ssh hop is replaced by running the command locally under `sh -c`, with the script on stdin as ssh would deliver it. */
let sshExit: number | null = 0;
let remoteHome: string;

vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    sshRun: async (_destination: string, args: string[], opts: { stdin?: string } = {}) => {
      if (sshExit !== 0) return { code: sshExit, stdout: "", stderr: "ssh: connect to host build-box port 22: No route to host" };
      const run = spawnSync("sh", ["-c", args[0]], { input: opts.stdin, encoding: "utf8", env: { ...process.env, HOME: remoteHome } });
      return { code: run.status, stdout: run.stdout, stderr: run.stderr };
    },
  };
});

import { parseRemoteChatListing, remoteChatSource, remoteSignedIn } from "../freebuff-remote.js";

describe.skipIf(process.platform === "win32")("remote Freebuff host", () => {
  beforeEach(() => {
    sshExit = 0;
    remoteHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fb-remote-")));
  });
  afterEach(() => fs.rmSync(remoteHome, { recursive: true, force: true }));

  const chat = (project: string, chatId: string, meta?: unknown) => {
    const dir = path.join(remoteHome, ".config", "manicode", "projects", project, "chats", chatId);
    fs.mkdirSync(dir, { recursive: true });
    if (meta !== undefined) fs.writeFileSync(path.join(dir, "chat-meta.json"), JSON.stringify(meta, null, 2));
  };
  const target = { remoteHost: "build-box", remoteCwd: "/work" };

  it("lists every chat on the host with its meta, one line each, even when the meta spans lines", async () => {
    chat("work", "2026-10-20T15-00-00.000Z", { messageCount: 3, firstPrompt: "hello\twith a tab", messagesSize: 9 });
    chat("other", "2026-10-20T15-01-00.000Z");
    const chats = await remoteChatSource(target, "s1").list();
    expect(chats.map((c) => `${c.project}/${c.chatId}`).sort()).toEqual(["other/2026-10-20T15-01-00.000Z", "work/2026-10-20T15-00-00.000Z"]);
    expect(chats.find((c) => c.project === "work")?.meta).toMatchObject({ messageCount: 3, firstPrompt: "hello\twith a tab" });
    expect(chats.find((c) => c.project === "other")?.meta).toBeUndefined();
  });

  it("lists nothing on a host Freebuff has never run on", async () => {
    expect(await remoteChatSource(target, "s1").list()).toEqual([]);
  });

  it("reports an unreachable host as an error, not as no chats", async () => {
    sshExit = 255;
    await expect(remoteChatSource(target, "s1").list()).rejects.toThrow(/could not list Freebuff chats/);
  });

  it("knows whether Freebuff is signed in there, and says nothing when it cannot ask", async () => {
    expect(await remoteSignedIn("build-box")).toBe(false);
    fs.mkdirSync(path.join(remoteHome, ".config", "manicode"), { recursive: true });
    fs.writeFileSync(path.join(remoteHome, ".config", "manicode", "credentials.json"), "{}");
    expect(await remoteSignedIn("build-box")).toBe(true);
    sshExit = 255;
    expect(await remoteSignedIn("build-box")).toBeUndefined();
  });
});

describe("parseRemoteChatListing", () => {
  it("skips lines that are not a listing and a meta that was cut off mid-write", () => {
    const out = parseRemoteChatListing(`work\tc1\t{"firstPrompt":"x"}\nnoise\nwork\tc2\t{"firstPro\nwork\tc3\t\n`);
    expect(out).toEqual([
      { project: "work", chatId: "c1", meta: { firstPrompt: "x" } },
      { project: "work", chatId: "c2" },
      { project: "work", chatId: "c3" },
    ]);
  });
});
