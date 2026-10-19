import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctorFindings } from "../doctor.js";
import { opencodeFallbackFindings, type OpencodeFallbackReading } from "../doctor-opencode-fallback.js";
import { detectOpencodeInternalFallbackFindings } from "../../engines/opencode-internal-fallback.js";
import { classifyFallbackPath, fixLine, internalFallbackFixLines } from "../../engines/opencode-internal-fallback-fix.js";

const reading = (extra: Partial<OpencodeFallbackReading> = {}): OpencodeFallbackReading => ({ local: [], remote: [], ...extra });
const text = (findings: ReturnType<typeof opencodeFallbackFindings>): string => findings.map((f) => f.message).join("\n");

describe("doctor's report on an opencode internal fallback", () => {
  it("is ok on a clean host", () => {
    expect(opencodeFallbackFindings(reading())).toEqual([{ level: "ok", message: "opencode has no internal model fallback configured." }]);
  });

  it("names every file to change on this host, in order: migrate first, then remove, then check", () => {
    const found = opencodeFallbackFindings(reading({
      local: [
        { kind: "config-plugin", file: "/p/config/opencode.json", key: "plugin", entry: "opencode-rate-limit@1.4.0" },
        { kind: "plugin-file", path: "/p/config/plugin/model-fallback.js" },
        { kind: "settings", file: "/p/dot/rate-limit-fallback.json" },
      ],
    }));
    expect(found[0]!.level).toBe("problem");
    const lines = found.slice(1).map((f) => f.message.trim());
    expect(lines).toEqual([
      "1. Turn the plugin's settings into a gateway chain first (the command reads rate-limit-fallback.json):",
      "jinn fallback migrate-opencode --write",
      "2. Then remove the plugin by hand:",
      "On this host:",
      "- remove `opencode-rate-limit@1.4.0` from `plugin` in /p/config/opencode.json",
      "- delete /p/config/plugin/model-fallback.js",
      '- delete /p/dot/rate-limit-fallback.json, or set "enabled": false in it',
      "3. Run `jinn doctor` again: it should report no internal fallback.",
    ]);
  });

  it("names a remote host's files under that host, from the paths it reported", () => {
    const found = opencodeFallbackFindings(reading({
      remote: [{ host: "build-host", sources: ["/r/.config/opencode/opencode.jsonc", "/r/.config/opencode/plugin/model-fallback.js", "/r/.opencode/rate-limit-fallback.json"] }],
    }));
    const out = text(found);
    expect(out).toContain("On build-host:");
    expect(out).toContain("remove the `opencode-rate-limit` (or model-fallback) entry from `plugin` in /r/.config/opencode/opencode.jsonc");
    expect(out).toContain("delete /r/.config/opencode/plugin/model-fallback.js");
    expect(out).toContain('delete /r/.opencode/rate-limit-fallback.json, or set "enabled": false in it');
    expect(out).toContain("copy /r/.opencode/rate-limit-fallback.json from build-host here, then: jinn fallback migrate-opencode --file <copy> --write");
    expect(out).not.toContain("On this host");
  });

  it("covers this host and a remote host together, and says when the remote hosts were not read", () => {
    const out = text(opencodeFallbackFindings(reading({
      local: [{ kind: "settings", file: "/l/rate-limit-fallback.json" }],
      remote: [{ host: "other", sources: ["/r/plugin/model-fallback.js"] }],
      remoteNote: "the running gateway did not answer /api/engines (HTTP 401), so remote hosts were not checked",
    })));
    expect(out).toContain("On this host:");
    expect(out).toContain("On other:");
    expect(out).toContain("HTTP 401");
  });

  it("says when there are no settings to migrate", () => {
    const out = text(opencodeFallbackFindings(reading({ local: [{ kind: "plugin-file", path: "/l/plugin/model-fallback.js" }] })));
    expect(out).toContain("No rate-limit-fallback.json was found");
    expect(out).not.toContain("migrate-opencode --write");
  });

  it("is added to doctor's report only when given a reading", () => {
    const without = doctorFindings({ env: {}, home: "/nowhere", instances: [] });
    const withReading = doctorFindings({ env: {}, home: "/nowhere", instances: [], opencodeFallback: reading() });
    expect(withReading).toHaveLength(without.length + 1);
  });
});

describe("the fix lines", () => {
  it("classify a reported path by what it is", () => {
    expect(classifyFallbackPath("/x/.opencode/rate-limit-fallback.json")).toEqual({ kind: "settings", file: "/x/.opencode/rate-limit-fallback.json" });
    expect(classifyFallbackPath("/x/opencode.json")).toMatchObject({ kind: "config-plugin" });
    expect(classifyFallbackPath("/x/plugin/model-fallback.js")).toEqual({ kind: "plugin-file", path: "/x/plugin/model-fallback.js" });
    expect(classifyFallbackPath("/x/plugins/model-fallback")).toEqual({ kind: "plugin-file", path: "/x/plugins/model-fallback" });
  });

  it("name the 2.x `plugins` key when that is where the entry is", () => {
    expect(fixLine({ kind: "config-plugin", file: "/c/opencode.json", key: "plugins", entry: '{"package":"opencode-rate-limit@1.4.0"}' })).toBe(
      'remove `{"package":"opencode-rate-limit@1.4.0"}` from `plugins` in /c/opencode.json',
    );
    expect(internalFallbackFixLines([{ findings: [] }]).at(-1)).toContain("jinn doctor");
  });
});

describe("findings from the files on disk", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fix-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("keep the key, the entry and the path, so the fix names what is really there", () => {
    const config = path.join(root, ".config", "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ plugin: ["x", "opencode-rate-limit@1.4.0"] }));
    const found = detectOpencodeInternalFallbackFindings({ env: {}, home: root });
    expect(found).toEqual([{ kind: "config-plugin", file: config, key: "plugin", entry: "opencode-rate-limit@1.4.0" }]);
    expect(fixLine(found[0]!)).toBe(`remove \`opencode-rate-limit@1.4.0\` from \`plugin\` in ${config}`);
  });
});
