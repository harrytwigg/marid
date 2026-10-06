import { as, context, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { departmentStageDir } from "../department-scope/paths.js";
import { makeWorkdir, rewriteSideProject } from "./department-scope-fixtures.js";
import { writeEmployeeFile } from "./department-fixtures.js";
import { refreshOrg } from "../org-registry.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * FR-065: the gateway's JSON `{path}` attachment route names a file on the gateway, so a
 * scoped session whose employee runs on a remote host is refused any path, one inside the
 * department's local roots included, and pointed at `attach_to_work_item`, which reads on
 * the host. A local scoped session is unchanged.
 */

const REMOTE = { root: "/srv/root", mount: "/mnt/jinn" };
let work: { dir: string; file: string };
let todo: WorkItem;
let remoteId: string;
let localId: string;

beforeAll(async () => {
  const { workItems } = await startScopedHarness();
  // The scoped harness has no `remote` block, and a remote employee is dropped without one.
  const base = context.getConfig;
  (context as { getConfig: typeof base }).getConfig = () => ({ ...base(), remote: REMOTE });
  work = makeWorkdir("remote-files");
  await rewriteSideProject([`workdirs: ["${work.dir}"]`]);
  writeEmployeeFile("side-project", "side-remote", { department: "side-project", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg(context.getConfig());
  fs.mkdirSync(departmentStageDir("side-project"), { recursive: true });
  todo = workItems.createWorkItem({ title: "remote files", department: "side-project", assignee: "side-dev" });
  remoteId = (await sessionOf("side-remote")).id;
  localId = (await sessionOf("side-dev")).id;
});

const attach = (caller: ReturnType<typeof as>, file: string) => caller("POST", `/api/work-items/${todo.id}/attachments`, { path: file });

describe("the JSON {path} attachment route for a scoped session", () => {
  it("refuses a remote employee's session any path, one inside its department's local roots included, naming attach_to_work_item", async () => {
    const refused = await attach(as(remoteId), work.file);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("attach_to_work_item");
    expect(refused.body.error).toContain("build-box");
  });

  it("is unchanged for a local scoped session", async () => {
    expect((await attach(as(localId), work.file)).status).toBe(201);
  });
});
