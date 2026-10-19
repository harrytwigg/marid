// The fallback chain scenarios (docs/fallback-chains.md). Each is `{ id, title, run(h) }`:
// it writes the chain through the real API, scripts what each fake provider does for each
// profile and model, drives sessions through the real HTTP API, and asserts on API state and
// on the ledger the fakes wrote, which proves which profile and model actually served each hop.
//
// To add one: append an entry to SCENARIOS (see README.md). Ids are single letters; the shell
// script's --pending list names the ones that wait on runtime work not yet merged (none now).
import { expectEqual, expectTrue, triesBy, walkOf } from "./lib.mjs";

const RATE_LIMITS = ["rate-limit", "quota"];
const WALK_A = "claude/profile-a/opus:rate-limit -> claude/profile-b/sonnet:rate-limit -> opencode/x-provider/model-x:rate-limit -> opencode/y-provider/model-y:ok";
const linkKey = (link) => `${link.engine}|${link.profile ?? ""}|${link.model ?? ""}`;
/** The hops the session API reports (`fallback.chain.hops`, most recent first), oldest first. */
const chainHops = (session) => [...(session.fallback?.chain?.hops ?? [])].reverse();
const hopTargets = (session) => chainHops(session).map((hop) => hop.to);

/** The session API's own account of where a session was served and how it got there. */
function expectServedBy(session, link) {
  expectEqual("transportMeta.fallbackServedBy.key", session.transportMeta?.fallbackServedBy?.key, linkKey(link));
  expectEqual("fallback.chain.servedBy", session.fallback?.chain?.servedBy, linkKey(link));
}

async function fourLinkWalk(h) {
  const { claudeB, opencodeX, opencodeY, profileDirs } = h.links();
  await h.putConfig({ engines: { claude: { accounts: { A: { fallback: [claudeB, opencodeX, opencodeY] } } } } });
  h.writeScenario({
    claude: { "profile-a|opus": "rate-limit", "profile-b|sonnet": "rate-limit" },
    opencode: { [opencodeX.model]: "rate-limit", [opencodeY.model]: "ok" },
  });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onA, tag }));
  const rows = h.rowsFor(tag);
  expectEqual("the walk the ledger recorded", walkOf(rows), WALK_A);
  expectEqual("profile directories", [rows[0].profileDir, rows[1].profileDir], [profileDirs.A, profileDirs.B]);
  expectEqual("hop targets in order", hopTargets(session), [claudeB, opencodeX, opencodeY].map(linkKey));
  expectTrue("every hop is a limit", chainHops(session).every((hop) => RATE_LIMITS.includes(hop.reason)));
  expectServedBy(session, opencodeY);
  expectEqual("session status", session.status, "idle");
}

async function everyLinkLimited(h) {
  const { claudeB, opencodeX, opencodeY } = h.links();
  await h.putConfig({ engines: { claude: { accounts: { A: { fallback: [claudeB, opencodeX, opencodeY] } } } } });
  h.writeScenario({ claude: { "*": "rate-limit" }, opencode: { "*": "rate-limit" } });
  const tag = h.newTag();
  const id = await h.startSession({ employee: h.layout.employees.onA, tag });
  const session = await h.settled(id);
  const rows = h.rowsFor(tag);
  expectEqual("each target tried exactly once", triesBy(rows), { "claude|profile-a|opus": 1, "claude|profile-b|sonnet": 1, "opencode|x-provider/model-x": 1, "opencode|y-provider/model-y": 1 });
  expectEqual("session status", session.status, "waiting");
  expectEqual("the run out of chain is recorded", session.fallback?.chain?.hops?.[0]?.to, null);
  // settled() already held the ledger still for its quiet window, and the wait is for the reset an hour away.
}

async function loopGuard(h) {
  await h.putConfig({
    engines: {
      claude: { fallback: ["claude:A", "opencode"], accounts: { A: { fallback: ["claude", "opencode"] } } },
      opencode: { fallback: ["claude", "claude:A"] },
    },
  });
  h.writeScenario({ claude: { "*": "rate-limit" }, opencode: { "*": "rate-limit" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onDefault, tag }));
  const rows = h.rowsFor(tag);
  expectEqual("each target of the cycle tried once", triesBy(rows), { "claude|default|opus": 1, "claude|profile-a|opus": 1, [`opencode|${h.layout.opencodeModels.own}`]: 1 });
  expectEqual("session status", session.status, "waiting");
}

async function employeeOverride(h) {
  const { opencodeX, opencodeY } = h.links();
  const employee = h.layout.employees.override;
  await h.putConfig({ engines: { claude: { fallback: [opencodeX] } } });
  const patched = await h.api("PATCH", `/api/org/employees/${employee}`, { fallback: [opencodeY] });
  expectEqual("PATCH employee fallback", patched.status, 200);
  h.writeScenario({ claude: { "default|opus": "rate-limit" }, opencode: { "*": "ok" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee, tag }));
  expectEqual("the employee's chain ran, not the engine's", walkOf(h.rowsFor(tag)), "claude/default/opus:rate-limit -> opencode/y-provider/model-y:ok");
  expectEqual("chain source", session.fallback?.chain?.source, "employee");
}

