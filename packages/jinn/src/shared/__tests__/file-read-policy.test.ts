import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessFileRead, readLocalFileForIngestion } from "../file-read-policy.js";
import { protectedEntryCandidates } from "../protected-home-entries.js";

/**
 * the file-read policy, lifted out of the gateway so the MCP server
 * applies the same check to a file it reads on a remote host. The remote case
 * it must add: a session home that is a symlink farm over the gateway mount,
 * where `secrets/` is reachable by the mount's own path as well as by name.
 */
describe("shared file-read policy", () => {
  it("refuses a Jinn secret by the home's name for it AND by the directory it resolves to", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-policy-"));
    const mount = path.join(root, "mnt-jinn-home");
    fs.mkdirSync(path.join(mount, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(mount, "secrets", "api-keys.json"), "{}");
    const stage = path.join(root, "stage-home");
    fs.mkdirSync(stage);
    fs.symlinkSync(path.join(mount, "secrets"), path.join(stage, "secrets"));

    expect(assessFileRead(path.join(stage, "secrets", "api-keys.json"), { jinnHome: stage }).allowed).toBe(false);
    const viaMount = assessFileRead(path.join(mount, "secrets", "api-keys.json"), { jinnHome: stage });
    expect(viaMount).toEqual({ allowed: false, reason: "Refusing to read Jinn secrets" });
    expect(readLocalFileForIngestion(path.join(mount, "secrets", "api-keys.json"), 1024, { jinnHome: stage })).toMatchObject({ ok: false, status: 403 });

    const benign = path.join(mount, "notes.md");
    fs.writeFileSync(benign, "ok");
    expect(assessFileRead(benign, { jinnHome: stage }).allowed).toBe(true);
    expect(readLocalFileForIngestion(benign, 1024, { jinnHome: stage })).toMatchObject({ ok: true, realPath: fs.realpathSync.native(benign) });
  });

  it("refuses the instance home's credential and session-config files, on a remote stage and on the gateway (review B2)", () => {
    for (const label of ["stage", "gateway"]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `gen140-${label}-home-`));
      fs.mkdirSync(path.join(home, "tmp", "mcp", "sess"), { recursive: true });
      fs.mkdirSync(path.join(home, "tmp", "codex-homes", "sess"), { recursive: true });
      const refused = [
        "gateway.json", "auth-devices.json", "pairing-codes.json",
        "tmp/session-env.sh", "tmp/mcp.json", "tmp/settings.json", "tmp/opencode.json",
        "tmp/mcp/sess/config.json", "tmp/codex-homes/sess/config.toml",
      ];
      for (const rel of refused) {
        fs.writeFileSync(path.join(home, rel), "x");
        expect(assessFileRead(path.join(home, rel), { jinnHome: home }), `${label}:${rel}`).toEqual({
          allowed: false,
          reason: "Refusing to read Jinn credential or session-config files",
        });
      }
      // Ordinary scratch output in tmp/ stays attachable.
      fs.writeFileSync(path.join(home, "tmp", "evidence.log"), "ok");
      expect(assessFileRead(path.join(home, "tmp", "evidence.log"), { jinnHome: home }).allowed).toBe(true);
    }
  });

  it("protects every Jinn home a remote host can reach: its own stage, the gateway mount, sibling stages (review R1, R2)", () => {
    // The real layout: a mount, and a stage root whose session homes link most
    // entries into the mount but keep gateway.json and tmp/ as real files.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-farm-"));
    const mount = path.join(root, "mnt-jinn-home");
    const write = (p: string, body = "x") => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    for (const rel of [
      ".jinn-mount-sentinel", "secrets/api-keys.json", "gateway.json", "config.yaml", "config.yaml.pre-gen133", "auth-devices.json",
      "tmp/mcp/gw-session/config.json", "tmp/config.yaml.bak-20260901", "tmp/evidence.log", "uploads/shot.png", "notes.md",
    ]) write(path.join(mount, rel));
    const stage = (id: string) => {
      const home = path.join(root, "stage", "sessions", `${id}__claude`);
      fs.mkdirSync(home, { recursive: true });
      for (const linked of [".jinn-mount-sentinel", "secrets", "config.yaml", "uploads"]) fs.symlinkSync(path.join(mount, linked), path.join(home, linked));
      for (const real of ["gateway.json", "tmp/session-env.sh", "tmp/mcp.json", "tmp/settings.json"]) write(path.join(home, real));
      return home;
    };
    const mine = stage("mine");
    const sibling = stage("sibling");
    // A partial stage (the smoke tests stage one): only the sentinel linked,
    // gateway.json and tmp/ real — no secrets or config.yaml to recognize it by.
    const smoke = path.join(root, "stage", "sessions", "smoke-first-remote__opencode");
    fs.mkdirSync(smoke, { recursive: true });
    fs.symlinkSync(path.join(mount, ".jinn-mount-sentinel"), path.join(smoke, ".jinn-mount-sentinel"));
    for (const real of ["gateway.json", "tmp/session-env.sh"]) write(path.join(smoke, real));

    const refused = [
      path.join(mine, "gateway.json"), path.join(mine, "tmp", "session-env.sh"), path.join(mine, "config.yaml"),
      path.join(mount, "gateway.json"), path.join(mount, "tmp", "mcp", "gw-session", "config.json"), path.join(mount, "auth-devices.json"),
      path.join(mount, "config.yaml"), path.join(mount, "config.yaml.pre-gen133"), path.join(mount, "tmp", "config.yaml.bak-20260901"),
      path.join(sibling, "gateway.json"), path.join(sibling, "tmp", "session-env.sh"), path.join(sibling, "tmp", "mcp.json"),
      path.join(sibling, "tmp", "settings.json"), path.join(sibling, "secrets", "api-keys.json"),
      path.join(smoke, "gateway.json"), path.join(smoke, "tmp", "session-env.sh"),
    ];
    for (const p of refused) expect(assessFileRead(p, { jinnHome: mine }).allowed, p).toBe(false);

    const allowed = [
      path.join(mount, "notes.md"), path.join(mount, "tmp", "evidence.log"), path.join(mine, "uploads", "shot.png"),
    ];
    // Outside any Jinn home a config.yaml or settings.json is an ordinary file.
    const repo = path.join(root, "repo");
    write(path.join(repo, "config.yaml"));
    write(path.join(repo, "tmp", "settings.json"));
    allowed.push(path.join(repo, "config.yaml"), path.join(repo, "tmp", "settings.json"));
    for (const p of allowed) expect(assessFileRead(p, { jinnHome: mine }).allowed, p).toBe(true);
  });

  it("refuses inside a protected entry that links to a differently named target (review W2)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-alias-"));
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(root, "vault", "jinn-keys"), { recursive: true });
    fs.mkdirSync(path.join(root, "scratch", "jinn-tmp", "mcp", "s1"), { recursive: true });
    fs.writeFileSync(path.join(root, "vault", "jinn-keys", "api-keys.json"), "{}");
    fs.writeFileSync(path.join(root, "scratch", "jinn-tmp", "mcp", "s1", "config.json"), "{}");
    fs.writeFileSync(path.join(root, "scratch", "jinn-tmp", "evidence.log"), "ok");
    fs.symlinkSync(path.join(root, "vault", "jinn-keys"), path.join(home, "secrets"));
    fs.symlinkSync(path.join(root, "scratch", "jinn-tmp"), path.join(home, "tmp"));

    // readLocalFileForIngestion judges only the real path, so the alias is what catches it.
    for (const rel of ["secrets/api-keys.json", "tmp/mcp/s1/config.json"]) {
      const real = fs.realpathSync.native(path.join(home, rel));
      expect(assessFileRead(real, { jinnHome: home }).allowed, rel).toBe(false);
      expect(readLocalFileForIngestion(path.join(home, rel), 1024, { jinnHome: home }), rel).toMatchObject({ ok: false, status: 403 });
    }
    expect(readLocalFileForIngestion(path.join(home, "tmp", "evidence.log"), 1024, { jinnHome: home })).toMatchObject({ ok: true });
  });

  it("judges a nested protected entry or a config.yaml backup that links out of the home at its home name (review round 4, S1)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-nested-alias-"));
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
    fs.mkdirSync(path.join(root, "var", "mcp-configs", "s1"), { recursive: true });
    fs.writeFileSync(path.join(root, "var", "mcp-configs", "s1", "config.json"), "{}");
    fs.writeFileSync(path.join(root, "var", "session.env"), "export JINN_GATEWAY_TOKEN=x");
    fs.writeFileSync(path.join(root, "var", "old-config"), "botToken: x");
    fs.symlinkSync(path.join(root, "var", "mcp-configs"), path.join(home, "tmp", "mcp"));
    fs.symlinkSync(path.join(root, "var", "session.env"), path.join(home, "tmp", "session-env.sh"));
    fs.symlinkSync(path.join(root, "var", "old-config"), path.join(home, "config.yaml.pre-gen133"));
    for (const rel of ["tmp/mcp/s1/config.json", "tmp/session-env.sh", "config.yaml.pre-gen133"]) {
      expect(readLocalFileForIngestion(path.join(home, rel), 1024, { jinnHome: home }), rel).toMatchObject({ ok: false, status: 403 });
    }
    // A link BELOW a protected entry: caught by the name it was asked for by.
    fs.mkdirSync(path.join(root, "outside", "s2"), { recursive: true });
    fs.writeFileSync(path.join(root, "outside", "s2", "config.json"), "{}");
    fs.mkdirSync(path.join(home, "tmp", "codex-homes"), { recursive: true });
    fs.symlinkSync(path.join(root, "outside", "s2"), path.join(home, "tmp", "codex-homes", "s2"));
    expect(readLocalFileForIngestion(path.join(home, "tmp", "codex-homes", "s2", "config.json"), 1024, { jinnHome: home })).toMatchObject({ ok: false, status: 403 });
  });

  it("matches home entries case-insensitively where the filesystem is (win32, darwin)", () => {
    expect(protectedEntryCandidates("C:\\Users\\h\\.jinn\\Secrets\\k.json", path.win32)).toEqual([
      { home: "C:\\Users\\h\\.jinn", entry: "Secrets" },
    ]);
    expect(protectedEntryCandidates("C:\\Users\\h\\.jinn\\Config.YAML", path.win32)).toEqual([
      { home: "C:\\Users\\h\\.jinn", entry: "Config.YAML" },
    ]);
  });

  it("splits drive-letter and UNC paths at their own root, so home entries are found on Windows (review W1)", () => {
    expect(protectedEntryCandidates("C:\\Users\\h\\.jinn\\gateway.json", path.win32)).toEqual([
      { home: "C:\\Users\\h\\.jinn", entry: "gateway.json" },
    ]);
    expect(protectedEntryCandidates("C:\\Users\\h\\.jinn\\tmp\\mcp\\s1\\config.json", path.win32)).toEqual([
      { home: "C:\\Users\\h\\.jinn", entry: "tmp/mcp" },
    ]);
    // The candidate must be exactly the form a known home resolves to.
    expect(protectedEntryCandidates("C:\\Users\\h\\.jinn\\secrets\\k.json", path.win32)[0].home).toBe(path.win32.resolve("C:\\Users\\h\\.jinn"));
    expect(protectedEntryCandidates("\\\\server\\share\\jinn\\config.yaml", path.win32)).toEqual([
      { home: "\\\\server\\share\\jinn", entry: "config.yaml" },
    ]);
    expect(protectedEntryCandidates("/home/h/.jinn/gateway.json", path.posix)).toEqual([{ home: "/home/h/.jinn", entry: "gateway.json" }]);
    expect(protectedEntryCandidates("/home/h/project/notes.md", path.posix)).toEqual([]);
  });

  it("judges the file it OPENED: a link swapped to a benign target after the open is still refused (review F1 race)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-swap-"));
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(home, "secrets", "api-keys.json"), "SECRET-KEY");
    const benign = path.join(root, "benign.txt");
    fs.writeFileSync(benign, "hello");
    const link = path.join(root, "link");
    fs.symlinkSync(path.join(home, "secrets", "api-keys.json"), link);

    // The window: right after the reader opens the canonical target, repoint
    // the link the caller named at something harmless.
    const realOpen = fs.openSync.bind(fs);
    const spy = vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...args);
      fs.unlinkSync(link);
      fs.symlinkSync(benign, link);
      return fd;
    }) as typeof fs.openSync);
    try {
      const read = readLocalFileForIngestion(link, 1024, { jinnHome: home });
      expect(read).toMatchObject({ ok: false, status: 403, error: "Refusing to read Jinn secrets" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("caps by size before reading and reports a missing file as 404", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-cap-"));
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(11));
    expect(readLocalFileForIngestion(file, 10, { jinnHome: dir })).toMatchObject({ ok: false, status: 413 });
    expect(readLocalFileForIngestion(path.join(dir, "nope"), 10, { jinnHome: dir })).toMatchObject({ ok: false, status: 404 });
  });
});
