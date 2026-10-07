import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMcpServerBootstrap } from "../server-bootstrap.js";
import { ensureSessionCapability, JINN_SESSION_CAPABILITY_ENV, JINN_SESSION_ID_ENV, verifySessionCapability } from "../identity.js";
import { resolveMcpSessionCapabilityKeyFile } from "../../shared/home.js";

const argv = (home: string, sessionId = "session-hermes") => [
  "--jinn-session-id", sessionId,
  "--jinn-home", home,
  "--jinn-gateway-url", "http://127.0.0.1:7801",
];

describe("resolveMcpServerBootstrap", () => {
  let home: string;
  let gatewayHome: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-bootstrap-"));
    gatewayHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-bootstrap-gateway-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(gatewayHome, { recursive: true, force: true });
  });

  it("recovers a complete scoped identity from non-secret argv when the engine strips all env, from the home's existing key", () => {
    // The gateway minted the key in its home; the server derives the same capability from it.
    const minted = ensureSessionCapability("session-hermes", resolveMcpSessionCapabilityKeyFile(home));

    const result = resolveMcpServerBootstrap(argv(home), {});

    expect(result).toMatchObject({
      callerSessionId: "session-hermes",
      gatewayUrl: "http://127.0.0.1:7801",
      jinnHome: home,
      sessionCapability: minted,
    });
    expect(verifySessionCapability("session-hermes", result.sessionCapability!, resolveMcpSessionCapabilityKeyFile(home))).toBe(true);
  });

  it("prefers the capability the gateway stamped on the env for the same session over the home's key", () => {
    const stamped = ensureSessionCapability("session-hermes", resolveMcpSessionCapabilityKeyFile(gatewayHome));
    // A key of the home's own, one the gateway does not hold (a stray an older server minted).
    ensureSessionCapability("session-hermes", resolveMcpSessionCapabilityKeyFile(home));

    const result = resolveMcpServerBootstrap(argv(home), {
      [JINN_SESSION_ID_ENV]: "session-hermes",
      [JINN_SESSION_CAPABILITY_ENV]: stamped,
    });

    expect(result.sessionCapability).toBe(stamped);
  });

  it("takes the stamped capability from a home with no key, and never creates one there", () => {
    const stamped = ensureSessionCapability("session-hermes", resolveMcpSessionCapabilityKeyFile(gatewayHome));

    const result = resolveMcpServerBootstrap(argv(home), {
      [JINN_SESSION_ID_ENV]: "session-hermes",
      [JINN_SESSION_CAPABILITY_ENV]: stamped,
    });

    expect(result.sessionCapability).toBe(stamped);
    expect(fs.existsSync(resolveMcpSessionCapabilityKeyFile(home))).toBe(false);
  });

  it("has no capability when the env carries none and the home has no key, and creates none", () => {
    const result = resolveMcpServerBootstrap(argv(home), {});

    expect(result.callerSessionId).toBe("session-hermes");
    expect(result.sessionCapability).toBeUndefined();
    expect(fs.existsSync(resolveMcpSessionCapabilityKeyFile(home))).toBe(false);
  });

  it("ignores a stamped capability that belongs to another session", () => {
    const minted = ensureSessionCapability("session-hermes", resolveMcpSessionCapabilityKeyFile(home));
    const other = ensureSessionCapability("session-other", resolveMcpSessionCapabilityKeyFile(gatewayHome));

    const result = resolveMcpServerBootstrap(argv(home), {
      [JINN_SESSION_ID_ENV]: "session-other",
      [JINN_SESSION_CAPABILITY_ENV]: other,
    });

    expect(result.sessionCapability).toBe(minted);
  });
});