async function legacyParity(h) {
  await h.putConfig({ engines: { claude: { fallback: ["opencode"] } } });
  h.writeScenario({ claude: { "default|opus": "rate-limit" }, opencode: { "*": "ok" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onDefault, tag }));
  const rows = h.rowsFor(tag);
  expectEqual("the legacy walk", walkOf(rows), `claude/default/opus:rate-limit -> opencode/${h.layout.opencodeModels.own}:ok`);
  expectEqual("default profile directory", rows[0].profileDir, h.layout.defaultProfile);
  expectEqual("session status", session.status, "idle");
}

async function duplicateRefused(h) {
  const { opencodeX } = h.links();
  const before = (await h.api("GET", "/api/config")).body;
  const duplicate = await h.api("PUT", "/api/config", { engines: { claude: { fallback: [opencodeX, opencodeX] } } });
  expectEqual("duplicate target: status", duplicate.status, 400);
  expectTrue("duplicate target: the sentence", /duplicates .*tries each target once/.test(String(duplicate.body?.error)), String(duplicate.body?.error));
  const own = await h.api("PUT", "/api/config", { engines: { opencode: { fallback: [{ engine: "opencode" }] } } });
  expectEqual("a link equal to its own target: status", own.status, 400);
  expectTrue("a link equal to its own target: the sentence", /falls back from/.test(String(own.body?.error)), String(own.body?.error));
  expectEqual("nothing was written", (await h.api("GET", "/api/config")).body, before);
}

/** A profile hop starts a fresh run carrying the conversation; a model hop on a thread resumes it. */
async function contextAcrossHops(h) {
  const { claudeB, claudeASonnet } = h.links();
  const employee = h.layout.employees.onA;
  const secondTurnLimited = { claude: { "profile-a|opus": ["ok", "rate-limit"], "*": "ok" } };

  await h.putConfig({ engines: { claude: { accounts: { A: { fallback: [claudeB] } } } } });
  h.writeScenario(secondTurnLimited);
  const profileTag = h.newTag();
  const firstMark = `fc-mark-${profileTag.slice(-6)}`;
  const profileSession = await h.startSession({ employee, tag: profileTag, mark: firstMark });
  await h.settled(profileSession);
  await h.sendMessage(profileSession, profileTag, "fc-mark-second");
  await h.settled(profileSession);
  const profileRows = h.rowsFor(profileTag);
  const aFirst = profileRows.find((row) => row.profile === "profile-a" && row.outcome === "ok");
  expectTrue("the first turn ran on A", aFirst, walkOf(profileRows));
  const aThread = aFirst.sessionId;
  const underB = profileRows.filter((row) => row.profile === "profile-b");
  expectTrue("the second turn reached B", underB.length === 1, walkOf(profileRows));
  expectEqual("B starts fresh: no --resume", underB[0].resume, null);
  expectTrue("A's session id is never resumed under B", profileRows.every((row) => row.profile !== "profile-b" || row.resume !== aThread));
  expectTrue("the conversation travels to B", underB[0].marks.includes(firstMark), JSON.stringify(underB[0].marks));

  await h.putConfig({ engines: { claude: { accounts: { A: { fallback: [claudeASonnet] } } } } });
  h.writeScenario(secondTurnLimited);
  const modelTag = h.newTag();
  const modelSession = await h.startSession({ employee, tag: modelTag });
  await h.settled(modelSession);
  await h.sendMessage(modelSession, modelTag);
  await h.settled(modelSession);
  const modelRows = h.rowsFor(modelTag);
  const first = modelRows.find((row) => row.outcome === "ok" && row.model === "opus");
  expectTrue("the first turn ran on A", first, walkOf(modelRows));
  const thread = first.sessionId;
  const sonnet = modelRows.find((row) => row.model === "sonnet");
  expectTrue("the model hop reached sonnet on A", sonnet?.profile === "profile-a", walkOf(modelRows));
  expectEqual("the model hop resumes the same thread", sonnet.sessionId, thread);
}

async function opencodeProviderHop(h) {
  const { opencodeY } = h.links();
  const own = h.layout.opencodeModels.own;
  await h.putConfig({ engines: { opencode: { fallback: [opencodeY] } } });
  h.writeScenario({ opencode: { [own]: "rate-limit", [opencodeY.model]: "ok" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onOpencode, tag }));
  const rows = h.rowsFor(tag);
  expectEqual("the provider hop", walkOf(rows), `opencode/${own}:rate-limit -> opencode/${opencodeY.model}:ok`);
  expectEqual("one opencode session carries both", rows[1].sessionId, rows[0].sessionId);
  expectEqual("mode under test", rows[0].mode, h.layout.mode);
  expectServedBy(session, opencodeY);
}

export const SCENARIOS = [
  { id: "a", title: "four-link chain walks hop by hop, each hop on its own profile and model", run: fourLinkWalk },
  { id: "b", title: "every link limited: each target once, then the session waits on its own", run: everyLinkLimited },
  { id: "c", title: "loop guard: a cycle of legacy entries never retries a target", run: loopGuard },
  { id: "d", title: "an employee chain overrides the engine default", run: employeeOverride },
  { id: "e", title: "a legacy string-only config behaves as on main", run: legacyParity },
  { id: "f", title: "PUT /api/config refuses a duplicate and a self-referencing link", run: duplicateRefused },
  { id: "g", title: "a profile hop starts fresh with the conversation; a model hop resumes the thread", run: contextAcrossHops },
  { id: "h", title: "an opencode provider hop X to Y within one opencode session", run: opencodeProviderHop },
];
