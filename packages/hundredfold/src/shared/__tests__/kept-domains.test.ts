import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../../accounts/ids.js";
import { consumeLocalBootstrapGrant, verifyAuthSession } from "../../gateway/auth.js";
import { deriveExistingSessionCapability } from "../../mcp/identity.js";

// Every value here was produced by a build from before the rename. A credential, a paired device or a capability
// that such a build stored or handed out must keep verifying, so these may never change with the codename.

const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kept-domains-"));
  temp.push(dir);
  return dir;
};

describe("domain-separation strings that key stored values", () => {
  it("hashes member tokens and sessions as an older build did", () => {
    expect(hashToken("abc", "token")).toBe("d624cf88ef60d4605a2ffd02abb86b59a3c7366c59b93bdc0b480849be9a352b");
    expect(hashToken("abc", "session")).toBe("b1fcef3eccd247dffe22d4391b7bbfb9588bc77be005e0ac304efde39bec13ee");
  });

  it("still verifies a paired device an older build stored", () => {
    const home = tempDir();
    const now = new Date().toISOString();
    const device = { id: "d_old", name: "laptop", kind: "remote", createdAt: now, lastSeenAt: now, tokenHash: "UWiPIBfukyRf7pFcOTYqWzoiHHfBROofA8aWmmLI5jM" };
    fs.writeFileSync(path.join(home, "auth-devices.json"), JSON.stringify({ devices: [device] }));
    expect(verifyAuthSession(home, "d_old", "secret-value")).toBe(true);
    expect(verifyAuthSession(home, "d_old", "another-secret")).toBe(false);
  });

  it("still consumes a local bootstrap grant hashed as an older build did", () => {
    const store = new Map([["cBkjiT2gUPB938yaFJliaUJbHe_vefqtPldsitjKHJQ", { expiresAt: Date.now() + 60_000 }]]);
    expect(consumeLocalBootstrapGrant("g".repeat(20), store)).toBe(true);
  });

  it("derives the MCP session capability an older gateway handed to a running server", () => {
    const dir = tempDir();
    const keyFile = path.join(dir, "mcp-session-capability.key");
    fs.writeFileSync(keyFile, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc\n", { mode: 0o600 });
    expect(deriveExistingSessionCapability("sess-1", keyFile)).toBe("JplCRxknb5L8x-q7Ifx_UIvQ9IlsLBSjvi_UUwDI2N8");
  });
});
