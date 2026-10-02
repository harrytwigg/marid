import fs from "node:fs";
import path from "node:path";

/**
 * The fixture behind `backend-host-context.test.ts`: a real plugin directory on
 * disk and the home it reads through the host verbs.
 *
 * It lives beside the test rather than inside it because the test is about what
 * the verbs answer, and forty lines of `writeFileSync` in front of that buries
 * the claim.
 */

/**
 * The plugin's server module.
 *
 * The probe runs in the watcher because that is where a real plugin's background
 * work lives. `start` is not awaited by the supervisor — the promise it returns
 * is the watcher's *lifetime* — so the probe hands its own promise out on a
 * global for the test to await.
 */
export const PROBE_SERVER = `
globalThis.__pluginContextProbe = { registrar: null, watcher: null, started: 0 };

async function callVerbs(host) {
  const recorded = {};
  const record = async (verb, call) => {
    try {
      recorded[verb] = { ok: true, value: await call() };
    } catch (error) {
      recorded[verb] = { ok: false, error: String(error && error.message) };
    }
  };

  await record("notes.create", () => host.notes.create({ title: "Minted by a plugin", body: "the body" }));
  const created = recorded["notes.create"].value;
  await record("notes.read", () => host.notes.read(created ? created.path : "knowledge/missing.md"));
  await record("notes.list", () => host.notes.list());
  await record("knowledge.search", () => host.knowledge.search("kestrel"));
  await record("connectors.send", () => host.connectors.send("slack", { channel: "C1", text: "hello" }));
  await record("cron.jobs", () => host.cron.jobs());
  await record("cron.runs", () => host.cron.runs("digest"));
  return recorded;
}

export default function register(ctx) {
  globalThis.__pluginContextProbe.registrar = ctx;
  return { "GET /ping": (_req, res) => res.end("ok") };
}
export const watcher = {
  start(ctx) {
    globalThis.__pluginContextProbe.watcher = ctx;
    globalThis.__pluginContextProbe.started += 1;
    globalThis.__pluginHostProbe = callVerbs(ctx.host);
  },
  stop() {},
};
`;

export function writeProbePlugin(home: string): void {
  const pluginsDir = path.join(home, "plugins");
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  const dir = path.join(pluginsDir, "probe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "probe", name: "Probe", version: "1.0.0", client: "client.mjs", server: "server.mjs" }),
  );
  fs.writeFileSync(path.join(dir, "client.mjs"), "export default { id: 'probe', register() {} }");
  fs.writeFileSync(path.join(dir, "server.mjs"), PROBE_SERVER);
}

/** The knowledge file and the cron job the read verbs go looking for. The job
 *  carries a prompt on purpose: the read tier has to withhold it. */
export function seedProbeHome(home: string): void {
  fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(home, "knowledge", "birds.md"), "# Birds\n\nThe kestrel hunts by hovering.\n");

  fs.mkdirSync(path.join(home, "cron", "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "cron", "jobs.json"),
    JSON.stringify([
      {
        id: "digest",
        name: "Daily digest",
        enabled: true,
        schedule: "0 9 * * *",
        timezone: "UTC",
        employee: "a-lead",
        prompt: "summarise yesterday",
      },
    ]),
  );
  fs.writeFileSync(
    path.join(home, "cron", "runs", "digest.jsonl"),
    `${JSON.stringify({ id: "run-9", jobId: "digest", status: "success", durationMs: 1200, prompt: "summarise yesterday" })}\n`,
  );
}
