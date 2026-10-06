import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import fs from "node:fs";
import { ORG_DIR } from "../shared/paths.js";
import { compactEmployeeRole } from "../shared/employee-role.js";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import type { OrgNode } from "../shared/types.js";
import { claudeProfileWire } from "../shared/claude-profile.js";
import type { ApiContext } from "./api.js";

/** Wire shape for the org list: the persona is replaced by its compact role. */
function employeeView(node: OrgNode): Record<string, unknown> {
  const { persona, ...rest } = node.employee;
  const role = compactEmployeeRole(persona);
  return {
    ...rest,
    claudeProfile: claudeProfileWire(node.employee),
    ...(role ? { role } : {}),
    parentName: node.parentName,
    directReports: node.directReports,
    depth: node.depth,
    chain: node.chain,
  };
}

async function getOrg(res: ServerResponse, context: ApiContext): Promise<void> {
  const entries = fs.existsSync(ORG_DIR)
    ? fs.readdirSync(ORG_DIR, { withFileTypes: true })
    : [];
  const departments = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { orgRegistry } = await import("./org-registry.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const hierarchy = resolveOrgHierarchy(orgRegistry(context.getConfig()));

  json(res, {
    departments,
    employees: hierarchy.sorted.map((name) => employeeView(hierarchy.nodes[name])),
    hierarchy: {
      root: hierarchy.root,
      sorted: hierarchy.sorted,
      warnings: hierarchy.warnings,
    },
  });
}

async function getEmployee(res: ServerResponse, name: string, context: ApiContext): Promise<void> {
  const { orgRegistry } = await import("./org-registry.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const roster = orgRegistry(context.getConfig());
  const emp = roster.get(name);
  if (!emp) return notFound(res);

  // An employee the hierarchy never placed still reports its own edges.
  const node = resolveOrgHierarchy(roster).nodes[name];
  json(res, {
    ...emp,
    claudeProfile: claudeProfileWire(emp),
    ...(node
      ? { parentName: node.parentName, directReports: node.directReports, depth: node.depth, chain: node.chain }
      : { parentName: null, directReports: [], depth: 0, chain: [name] }),
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Fields are whitelisted and validated by org.ts; this route only wires it up.
async function patchEmployee(
  req: HttpRequest,
  res: ServerResponse,
  name: string,
  context: ApiContext,
): Promise<void> {
  const _parsed = await readJsonBody(req, res);
  if (!_parsed.ok) return;
  const body = _parsed.body;
  if (!isJsonObject(body)) return badRequest(res, "update body must be a JSON object");

  const { updateEmployeeYaml, validateEmployeeUpdate } = await import("./org.js");
  const { orgRegistry, refreshOrg } = await import("./org-registry.js");
  const current = orgRegistry(context.getConfig()).get(name);
  if (!current) return notFound(res);

  const result = validateEmployeeUpdate(context.getConfig(), current, body);
  if (!result.ok) return badRequest(res, result.error || "invalid update");

  const wrote = updateEmployeeYaml(name, result.updates!);
  if (!wrote) return notFound(res);

  // G1: synchronously refresh the in-memory registry (and drop warm PTYs) so an
  // immediate session spawn sees the new persona/model — don't wait for the watcher.
  context.reloadOrg?.();

  // The write announces itself to the read owner rather than trusting the
  // optional reloadOrg hook to have done it — otherwise the response echoes the
  // pre-write cache back to whoever just made the change.
  const updated = refreshOrg(context.getConfig()).registry.get(name);
  json(res, { status: "ok", employee: updated ?? null });
}

async function handleOrgReads(res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  const { method, pathname } = route;
  if (method !== "GET") return false;
  if (pathname === "/api/org") {
    await getOrg(res, context);
    return true;
  }
  const employee = matchRoute("/api/org/employees/:name", pathname);
  if (employee) {
    await getEmployee(res, employee.name, context);
    return true;
  }
  return false;
}

/** Every route here is operator-only; api.ts gates them before delegating. */
async function handleOrgWrites(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  const { method, pathname } = route;
  const employee = matchRoute("/api/org/employees/:name", pathname);
  if (method === "PATCH" && employee) {
    await patchEmployee(req, res, employee.name, context);
    return true;
  }
  return false;
}

/** `/api/org*` routes. See route-helpers.ts for the domain-module contract. */
export async function handleOrgApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  return (await handleOrgReads(res, route, context)) || (await handleOrgWrites(req, res, route, context));
}
