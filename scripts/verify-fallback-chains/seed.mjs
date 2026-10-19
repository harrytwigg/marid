// Seeds the throwaway instance of scripts/verify-fallback-chains.sh before it starts:
// two fake Claude profiles (A and B) declared under engines.claude.accounts, the stub
// binaries as absolute `engines.<engine>.bin`, the opencode mode under test, and the
// employees the scenarios drive. Every path it writes is under the temporary host home.
//
//   node seed.mjs --sandbox-home H --host-home T --gateway-repo R --harness-root S --mode run|server
//
// It prints the layout as JSON for the driver (profile directories, employees, models).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || !argv[index + 1]) throw new Error(`seed.mjs: --${name} is required`);
  return argv[index + 1];
};
const sandboxHome = arg("sandbox-home");
const hostHome = arg("host-home");
const gatewayRepo = arg("gateway-repo");
const harnessRoot = arg("harness-root");
const mode = arg("mode");
if (mode !== "run" && mode !== "server") throw new Error(`seed.mjs: --mode is run or server, not ${mode}`);

// The instance home is a child of the temporary host home, the way jinn-sandbox.sh lays it out.
if (path.dirname(sandboxHome) !== hostHome) throw new Error(`seed.mjs: ${sandboxHome} is not directly inside the temporary host home ${hostHome}`);

export const LAYOUT = {
  profiles: { A: path.join(hostHome, "profile-a"), B: path.join(hostHome, "profile-b") },
  defaultProfile: path.join(sandboxHome, ".claude-sandbox"),
  bins: {
    claude: path.join(harnessRoot, "scripts/fake-providers/fake-claude.mjs"),
    opencode: path.join(harnessRoot, "packages/jinn/src/engines/__tests__/fixtures/fake-opencode.mjs"),
  },
  // The opencode models the scenarios use: the session's own, and the two a chain hops through.
  opencodeModels: { own: "own-provider/model-own", x: "x-provider/model-x", y: "y-provider/model-y" },
  employees: {
    onA: "dev-on-a", onDefault: "dev-on-default", onOpencode: "dev-on-opencode", override: "dev-override",
  },
};

/** Credentials the sign-in check accepts and nothing can use: a login file with no token in it. */
function fakeLogin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), `${JSON.stringify({ claudeAiOauth: { note: "fake-provider-harness" } })}\n`, { mode: 0o600 });
}

function employee(name, extra) {
  const dir = path.join(sandboxHome, "org", "fallback-harness");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`name: ${name}`, `displayName: ${name}`, "department: fallback-harness", "rank: senior", ...extra, "persona: |", `  You are ${name}, a stand-in employee for the fallback chain harness.`, ""];
  fs.writeFileSync(path.join(dir, `${name}.yaml`), lines.join("\n"));
}

async function patchConfig() {
  const dist = path.join(gatewayRepo, "packages/jinn/dist/src");
  const { patchConfigFile } = await import(pathToFileURL(path.join(dist, "shared/config-document.js")).href);
  const { opencodeModels, bins, profiles } = LAYOUT;
  patchConfigFile(path.join(sandboxHome, "config.yaml"), [
    { path: ["engines", "claude", "bin"], value: bins.claude },
    { path: ["engines", "claude", "accounts"], value: { A: { configDir: profiles.A }, B: { configDir: profiles.B } } },
    { path: ["engines", "opencode"], value: { bin: bins.opencode, mode, model: opencodeModels.own } },
    // The default browser MCP server is `npx -y @playwright/mcp@latest`: a registry fetch the harness must not make.
    { path: ["mcp", "browser", "enabled"], value: false },
    { path: ["mcp", "search", "enabled"], value: false },
    { path: ["mcp", "fetch", "enabled"], value: false },
    // Nothing else may serve a turn: a stray codex or grok bin on the host must never be reachable.
    { path: ["engines", "codex", "bin"], value: path.join(sandboxHome, "no-such-codex") },
    { path: ["engines", "grok", "bin"], value: path.join(sandboxHome, "no-such-grok") },
    { path: ["engines", "hermes", "bin"], value: path.join(sandboxHome, "no-such-hermes") },
  ]);
}

for (const dir of [...Object.values(LAYOUT.profiles), LAYOUT.defaultProfile]) fakeLogin(dir);
employee(LAYOUT.employees.onA, ["engine: claude", "model: opus", `claudeConfigDir: ${LAYOUT.profiles.A}`]);
employee(LAYOUT.employees.onDefault, ["engine: claude", "model: opus"]);
employee(LAYOUT.employees.override, ["engine: claude", "model: opus"]);
employee(LAYOUT.employees.onOpencode, ["engine: opencode", `model: ${LAYOUT.opencodeModels.own}`]);
await patchConfig();
process.stdout.write(`${JSON.stringify({ ...LAYOUT, mode })}\n`);
