import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildTalkControlManifest,
  renderTalkCompanyCoverageMarkdown,
  TALK_COMPANY_CAPABILITY_COVERAGE,
  validateTalkCompanyCoverage,
} from "../manifest.js";
import { BROWSER_CONTROL_OPERATIONS } from "../browser-tools.js";
import { DOMAIN_HANDLER_NAMES } from "../domain-adapters.js";
import { VERIFY_HANDLER_NAMES } from "../verification.js";

describe("the authoritative Talk control manifest", () => {
  it("owns every provider declaration exactly once", () => {
    const manifest = buildTalkControlManifest();
    const names = manifest.operations.map((operation) => operation.name);

    expect(new Set(names).size).toBe(names.length);
    expect(manifest.version).toBe(1);
    expect(manifest.operations.every((operation) => operation.parameters.additionalProperties === false)).toBe(true);
  });

  it("routes the representative company journey through the gateway", () => {
    const byName = new Map(buildTalkControlManifest().operations.map((operation) => [operation.name, operation]));
    for (const name of [
      "read_todo",
      "talk_edit_todo",
      "talk_comment_todo",
      "talk_assign_todo",
      "talk_delegate_todo",
      "read_session",
    ]) {
      expect(byName.get(name), name).toMatchObject({ target: "gateway" });
    }
    expect(byName.get("open_todo")).toMatchObject({ target: "browser", mutability: "effect" });
    expect(byName.get("capture_current_view")).toMatchObject({ target: "browser", mutability: "read" });
    expect(byName.get("talk_search_chat_messages")).toMatchObject({
      target: "browser",
      mutability: "read",
      operatorOnly: false,
      parameters: {
        required: ["query"],
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
    });
    expect(byName.get("read_talk_capability")).toMatchObject({ target: "gateway", mutability: "read", operatorOnly: false });
  });

  /**
   * The twin PLA-224 found: `talk_send_to_session` was declared browser-target
   * while a complete gateway adapter, durable claim, and re-read sat behind it
   * as dead code. Preflight refused the gateway path, the consent sheet asked
   * and never sent, and the operator's message went nowhere. One name, one
   * owner — enforced here rather than left to reading.
   */
  it("gives every operation exactly one execution owner", () => {
    const manifest = buildTalkControlManifest();
    const browserNames = new Set(BROWSER_CONTROL_OPERATIONS.map((operation) => operation.name));
    const gatewayNames = manifest.operations
      .filter((operation) => operation.target === "gateway")
      .map((operation) => operation.name);

    expect(gatewayNames.filter((name) => browserNames.has(name))).toEqual([]);
    // A gateway operation is only reachable if something executes it AND
    // something re-reads it authoritatively; missing either fails closed.
    expect(gatewayNames.filter((name) => !DOMAIN_HANDLER_NAMES.includes(name))).toEqual([]);
    expect(gatewayNames.filter((name) => !VERIFY_HANDLER_NAMES.includes(name))).toEqual([]);
    // And nothing executes on the gateway that the manifest never declared.
    expect(DOMAIN_HANDLER_NAMES.filter((name) => !gatewayNames.includes(name))).toEqual([]);
  });

  it("keeps visible-composer actions browser-local while the named-session send is a gateway write", () => {
    const byName = new Map(buildTalkControlManifest().operations.map((operation) => [operation.name, operation]));
    for (const name of ["talk_draft_reply", "talk_replace_draft", "talk_send_draft", "talk_draft_and_send"]) {
      const operation = byName.get(name);
      expect(operation, name).toMatchObject({
        target: "browser",
        intent: "sessions",
        mutability: "effect",
        operatorOnly: false,
      });
      expect(operation?.parameters.properties).not.toHaveProperty("id");
      expect(operation?.parameters.properties).not.toHaveProperty("sessionId");
    }
    expect(byName.get("talk_send_to_session")).toMatchObject({
      target: "gateway",
      intent: "sessions",
      mutability: "write",
      operatorOnly: true,
      verification: "session-message-reread",
    });
  });

  it("requires the spoken creation confirmation to name the new Todo id", () => {
    const create = buildTalkControlManifest().operations.find(({ name }) => name === "talk_create_todo");

    expect(create?.description).toMatch(/say.*full Todo id/i);
  });

  it("requires an authoritative read for unfamiliar Todo ids", () => {
    const read = buildTalkControlManifest().operations.find(({ name }) => name === "read_todo");

    expect(read?.description).toMatch(/always call.*unfamiliar/i);
  });

  it("contains no credentials or machine paths", () => {
    const serialized = JSON.stringify(buildTalkControlManifest());
    expect(serialized).not.toMatch(/authorization|bearer|api[_-]?key|\/Users\//i);
  });

  it("declares every company lane as executable or an explicit planned gap", () => {
    expect(validateTalkCompanyCoverage()).toEqual([]);
    expect(Object.values(TALK_COMPANY_CAPABILITY_COVERAGE).every((entry) => entry.status === "supported"
      || Boolean(entry.reason && entry.plannedAdapter))).toBe(true);
  });

  it("keeps the company section of the operator coverage report fresh", () => {
    const report = readFileSync("../../docs/talk-control-coverage.md", "utf8");
    expect(report).toContain(renderTalkCompanyCoverageMarkdown());
  });
});
