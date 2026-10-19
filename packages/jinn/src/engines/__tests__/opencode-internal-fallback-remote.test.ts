import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from "../../shared/logger.js";
import { FACTS_SCRIPT } from "../remote-stage.js";
import { remoteFallbackSources } from "../opencode-internal-fallback-remote.js";
import {
  combinedOpencodeInternalFallback,
  fallbackPluginAbortsTurns,
  recordRemoteInternalFallback,
  resetOpencodeInternalFallbackCache,
  withInternalFallback,
} from "../opencode-internal-fallback.js";

/** The facts script, run by a local `sh` as a remote host would, with a stand-in `opencode` on its PATH. */
function runFacts(home: string): Record<string, string> {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho 1.19.0\n", { mode: 0o755 });
  const stdout = execFileSync("sh", ["-s"], {
    input: FACTS_SCRIPT,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    encoding: "utf-8",
  });
  const kv: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return kv;
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-remote-fallback-"));
  resetOpencodeInternalFallbackCache();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function put(file: string, content: string): string {
  const full = path.join(home, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe("the facts script's opencode fallback probe", () => {
  it("reports nothing on a clean host, and still reports the opencode version", () => {
    put(".config/opencode/opencode.json", '{"plugin": ["opencode-anthropic-auth@1.0.0"]}');
    put(".config/opencode/plugin/error-retry.js", "x");
    const kv = runFacts(home);
    expect(kv.opencodeversion).toBe("1.19.0");
    expect(remoteFallbackSources(kv)).toEqual([]);
  });

  it("reports the plugin in the config, a plugin file, and a settings file that is not disabled", () => {
    const config = put(".config/opencode/opencode.jsonc", '{ "plugin": ["opencode-rate-limit@1.4.0"] }');
    const plugin = put(".config/opencode/plugin/model-fallback.js", "x");
    const settings = put(".opencode/rate-limit-fallback.json", '{"fallbackModels": []}');
    expect(remoteFallbackSources(runFacts(home))).toEqual([config, plugin, settings]);
  });

  it("skips a settings file that says enabled: false", () => {
    put(".opencode/rate-limit-fallback.json", '{\n  "enabled": false\n}');
    expect(remoteFallbackSources(runFacts(home))).toEqual([]);
  });

  it("follows the local rules for plugin files: a renamed file is not the plugin, a plugins/ file and a plugin/ directory are", () => {
    put(".config/opencode/plugin/model-fallback.js.disabled", "x");
    put(".config/opencode/plugin/model-fallback.test.js", "x");
    put(".config/opencode/plugin/model-fallback.js.bak", "x");
    expect(remoteFallbackSources(runFacts(home))).toEqual([]);
    const inPlugins = put(".config/opencode/plugins/model-fallback.js", "x");
    const dir = put(".config/opencode/plugin/opencode-rate-limit/index.js", "x");
    const found = remoteFallbackSources(runFacts(home));
    expect(found).toHaveLength(2);
    expect(found).toEqual(expect.arrayContaining([path.dirname(dir), inPlugins]));
  });

  it("finds the plugin in a config as a tuple, under a scope, or with an npm: prefix", () => {
    for (const entry of ['[["opencode-rate-limit", {}]]', '["@acme/opencode-rate-limit@1.0.0"]', '["npm:opencode-rate-limit"]']) {
      fs.rmSync(path.join(home, ".config"), { recursive: true, force: true });
      const config = put(".config/opencode/opencode.json", `{"plugin": ${entry}}`);
      expect(remoteFallbackSources(runFacts(home))).toEqual([config]);
    }
  });

  it("anchors the plugin's name: a helper whose name merely contains it is not the plugin", () => {
    put(".config/opencode/opencode.json", '{"plugin": ["./plugins/no-model-fallback-helper.js", "opencode-rate-limit-extras"]}');
    expect(remoteFallbackSources(runFacts(home))).toEqual([]);
  });

  it("reads only a settings file's own top-level enabled: a nested one does not disable it, a top-level one does", () => {
    const settings = put(".opencode/rate-limit-fallback.json", '{"circuitBreaker": {"enabled": false}, "fallbackModels": []}');
    expect(remoteFallbackSources(runFacts(home))).toEqual([settings]);
    put(".opencode/rate-limit-fallback.json", '{"enabled": false, "circuitBreaker": {"enabled": true}}');
    expect(remoteFallbackSources(runFacts(home))).toEqual([]);
  });

  it("reads a plugin directory under plugins/", () => {
    const dir = put(".opencode/plugins/model-fallback/index.js", "x");
    expect(remoteFallbackSources(runFacts(home))).toEqual([path.dirname(dir)]);
  });
});

describe("remote reports", () => {
  it("orders and de-duplicates the printed paths", () => {
    expect(remoteFallbackSources({ "opencodefallback.10": "/c", "opencodefallback.2": "/b", "opencodefallback.1": "/a", "opencodefallback.3": "/b", other: "x" })).toEqual(["/a", "/b", "/c"]);
  });

  it("adds a remote host's sources to the reading as host: path, and warns once per host without the path", () => {
    vi.mocked(logger.warn).mockClear();
    recordRemoteInternalFallback("builder", ["/home/op/.opencode/rate-limit-fallback.json"]);
    recordRemoteInternalFallback("builder", ["/home/op/.opencode/rate-limit-fallback.json"]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(String(vi.mocked(logger.warn).mock.calls[0]![0])).toBe(
      "opencode internal fallback detected on remote host builder: run `jinn doctor` for the files to change, then `jinn fallback migrate-opencode`",
    );
    expect(String(vi.mocked(logger.warn).mock.calls[0]![0])).not.toContain("/home/op");
    const combined = combinedOpencodeInternalFallback();
    expect(combined.detected).toBe(true);
    expect(combined.sources).toContain("builder: /home/op/.opencode/rate-limit-fallback.json");
    expect(combined.remote).toEqual([{ host: "builder", sources: ["/home/op/.opencode/rate-limit-fallback.json"] }]);
    expect(withInternalFallback({ opencode: {} }).opencode).toMatchObject({ internalFallback: { detected: true, neutralised: false } });
  });

  it("reads a plugin's abort and re-send only on a 1.x binary: the 2.x plugin switches models inside the turn", () => {
    recordRemoteInternalFallback("builder", ["/x"]);
    expect(fallbackPluginAbortsTurns(1, "builder")).toBe(true);
    expect(fallbackPluginAbortsTurns(undefined, "builder")).toBe(true);
    expect(fallbackPluginAbortsTurns(2, "builder")).toBe(false);
    expect(fallbackPluginAbortsTurns(1, "another-host")).toBe(false);
  });

  it("forgets a host that no longer reports one", () => {
    recordRemoteInternalFallback("builder", ["/x"]);
    recordRemoteInternalFallback("builder", []);
    expect(combinedOpencodeInternalFallback().sources.some((s) => s.startsWith("builder:"))).toBe(false);
  });
});
