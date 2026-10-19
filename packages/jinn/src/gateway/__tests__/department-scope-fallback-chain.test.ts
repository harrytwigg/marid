import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { as, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import type { Session } from "../../shared/types.js";

/**
 * A department-scoped session reads its own session's `fallback.chain` (the chains endpoint is the
 * operator's, and refused to scoped callers): the chain is served, and its non-Claude links read as
 * passed over because the department confines the session to Claude accounts.
 */

let self: Session;

beforeAll(async () => {
  await startScopedHarness();
  fs.writeFileSync(path.join(home, "org", "side-project", "side-dev.yaml"), [
    "name: side-dev", "displayName: side-dev", "department: side-project", "rank: employee", "engine: claude", "model: opus",
    "persona: Works on side-project.", "fallback:", "  - { engine: claude, model: sonnet }", "  - { engine: codex }", "",
  ].join("\n"));
  const { refreshOrg } = await import("../org-registry.js");
  const { context } = await import("./department-scope-harness.js");
  refreshOrg(context.getConfig());
  self = await sessionOf("side-dev");
});

describe("fallback.chain for a scoped session reading its own session", () => {
  it("is served with the employee's chain, the non-Claude link passed over as scoped", async () => {
    const got = await as(self.id)("GET", `/api/sessions/${self.id}`);
    expect(got.status).toBe(200);
    const { chain } = got.body.fallback;
    expect(chain).toMatchObject({ source: "employee", position: 0, servedBy: null, next: "claude||sonnet", hops: [] });
    expect(chain.links.map((link: any) => [link.key, link.skip])).toEqual([["claude||", undefined], ["claude||sonnet", undefined], ["codex||", "scoped"]]);
  });

  it("is refused the chains endpoint, which lists company configuration", async () => {
    expect((await as(self.id)("GET", "/api/fallback-chains")).status).toBe(403);
  });
});
