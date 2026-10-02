import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapAttachmentsForRemote, remoteAttachmentsDir } from "../remote-attachments.js";

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

  it("refuses credential and session-config files, and a missing file, naming the file", () => {
    const secret = write(home, "secrets/api-keys.json", "{}");
    expect(() => mapAttachmentsForRemote([secret], opts())).toThrow(/api-keys\.json.*secrets/i);
    const config = write(home, "config.yaml", "x: 1");
    expect(() => mapAttachmentsForRemote([config], opts())).toThrow(/config\.yaml/);
    expect(() => mapAttachmentsForRemote([path.join(home, "uploads/nope.png")], opts())).toThrow(/nope\.png.*does not exist/);
    expect(() => mapAttachmentsForRemote([home], opts())).toThrow(/not a regular file/);
    // Nothing was copied for a refused file.
    expect(fs.existsSync(path.join(home, remoteAttachmentsDir("sess-1")))).toBe(false);
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
