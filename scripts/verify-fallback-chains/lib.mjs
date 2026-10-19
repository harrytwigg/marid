// What the scenarios share: the gateway's HTTP API, the fake providers' scenario file and
// ledger, and the helpers that put the instance back to a known state between scenarios.
import fs from "node:fs";
import path from "node:path";

export function parseArgs(argv) {
  const out = { strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--strict") out.strict = true;
    else if (flag.startsWith("--")) out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`unexpected argument ${flag}`);
  }
  for (const required of ["baseUrl", "home", "layout", "scenarioFile", "ledger", "netLog", "results"]) {
    if (!out[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return out;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns something truthy; throws `label` on timeout. */
export async function waitFor(label, check, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export class Harness {
  constructor(args) {
    this.args = args;
    this.layout = JSON.parse(fs.readFileSync(args.layout, "utf8"));
    this.token = JSON.parse(fs.readFileSync(path.join(args.home, "gateway.json"), "utf8")).token;
    this.sessions = [];
    this.counter = 0;
  }

  async api(method, route, body) {
    const response = await fetch(`${this.args.baseUrl}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    /** @type {any} */
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* a plain-text answer */ }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  /** A config write through the real API; throws with the gateway's own sentence when it is refused. */
  async putConfig(patch) {
    const result = await this.api("PUT", "/api/config", patch);
    if (result.status !== 200) throw new Error(`PUT /api/config refused (${result.status}): ${result.body?.error ?? JSON.stringify(result.body)}`);
  }

  /** The fake providers read the scenario file on every invocation. */
  writeScenario(scenario) {
    fs.writeFileSync(this.args.scenarioFile, `${JSON.stringify(scenario, null, 2)}\n`);
  }

  ledger() {
    const text = fs.existsSync(this.args.ledger) ? fs.readFileSync(this.args.ledger, "utf8") : "";
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  /** Ledger rows of this scenario's sessions: by the tag its prompts carry. */
  rowsFor(tag) {
    return this.ledger().filter((row) => row.tag === tag && row.consumed);
  }

  networkRefusals() {
    const text = fs.existsSync(this.args.netLog) ? fs.readFileSync(this.args.netLog, "utf8") : "";
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  newTag() {
    this.counter += 1;
    return `fc-tag-${Date.now().toString(36)}${this.counter}`;
  }

  /** Starts a session through the API; the prompt carries `tag` so the ledger can be read back for it. */
  async startSession({ employee, tag, mark, extra = "" }) {
    const prompt = `Reply briefly. ${tag}${mark ? ` ${mark}` : ""} ${extra}`.trim();
    const result = await this.api("POST", "/api/sessions", { prompt, employee, source: "web" });
    if (result.status !== 201) throw new Error(`POST /api/sessions refused (${result.status}): ${result.body?.error ?? JSON.stringify(result.body)}`);
    this.sessions.push(result.body.id);
    return result.body.id;
  }

  async sendMessage(id, tag, mark) {
    const result = await this.api("POST", `/api/sessions/${id}/message`, { message: `Reply briefly again. ${tag}${mark ? ` ${mark}` : ""}` });
    if (result.status !== 200 && result.status !== 202) throw new Error(`POST message refused (${result.status}): ${JSON.stringify(result.body)}`);
  }

  async session(id) {
    const result = await this.api("GET", `/api/sessions/${id}?messages=0`);
    if (result.status !== 200) throw new Error(`GET session ${id}: ${result.status}`);
    return result.body;
  }

  /** The session has stopped working: idle, waiting on a limit, or failed. */
  async settled(id, { timeoutMs = 90_000, quietMs = 1500 } = {}) {
    let last;
    let since = Date.now();
    return waitFor(`session ${id} to settle`, async () => {
      const session = await this.session(id);
      const done = ["idle", "waiting", "error", "interrupted"].includes(session.status);
      const key = `${session.status}|${this.ledger().length}`;
      if (key !== last) { last = key; since = Date.now(); }
      return done && Date.now() - since >= quietMs ? session : undefined;
    }, { timeoutMs });
  }

  /** Back to a known state: no sessions, no engine health, no chains, a clean scenario. */
  async reset() {
    for (const id of this.sessions.splice(0)) {
      await this.api("POST", `/api/sessions/${id}/stop`, {});
      await this.api("DELETE", `/api/sessions/${id}`);
    }
    fs.mkdirSync(path.join(this.args.home, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(this.args.home, "tmp", "engine-health.json"), "{}\n");
    await this.putConfig({
      engines: {
        claude: { fallback: null, fallbackModelMap: null, accounts: { A: { fallback: null }, B: { fallback: null } } },
        opencode: { fallback: null },
      },
    });
    // Part of the contract; a build without employee chains answers 400, which is fine here.
    await this.api("PATCH", `/api/org/employees/${this.layout.employees.override}`, { fallback: null });
    this.writeScenario({});
  }

  /** The link spellings the scenarios chain through. */
  links() {
    const { profiles, opencodeModels } = this.layout;
    return {
      claudeB: { engine: "claude", profile: "B", model: "sonnet" },
      claudeASonnet: { engine: "claude", profile: "A", model: "sonnet" },
      opencodeX: { engine: "opencode", model: opencodeModels.x },
      opencodeY: { engine: "opencode", model: opencodeModels.y },
      profileDirs: profiles,
    };
  }
}

/** Counts of ledger rows by `profile|model` or `model`, for "each target tried exactly once". */
export function triesBy(rows) {
  const counts = {};
  for (const row of rows) {
    const key = row.engine === "claude" ? `claude|${row.profile}|${row.model}` : `opencode|${row.model}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** The (engine, profile, model) of each ledger row in order, as one readable line. */
export function walkOf(rows) {
  return rows.map((row) => (row.engine === "claude" ? `claude/${row.profile}/${row.model}:${row.outcome}` : `opencode/${row.model}:${row.outcome}`)).join(" -> ");
}

export class Mismatch extends Error {}

/** Throws a Mismatch naming what differed, with the walk the ledger recorded. */
export function expectEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Mismatch(`${label}: expected ${e}, got ${a}`);
}

export function expectTrue(label, value, detail = "") {
  if (!value) throw new Mismatch(`${label}${detail ? `: ${detail}` : ""}`);
}
