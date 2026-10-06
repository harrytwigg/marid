import { call, context, home, sessionHeaders, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import { refuseScopedConnectorSession } from "../../sessions/scoped-connector.js";
import { refuseScopedTurn } from "../../sessions/turn/scoped-turn.js";
import type { Connector, IncomingMessage, Session } from "../../shared/types.js";
import { writeEmployeeFile } from "./department-fixtures.js";
import { rejectUnverifiedIdentifiedUpgradeCaller } from "../upgrade-guards.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";

/**
 * FR-017, FR-026 and the edges of a scoped employee's validation: the turn runs only on
 * the claude engine, a connector session is refused, cron cannot target a scoped
 * employee, the org scan drops one that asks for another engine or a remote host, and a
 * socket upgrade is refused.
 */

let self: Session;
let eng: Session;

beforeAll(async () => {
  await startScopedHarness();
  self = await sessionOf("side-dev");
  eng = await sessionOf("eng-dev");
});
afterEach(() => vi.restoreAllMocks());

describe("a scoped session's turn", () => {
  it("runs on the claude engine, however it is asked to run", () => {
    expect(refuseScopedTurn(self, undefined)).toBeUndefined();
    expect(refuseScopedTurn(self, "claude")).toBeUndefined();
    expect(refuseScopedTurn(self, "codex")).toBe('A session scoped to department "side-project" runs only on the claude engine, not "codex".');
    expect(refuseScopedTurn({ ...self, engine: "codex" }, undefined)).toMatch(/runs only on the claude engine, not "codex"/);
    expect(refuseScopedTurn({ ...self, engine: "codex" }, "claude")).toBeUndefined();
  });

  it("is not held to it when the session is not scoped", () => {
    expect(refuseScopedTurn({ ...eng, engine: "codex" }, undefined)).toBeUndefined();
    expect(refuseScopedTurn(eng, "codex")).toBeUndefined();
  });
});

describe("a connector-originated session", () => {
  const connector = () => ({ name: "telegram", reconstructTarget: vi.fn(() => ({ channel: "c" })), sendMessage: vi.fn(async () => undefined) }) as unknown as Connector & { sendMessage: ReturnType<typeof vi.fn> };
  const incoming = (source: string) => ({ connector: "telegram", source, sessionKey: "k", replyContext: {}, channel: "c", user: "u", userId: "1", text: "hi", attachments: [], raw: {} }) as IncomingMessage;

  it("is refused for a scoped employee when it comes from Telegram, and the sender is told why", () => {
    const telegram = connector();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(refuseScopedConnectorSession(incoming("telegram"), "side-dev", telegram)).toBe(true);
    expect(telegram.sendMessage).toHaveBeenCalledWith({ channel: "c" }, expect.stringContaining('side-dev is confined to department "side-project" and cannot be reached through telegram'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Refused a telegram session for side-dev"));
  });

  it("is not refused from the web, for an unscoped employee, or with no employee", () => {
    const telegram = connector();
    expect(refuseScopedConnectorSession(incoming("web"), "side-dev", telegram)).toBe(false);
    expect(refuseScopedConnectorSession(incoming("telegram"), "eng-dev", telegram)).toBe(false);
    expect(refuseScopedConnectorSession(incoming("telegram"), undefined, telegram)).toBe(false);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe("cron", () => {
  const job = (employee: string) => ({ name: "scoped job", schedule: "0 * * * *", prompt: "go", employee, enabled: false });

  it("refuses a job that targets a scoped employee", async () => {
    const refused = await call("POST", "/api/cron", job("side-dev"));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('cron jobs cannot target side-dev, who is confined to department "side-project"; cron stays company-level');
  });

  it("still takes a job for an unscoped employee", async () => {
    expect((await call("POST", "/api/cron", job("eng-dev"))).status).toBe(201);
  });
});

describe("the org scan", () => {
  const dropped = (name: string, fields: Record<string, string>) => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    writeEmployeeFile("side-project", name, fields);
    refreshOrg(context.getConfig());
    return { error, loaded: orgRegistry(context.getConfig()).has(name) };
  };

  it("drops a scoped employee on another engine, and logs why", () => {
    const { error, loaded } = dropped("codex-dev", { engine: "codex", model: "gpt-5.6-sol" });
    expect(loaded).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/codex-dev\.yaml: it is in non-open department "side-project", whose employees must use the claude engine .*not "codex"/));
  });

  it("drops a scoped employee with a remote host, and logs why", () => {
    const { error, loaded } = dropped("remote-dev", { remoteHost: "build-box" });
    expect(loaded).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/remote-dev\.yaml: it is in non-open department "side-project" and sets remoteHost "build-box"/));
  });

  it("loads an unscoped employee on any engine, so the rule is the department's", () => {
    writeEmployeeFile("engineering", "codex-eng", { engine: "codex", model: "gpt-5.6-sol" });
    refreshOrg(context.getConfig());
    expect(orgRegistry(context.getConfig()).has("codex-eng")).toBe(true);
  });

  it("refuses an engine change for a scoped employee through the API, and leaves the file", async () => {
    const file = path.join(home, "org", "side-project", "side-dev.yaml");
    const before = fs.readFileSync(file, "utf-8");
    const refused = await call("PATCH", "/api/org/employees/side-dev", { engine: "codex", model: "gpt-5.6-sol" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^side-dev cannot be updated: it is in non-open department "side-project", whose employees must use the claude engine/);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect((await call("PATCH", "/api/org/employees/eng-dev", { engine: "codex", model: "gpt-5.6-sol" })).status).toBe(200);
  });
});

describe("a WebSocket upgrade", () => {
  const upgrade = (sessionId?: string) => {
    const written: string[] = [];
    const socket = { write: (chunk: string) => written.push(chunk), destroy: vi.fn() };
    const req = { headers: sessionId ? sessionHeaders(sessionId) : { authorization: "Bearer test-token" } } as unknown as http.IncomingMessage;
    return { rejected: rejectUnverifiedIdentifiedUpgradeCaller(req, socket), written: written.join(""), socket };
  };

  it("is refused to a scoped session", () => {
    const { rejected, written, socket } = upgrade(self.id);
    expect(rejected).toBe(true);
    expect(written).toContain("HTTP/1.1 403 Forbidden");
    expect(written).toContain("WebSocket upgrades are not available to a department-scoped session");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("is not refused to an unscoped session, or to the operator", () => {
    for (const caller of [eng.id, undefined]) {
      const { rejected, written } = upgrade(caller);
      expect({ caller, rejected, written }).toEqual({ caller, rejected: false, written: "" });
    }
  });
});
