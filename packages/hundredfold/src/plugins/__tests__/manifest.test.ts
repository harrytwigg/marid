import { describe, it, expect } from "vitest";
import path from "node:path";
import { isContainedIn, validateManifest } from "../manifest.js";

/**
 * The manifest's `client` and `server` fields are attacker-influenced input, and
 * every rejection here is a rule with a concrete exposure behind it. The three
 * spellings of one file, and the sibling directory whose name merely extends the
 * plugin's, are the cases a string comparison gets wrong.
 */

/**
 * Resolved, not joined. The module resolves entries with `path.resolve`, and on Windows a
 * separator-rooted path like `\instance\plugins\safe` is not fully qualified: resolving it
 * prepends the current drive, so a joined expectation would differ from the module's answer by
 * `D:` alone. `path.resolve` from the root gives both sides the same fully-qualified base, and
 * is identical to joining on POSIX.
 */
const dir = path.resolve(path.sep, "instance", "plugins", "safe");

function validate(fields: Record<string, unknown>, pluginDir = dir) {
  return validateManifest(fields, pluginDir);
}

function errorFor(fields: Record<string, unknown>, pluginDir = dir): string {
  const result = validate(fields, pluginDir);
  if (result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result.manifest)}`);
  return result.error;
}

function manifestFor(fields: Record<string, unknown>, pluginDir = dir) {
  const result = validate(fields, pluginDir);
  if (!result.ok) throw new Error(`expected a valid manifest, got ${result.error}`);
  return result.manifest;
}

describe("identity", () => {
  it("defaults name, version and client, and resolves the client entry absolutely", () => {
    expect(manifestFor({ id: "safe" })).toEqual({
      id: "safe",
      name: "safe",
      version: "0.0.0",
      client: path.join(dir, "client.js"),
      server: null,
    });
  });

  it("keeps the manifest's own name, version and entries", () => {
    expect(manifestFor({ id: "safe", name: "Safe", version: "1.2.0", client: "ui.js", server: "backend.js" })).toEqual({
      id: "safe",
      name: "Safe",
      version: "1.2.0",
      client: path.join(dir, "ui.js"),
      server: path.join(dir, "backend.js"),
    });
  });

  it("names both the id and the folder when they disagree", () => {
    const error = errorFor({ id: "other" });
    expect(error).toContain("other");
    expect(error).toContain("safe");
  });

  it.each([
    ["uppercase", "Safe"],
    ["a leading hyphen", "-safe"],
    ["a single character", "s"],
    ["an underscore", "safe_one"],
    ["a path separator", "safe/evil"],
    ["forty characters", "a".repeat(40)],
  ])("rejects an id with %s", (_label, id) => {
    expect(errorFor({ id }, path.join(path.dirname(dir), id))).toMatch(/id/);
  });

  it("rejects the reserved gateway id", () => {
    expect(errorFor({ id: "hundredfold" }, path.join(path.dirname(dir), "hundredfold"))).toMatch(/reserved/);
  });

  it("rejects a manifest that is not an object, and a missing id", () => {
    expect(errorFor([] as unknown as Record<string, unknown>)).toMatch(/object/);
    expect(errorFor({ name: "Safe" })).toMatch(/id/);
  });
});

describe("distinct client and server entries", () => {
  // Both entries are relative and both are contained, so containment cannot see
  // this: the plugin publishes its own backend as its client half, and /client
  // would hand the gateway-side source to any authenticated caller.
  it.each(["server.js", "./server.js", "assets/../server.js"])(
    "rejects the whole plugin when client is spelled %s and resolves onto server",
    (spelling) => {
      const error = errorFor({ id: "safe", client: spelling, server: "server.js" });
      expect(error).toContain("client");
      expect(error).toContain("server");
    },
  );

  it("rejects the pair whichever field carries the alternative spelling", () => {
    expect(errorFor({ id: "safe", client: "server.js", server: "assets/../server.js" })).toContain("client");
  });

  it("is not a partial load — nothing of an equal pair survives", () => {
    expect(validate({ id: "safe", client: "server.js", server: "server.js" }).ok).toBe(false);
  });

  it("accepts two entries that only look alike", () => {
    const manifest = manifestFor({ id: "safe", client: "server-ui.js", server: "server.js" });
    expect(manifest.client).not.toBe(manifest.server);
  });
});

describe("traversal and absolute paths", () => {
  it.each([
    ["an absolute path", path.join(path.sep, "tmp", "evil.js")],
    ["a parent traversal", path.join("..", "..", "evil.js")],
    ["a sibling that extends the plugin folder", path.join("..", "safe-extra", "evil.js")],
    ["the plugin directory itself", "."],
    ["a blank entry", "   "],
  ])("rejects a client naming %s", (_label, client) => {
    expect(errorFor({ id: "safe", client })).toContain("client");
  });

  it("rejects a client that is not a string", () => {
    expect(errorFor({ id: "safe", client: 7 })).toContain("client");
    expect(errorFor({ id: "safe", client: null })).toContain("client");
  });

  it("loads the client half and records the rejection when only the server escapes", () => {
    const manifest = manifestFor({ id: "safe", client: "client.js", server: path.join("..", "safe-extra", "evil.js") });
    expect(manifest.client).toBe(path.join(dir, "client.js"));
    expect(manifest.server).toBeNull();
    expect(manifest.serverError).toContain("server");
  });

  it("rejects a non-string name or version rather than defaulting over it", () => {
    expect(errorFor({ id: "safe", name: 7 })).toContain("name");
    expect(errorFor({ id: "safe", version: {} })).toContain("version");
  });
});

describe("isContainedIn", () => {
  const root = path.resolve(path.sep, "instance", "plugins", "safe");

  it("accepts a file inside the root, at any depth", () => {
    expect(isContainedIn(root, path.join(root, "client.js"))).toBe(true);
    expect(isContainedIn(root, path.join(root, "assets", "icons", "logo.svg"))).toBe(true);
  });

  it("rejects a sibling whose name merely extends the root", () => {
    expect(isContainedIn(root, path.join(path.dirname(root), "safe-extra", "evil.js"))).toBe(false);
  });

  it("rejects the root itself, its parent, and an unrelated absolute path", () => {
    expect(isContainedIn(root, root)).toBe(false);
    expect(isContainedIn(root, path.dirname(root))).toBe(false);
    expect(isContainedIn(root, path.join(path.sep, "tmp", "evil.js"))).toBe(false);
  });
});
