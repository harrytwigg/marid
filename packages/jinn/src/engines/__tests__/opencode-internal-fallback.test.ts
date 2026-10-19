import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from "../../shared/logger.js";
import {
  detectOpencodeInternalFallback,
  parseJsonc,
  pluginEntryName,
  warnOpencodeInternalFallback,
  withInternalFallback,
  type DetectOptions,
} from "../opencode-internal-fallback.js";

let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-internal-fallback-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(file: string, content: string): string {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const detect = (extra: Partial<DetectOptions> = {}) => detectOpencodeInternalFallback({ env: {}, home, projectDirs: [project], ...extra });

describe("detectOpencodeInternalFallback", () => {
  it("finds nothing on a clean host, and an unrelated plugin is not a fallback", () => {
    put("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["opencode-anthropic-auth@1.0.0", "file:///x/error-retry.js"] }));
    put("home/.config/opencode/plugin/error-retry.js", "export default {}");
    expect(detect()).toEqual({ detected: false, neutralised: false, sources: [] });
  });

  const layouts: Array<{ name: string; files: Record<string, string>; sourceIncludes: string }> = [
    { name: "the 1.x plugin in the config dir's plugin list", files: { "home/.config/opencode/opencode.json": '{"plugin": ["opencode-rate-limit@1.4.0"]}' }, sourceIncludes: "opencode.json" },
    { name: "the plugin in a .jsonc config with comments and a trailing comma", files: { "home/.config/opencode/opencode.jsonc": '{\n // fallback\n "plugin": ["opencode-rate-limit", /* x */],\n}' }, sourceIncludes: "opencode.jsonc" },
    { name: "the plugin in ~/.opencode/opencode.json", files: { "home/.opencode/opencode.json": '{"plugin": ["opencode-rate-limit@1.4.0"]}' }, sourceIncludes: path.join(".opencode", "opencode.json") },
    { name: "the plugin in a project opencode.json", files: { "project/opencode.json": '{"plugin": ["opencode-rate-limit"]}' }, sourceIncludes: path.join("project", "opencode.json") },
    { name: "the plugin named in a 2.x plugins entry with options", files: { "home/.config/opencode/opencode.json": '{"plugins": [{"package": "opencode-rate-limit@1.4.0", "options": {}}]}' }, sourceIncludes: "opencode.json" },
    { name: "a model-fallback.js plugin file in the config dir", files: { "home/.config/opencode/plugin/model-fallback.js": "export default {}" }, sourceIncludes: path.join("plugin", "model-fallback.js") },
    { name: "a model-fallback plugin directory under plugins/", files: { "home/.config/opencode/plugins/model-fallback/index.js": "export default {}" }, sourceIncludes: path.join("plugins", "model-fallback") },
    { name: "a file plugin entry named model-fallback", files: { "home/.config/opencode/opencode.json": '{"plugin": ["file:///opt/x/model-fallback.js"]}' }, sourceIncludes: "model-fallback.js" },
    { name: "rate-limit-fallback.json in ~/.opencode", files: { "home/.opencode/rate-limit-fallback.json": '{"fallbackModels": []}' }, sourceIncludes: path.join(".opencode", "rate-limit-fallback.json") },
    { name: "rate-limit-fallback.json in the project's .opencode", files: { "project/.opencode/rate-limit-fallback.json": '{"enabled": true}' }, sourceIncludes: path.join("project", ".opencode") },
    { name: "rate-limit-fallback.json in the config dir", files: { "home/.config/opencode/rate-limit-fallback.json": "{}" }, sourceIncludes: path.join(".config", "opencode", "rate-limit-fallback.json") },
  ];
  it.each(layouts)("detects $name", ({ files, sourceIncludes }) => {
    for (const [file, content] of Object.entries(files)) put(file, content);
    const found = detect();
    expect(found.detected).toBe(true);
    expect(found.neutralised).toBe(false);
    expect(found.sources.some((s) => s.includes(sourceIncludes))).toBe(true);
  });

  it("ignores a settings file that says enabled: false, or that does not parse", () => {
    put("home/.opencode/rate-limit-fallback.json", '{"enabled": false, "fallbackModels": []}');
    put("project/.opencode/rate-limit-fallback.json", "{ not json");
    expect(detect().detected).toBe(false);
  });

  it("reads OPENCODE_CONFIG and OPENCODE_CONFIG_DIR as the operator's own", () => {
    const file = put("elsewhere/oc.json", '{"plugin": ["opencode-rate-limit@1.4.0"]}');
    expect(detect({ env: { OPENCODE_CONFIG: file } }).detected).toBe(true);
    put("cfgdir/plugin/model-fallback.js", "x");
    expect(detect({ env: { OPENCODE_CONFIG_DIR: path.join(root, "cfgdir") } }).detected).toBe(true);
  });

  it("follows XDG_CONFIG_HOME", () => {
    put("xdg/opencode/opencode.json", '{"plugin": ["opencode-rate-limit"]}');
    expect(detect({ env: { XDG_CONFIG_HOME: path.join(root, "xdg") } }).detected).toBe(true);
    expect(detect().detected).toBe(false);
  });

  it("lists each source once, and changes nothing on disk", () => {
    const settings = put("home/.opencode/rate-limit-fallback.json", "{}");
    const before = fs.readFileSync(settings, "utf-8");
    const found = detect({ projectDirs: [home, home] });
    expect(new Set(found.sources).size).toBe(found.sources.length);
    expect(fs.readFileSync(settings, "utf-8")).toBe(before);
  });
});

describe("helpers", () => {
  it("names a plugin entry by package or file", () => {
    expect(pluginEntryName("opencode-rate-limit@1.4.0")).toBe("opencode-rate-limit");
    expect(pluginEntryName("@scope/thing@2.0.0")).toBe("@scope/thing");
    expect(pluginEntryName({ package: "opencode-rate-limit@1.4.0" })).toBe("opencode-rate-limit");
    expect(pluginEntryName("file:///a/b/model-fallback.js")).toBe("model-fallback");
    expect(pluginEntryName(42)).toBeUndefined();
  });

  it("parses JSONC without touching comment markers inside strings", () => {
    expect(parseJsonc('{"url": "http://x//y", /* c */ "a": [1, 2,],\n// end\n}')).toEqual({ url: "http://x//y", a: [1, 2] });
  });
});

describe("reporting", () => {
  const found = { detected: true, neutralised: false, sources: ["/operator/path/rate-limit-fallback.json"] };

  it("adds the reading to the opencode entry of the engines map only", () => {
    const engines = { claude: { available: true }, opencode: { available: true } };
    expect(withInternalFallback(engines, () => found)).toEqual({ claude: { available: true }, opencode: { available: true, internalFallback: found } });
    expect(withInternalFallback({ claude: {} }, () => found)).toEqual({ claude: {} });
  });

  it("warns at start without the operator's paths, which stay at debug", () => {
    warnOpencodeInternalFallback(() => found);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(String(vi.mocked(logger.warn).mock.calls[0]![0])).not.toContain("/operator/path");
    expect(String(vi.mocked(logger.debug).mock.calls[0]![0])).toContain("/operator/path");
  });

  it("says nothing when there is no internal fallback", () => {
    vi.mocked(logger.warn).mockClear();
    warnOpencodeInternalFallback(() => ({ detected: false, neutralised: false, sources: [] }));
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
