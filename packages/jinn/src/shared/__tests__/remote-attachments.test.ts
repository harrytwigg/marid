import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapAttachmentsForRemote, REMOTE_COPY_MAX_BYTES, remoteAttachmentsDir } from "../remote-attachments.js";

const SESSION_HOME = "/home/builder/.jinn-remote-stage/sessions/sess-1__claude";

describe("mapAttachmentsForRemote", () => {
  let home: string;
  let elsewhere: string;
  const opts = () => ({ sessionHome: SESSION_HOME, sessionId: "sess-1", gatewayHome: home });

  const write = (dir: string, rel: string, body = "bytes"): string => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-home-")));
    elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gw-else-")));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("names a file under a linked home entry by the same relative path in the session home", () => {
    const file = write(home, "uploads/2026-10-02/sess-1/a.png");
    expect(mapAttachmentsForRemote([file], opts())).toEqual([`${SESSION_HOME}/uploads/2026-10-02/sess-1/a.png`]);
    // Nothing is copied when the file is already reachable.
    expect(fs.readdirSync(path.join(home, "uploads/2026-10-02/sess-1"))).toEqual(["a.png"]);
  });

  it("copies a connector download in tmp/, which the staged home does not link, into uploads/", () => {
    const file = write(home, "tmp/telegram-photo.jpg", "jpeg-bytes");
    const [mapped] = mapAttachmentsForRemote([file], opts());
    expect(mapped.startsWith(`${SESSION_HOME}/${remoteAttachmentsDir("sess-1")}/`)).toBe(true);
    expect(mapped.endsWith("-telegram-photo.jpg")).toBe(true);
    // A YYYY-MM-DD bucket, so the gateway's upload sweep ages the copy out.
    expect(mapped.slice(`${SESSION_HOME}/uploads/`.length)).toMatch(/^\d{4}-\d{2}-\d{2}\/sess-1\//);
    const onGateway = path.join(home, mapped.slice(SESSION_HOME.length + 1));
    expect(fs.readFileSync(onGateway, "utf8")).toBe("jpeg-bytes");
    expect(fs.statSync(onGateway).mode & 0o777).toBe(0o600);
  });

  it("copies a file outside the gateway home, and does so once for identical bytes", () => {
    const file = write(elsewhere, "report.pdf", "pdf");
    const first = mapAttachmentsForRemote([file], opts());
    const second = mapAttachmentsForRemote([file], opts());
    expect(second).toEqual(first);
    const dir = path.join(home, remoteAttachmentsDir("sess-1"));
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it("keeps same-named files with different bytes apart", () => {
    const a = write(elsewhere, "a/notes.txt", "one");
    const b = write(elsewhere, "b/notes.txt", "two");
    const [ma, mb] = mapAttachmentsForRemote([a, b], opts());
    expect(ma).not.toBe(mb);
  });

  it("follows a symlink to the real file before deciding where it lives", () => {
    const real = write(elsewhere, "real.txt", "x");
    const link = path.join(home, "uploads", "link.txt");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const [mapped] = mapAttachmentsForRemote([link], opts());
    // The target is outside the home, so it is copied; the link's own name must
    // not be trusted to be reachable remotely.
    expect(mapped).toContain(`/${remoteAttachmentsDir("sess-1")}/`);
  });

  // The farm links every home entry for every session, so the remote can already
  // open these by path. Refusing them would only drop the operator's message.
  it("does not refuse a file under a linked entry that the policy would hide, because the remote can already open it", () => {
    const pem = write(home, "uploads/2026-10-02/sess-1/server-cert.pem", "pem");
    const secret = write(home, "secrets/api-keys.json", "{}");
    expect(mapAttachmentsForRemote([pem, secret], opts())).toEqual([
      `${SESSION_HOME}/uploads/2026-10-02/sess-1/server-cert.pem`,
      `${SESSION_HOME}/secrets/api-keys.json`,
    ]);
    // Mapping a linked file reads and copies nothing.
    expect(fs.readdirSync(path.join(home, "uploads/2026-10-02/sess-1")).sort()).toEqual(["server-cert.pem"]);
  });

  it("refuses to COPY a file the policy hides, and copies nothing", () => {
    const sessionConfig = write(home, "tmp/mcp/sess-1.json", "{}");
    const env = write(elsewhere, ".env", "KEY=1");
    expect(() => mapAttachmentsForRemote([sessionConfig], opts())).toThrow(/sess-1\.json.*credential or session-config/i);
    expect(() => mapAttachmentsForRemote([env], opts())).toThrow(/\.env.*environment secret/i);
    expect(fs.existsSync(path.join(home, remoteAttachmentsDir("sess-1")))).toBe(false);
  });

  // A link BELOW a protected entry is refused by the name it is asked for, even
  // though its target is benign and outside the home.
  it("refuses to copy a symlink below a protected entry whose target is benign", () => {
    const target = write(elsewhere, "benign.txt", "hello");
    const link = path.join(home, "tmp", "mcp", "sess-1.json");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    expect(() => mapAttachmentsForRemote([link], opts())).toThrow(/credential or session-config/i);
    expect(fs.existsSync(path.join(home, remoteAttachmentsDir("sess-1")))).toBe(false);
  });

  it("refuses a missing file and a directory, naming the file", () => {
    expect(() => mapAttachmentsForRemote([path.join(home, "uploads/nope.png")], opts())).toThrow(/nope\.png.*does not exist/);
    expect(() => mapAttachmentsForRemote([home], opts())).toThrow(/not a regular file/);
  });

  it("refuses to copy more than the cap, before creating anything", () => {
    const big = path.join(elsewhere, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(REMOTE_COPY_MAX_BYTES + 1));
    expect(() => mapAttachmentsForRemote([big], opts())).toThrow(/big\.bin.*25 MB per-file limit/);
    expect(fs.existsSync(path.join(home, remoteAttachmentsDir("sess-1")))).toBe(false);
  });

  // Every remote session can write under uploads/, and every part of a copy's
  // name is predictable, so a link can be planted where the copy will go.
  describe("a link planted where the copy goes", () => {
    const digestName = (body: string, name: string) =>
      `${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}-${name}`;

    it("is replaced by the copy, and its target is left untouched", () => {
      const victim = write(elsewhere, "victim.txt", "precious");
      const file = write(home, "tmp/tg.jpg", "jpeg-bytes");
      const dest = path.join(home, remoteAttachmentsDir("sess-1"), digestName("jpeg-bytes", "tg.jpg"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(victim, dest);
      const [mapped] = mapAttachmentsForRemote([file], opts());
      expect(mapped).toBe(`${SESSION_HOME}/${remoteAttachmentsDir("sess-1")}/${digestName("jpeg-bytes", "tg.jpg")}`);
      expect(fs.readFileSync(victim, "utf8")).toBe("precious");
      expect(fs.lstatSync(dest).isFile()).toBe(true);
      expect(fs.readFileSync(dest, "utf8")).toBe("jpeg-bytes");
    });

    it("as the session directory is refused, and nothing is written through it", () => {
      const outside = path.join(elsewhere, "outside");
      fs.mkdirSync(outside);
      const sessionDir = path.join(home, remoteAttachmentsDir("sess-1"));
      fs.mkdirSync(path.dirname(sessionDir), { recursive: true });
      fs.symlinkSync(outside, sessionDir);
      const file = write(home, "tmp/tg.jpg", "jpeg-bytes");
      expect(() => mapAttachmentsForRemote([file], opts())).toThrow(/tg\.jpg.*not a plain directory/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("as the date directory is refused, and nothing is written through it", () => {
      const outside = path.join(elsewhere, "outside");
      fs.mkdirSync(outside);
      const dateDir = path.dirname(path.join(home, remoteAttachmentsDir("sess-1")));
      fs.mkdirSync(path.dirname(dateDir), { recursive: true });
      fs.symlinkSync(outside, dateDir);
      const file = write(home, "tmp/tg.jpg", "jpeg-bytes");
      expect(() => mapAttachmentsForRemote([file], opts())).toThrow(/not a plain directory/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  it("removes its part file when the copy cannot be put in place", () => {
    const file = write(elsewhere, "report.pdf", "pdf");
    const dir = path.join(home, remoteAttachmentsDir("sess-1"));
    // A non-empty directory at the destination makes the final rename fail
    // after the part file has been written.
    write(dir, `${crypto.createHash("sha256").update("pdf").digest("hex").slice(0, 16)}-report.pdf/occupied`);
    expect(() => mapAttachmentsForRemote([file], opts())).toThrow(/report\.pdf/);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("scopes copies by session and sanitises the segments", () => {
    const file = write(elsewhere, "we ird$name.txt", "z");
    const [mapped] = mapAttachmentsForRemote([file], { ...opts(), sessionId: "../evil" });
    expect(mapped.split("/")).not.toContain("..");
    // Session segment and file name are each ONE path segment under the subdir.
    expect(mapped.slice(`${SESSION_HOME}/uploads/`.length).split("/")).toHaveLength(3); // date / session / file
    expect(mapped).not.toContain("$");
    expect(mapped).not.toContain(" ");
  });
});
