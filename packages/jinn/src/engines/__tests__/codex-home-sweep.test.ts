import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepOrphanCodexSessionHomes, startCodexSessionHomeSweeps } from "../codex.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Regression for the codex-home disk leak: per-session CODEX_HOME overlays are
 * removed on session teardown, but overlays whose session record is gone
 * accumulated forever (276 dirs / 2.4GB observed). The startup sweep must delete
 * exactly the orphans — overlays not backed by a known session — while keeping
 * live-session overlays and the shared caches.
 *
 * A later change widened that to an age rule: `config.toml` is rewritten on every turn,
 * so its mtime is an exact DB-free last-activity stamp. An overlay idle past the
 * window goes even if its session row survives; one still warm stays even if the
 * row is gone. The keep-list only decides overlays with no stamp at all.
 */
describe("sweepOrphanCodexSessionHomes", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-sweep-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const mkdir = (name: string) => fs.mkdirSync(path.join(base, name), { recursive: true });
  const exists = (name: string) => fs.existsSync(path.join(base, name));

  /** An overlay whose last turn was `idleDays` ago, per its config.toml mtime. */
  const mkOverlay = (name: string, idleDays: number) => {
    mkdir(name);
    const cfg = path.join(base, name, "config.toml");
    fs.writeFileSync(cfg, "[mcp_servers.jinn]\n");
    const stamp = new Date(Date.now() - idleDays * DAY_MS);
    fs.utimesSync(cfg, stamp, stamp);
  };

  it("removes overlays with no matching session and keeps the rest", () => {
    const live = "11111111-1111-1111-1111-111111111111";
    const orphanA = "22222222-2222-2222-2222-222222222222";
    const orphanB = "33333333-3333-3333-3333-333333333333";
    mkdir(live);
    mkdir(orphanA);
    mkdir(orphanB);
    // shared caches and dot-dirs must never be swept
    mkdir("cache");
    mkdir("skills");
    mkdir(".shared");

    const removed = sweepOrphanCodexSessionHomes([live], base);

    expect(removed).toBe(2);
    expect(exists(live)).toBe(true);
    expect(exists(orphanA)).toBe(false);
    expect(exists(orphanB)).toBe(false);
    expect(exists("cache")).toBe(true);
    expect(exists("skills")).toBe(true);
    expect(exists(".shared")).toBe(true);
  });

  it("is a no-op when the base dir does not exist", () => {
    const missing = path.join(base, "does-not-exist");
    expect(sweepOrphanCodexSessionHomes(["x"], missing)).toBe(0);
  });

  it("keeps every overlay when all are backed by known sessions", () => {
    const ids = ["aaaaaaaa-1111", "bbbbbbbb-2222"];
    ids.forEach(mkdir);
    expect(sweepOrphanCodexSessionHomes(ids, base)).toBe(0);
    ids.forEach((id) => expect(exists(id)).toBe(true));
  });

  // The ids below reach the sweep only through listAllSessionIds — listSessions
  // filters archived and workflow-phase rows out, so before that change every boot
  // reaped their overlays and killed codex-native resume for them.
  it("keeps a warm workflow-phase overlay", () => {
    mkOverlay("workflow-phase-session", 0);
    expect(sweepOrphanCodexSessionHomes(["workflow-phase-session"], base)).toBe(0);
    expect(exists("workflow-phase-session")).toBe(true);
  });

  it("keeps a warm archived overlay", () => {
    mkOverlay("archived-session", 0);
    expect(sweepOrphanCodexSessionHomes(["archived-session"], base)).toBe(0);
    expect(exists("archived-session")).toBe(true);
  });

  it("reaps an overlay idle past the window even when its session row survives", () => {
    mkOverlay("idle-15d", 15);
    mkOverlay("active-1d", 1);

    expect(sweepOrphanCodexSessionHomes(["idle-15d", "active-1d"], base)).toBe(1);
    expect(exists("idle-15d")).toBe(false);
    expect(exists("active-1d")).toBe(true);
  });

  it("keeps an overlay inside the window even when its session row is gone", () => {
    mkOverlay("recent-13d", 13);

    expect(sweepOrphanCodexSessionHomes([], base)).toBe(0);
    expect(exists("recent-13d")).toBe(true);
  });

  it("falls back to the keep-list for an overlay with no config.toml", () => {
    mkdir("half-written-known");
    mkdir("half-written-unknown");

    expect(sweepOrphanCodexSessionHomes(["half-written-known"], base)).toBe(1);
    expect(exists("half-written-known")).toBe(true);
    expect(exists("half-written-unknown")).toBe(false);
  });

  it("never reaps shared caches or dot-entries, however old", () => {
    const sharedDirs = ["plugins", "cache", "skills", "vendor_imports", ".tmp"];
    for (const name of sharedDirs) mkOverlay(name, 400);
    mkOverlay(".shared", 400);
    const sharedFile = path.join(base, "models_cache.json");
    fs.writeFileSync(sharedFile, "{}");
    const ancient = new Date(Date.now() - 400 * DAY_MS);
    fs.utimesSync(sharedFile, ancient, ancient);

    expect(sweepOrphanCodexSessionHomes([], base)).toBe(0);
    for (const name of [...sharedDirs, ".shared", "models_cache.json"]) {
      expect(exists(name)).toBe(true);
    }
  });
});

describe("startCodexSessionHomeSweeps", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-sweeper-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const mkdir = (name: string) => fs.mkdirSync(path.join(base, name), { recursive: true });
  const exists = (name: string) => fs.existsSync(path.join(base, name));

  it("sweeps immediately and again a day later, re-reading the session ids each run", () => {
    vi.useFakeTimers();
    let sessionIds = ["live"];
    mkdir("live");
    mkdir("gone");

    const timer = startCodexSessionHomeSweeps({ listSessionIds: () => sessionIds, baseDir: base });

    expect(exists("gone")).toBe(false); // the first sweep ran synchronously
    expect(exists("live")).toBe(true);

    // A session that appeared after the first run must be honoured by the next one,
    // and one that vanished must stop being honoured.
    sessionIds = ["created-later"];
    mkdir("created-later");

    vi.advanceTimersByTime(DAY_MS);

    expect(exists("created-later")).toBe(true);
    expect(exists("live")).toBe(false);
    clearInterval(timer);
  });

  it("leaves its timer unref'd so it never holds the process open", () => {
    const timer = startCodexSessionHomeSweeps({ listSessionIds: () => [], baseDir: base });
    expect(timer.hasRef()).toBe(false);
    clearInterval(timer);
  });
});
