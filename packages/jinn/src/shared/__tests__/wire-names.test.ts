import { describe, expect, it } from "vitest";
import { namesFor } from "../codename.js";
import {
  adoptLegacyHeaders,
  hookSessionIdKey,
  isToolCallMarker,
  mcpFlagAliases,
  orgMcpKey,
  readHookSessionId,
  toolCallMarker,
  wireHeader,
  wireHeaderAliases,
  wireHeaderDisplay,
  wireHeaderDisplayAliases,
} from "../wire-names.js";

const acme = namesFor("acme");
const same = namesFor("jinn");

describe("wire header names", () => {
  it("writes the current name and reads both, in the lower case Node hands over and in the form a CORS list prints", () => {
    expect(wireHeader("caller-session", acme)).toBe("x-acme-caller-session");
    expect(wireHeaderAliases("caller-session", acme)).toEqual(["x-acme-caller-session", "x-jinn-caller-session"]);
    expect(wireHeaderDisplay("config-revision", acme)).toBe("X-Acme-Config-Revision");
    expect(wireHeaderDisplayAliases("config-revision", acme)).toEqual(["X-Acme-Config-Revision", "X-Jinn-Config-Revision"]);
    expect(wireHeaderAliases("origin", same)).toEqual(["x-jinn-origin"]);
  });

  it("gives a legacy header sent by an older peer its current-named twin and leaves the rest alone", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "x-jinn-session-capability": "cap",
      "x-jinn-tool-call": "jinn-mcp",
      "x-forwarded-proto": "https",
      "x-jinnx-other": "1",
    };
    adoptLegacyHeaders(headers, acme);
    expect(headers["x-acme-session-capability"]).toBe("cap");
    expect(headers["x-acme-tool-call"]).toBe("jinn-mcp");
    expect(headers["x-acme-other"]).toBeUndefined();
    expect(headers["x-jinn-session-capability"]).toBe("cap");
  });

  it("keeps the value of a header sent under both names", () => {
    const headers: Record<string, string | string[] | undefined> = { "x-jinn-origin": "old", "x-acme-origin": "talk" };
    adoptLegacyHeaders(headers, acme);
    expect(headers["x-acme-origin"]).toBe("talk");
  });

  it("does nothing while the codename is unchanged", () => {
    const headers: Record<string, string | string[] | undefined> = { "x-jinn-origin": "talk" };
    adoptLegacyHeaders(headers, same);
    expect(Object.keys(headers)).toEqual(["x-jinn-origin"]);
  });
});

describe("tool-call marker", () => {
  it("accepts the marker of this build and of an older one, and nothing else", () => {
    expect(toolCallMarker(acme)).toBe("acme-mcp");
    expect(isToolCallMarker("acme-mcp", acme)).toBe(true);
    expect(isToolCallMarker("jinn-mcp", acme)).toBe(true);
    expect(isToolCallMarker("other-mcp", acme)).toBe(false);
    expect(isToolCallMarker(undefined, acme)).toBe(false);
    expect(isToolCallMarker("acme-mcp", same)).toBe(false);
  });
});

describe("launch flags, org key and hook body", () => {
  it("names the launch flag under both codenames", () => {
    expect(mcpFlagAliases("session-id", acme)).toEqual(["--acme-session-id", "--jinn-session-id"]);
  });

  it("names the org key and the hook field after the codename", () => {
    expect(orgMcpKey(acme)).toBe("acmeMcp");
    expect(hookSessionIdKey(acme)).toBe("acmeSessionId");
  });

  it("reads a hook's session id from a relay of either build", () => {
    expect(readHookSessionId({ jinnSessionId: "s1", hook: {} }, acme)).toBe("s1");
    expect(readHookSessionId({ acmeSessionId: "s2", jinnSessionId: "s1" }, acme)).toBe("s2");
    expect(readHookSessionId({ acmeSessionId: "" }, acme)).toBeUndefined();
    expect(readHookSessionId({ acmeSessionId: 7 }, acme)).toBeUndefined();
    expect(readHookSessionId(null, acme)).toBeUndefined();
  });
});
