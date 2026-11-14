import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built-in hundredfold MCP server is started by opencode, which hands it its whole environment, the account keys included.
 * server-entry.js drops the variables HUNDREDFOLD_SCRUB_ENV lists before it serves. Spawned for real (the built launcher, as the
 * scrub-entry tests do); a preload records the environment the process still holds when it exits.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_ENTRY = path.resolve(HERE, "../../../dist/src/mcp/server-entry.js");

describe("server-entry.js (real spawn)", () => {
  it("serves with the account key variables an opencode parent lists, and the list, gone from its environment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-entry-scrub-"));
    const outFile = path.join(dir, "env.json");
    const preload = path.join(dir, "preload.mjs");
    fs.writeFileSync(preload, `import fs from "node:fs";
process.on("exit", () => fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
  a: process.env.ACME_LISTED_KEY_A ?? null,
  b: process.env.ACME_LISTED_KEY_B ?? null,
  list: process.env.HUNDREDFOLD_SCRUB_ENV ?? null,
  keep: process.env.ACME_UNLISTED ?? null,
})));`);
    try {
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [DIST_SERVER_ENTRY], {
          env: {
            ...process.env,
            NODE_OPTIONS: `--import ${preload}`,
            HUNDREDFOLD_GATEWAY_URL: "http://127.0.0.1:1",
            HUNDREDFOLD_GATEWAY_TOKEN: "unused",
            ACME_LISTED_KEY_A: "sk-a",
            ACME_LISTED_KEY_B: "sk-b",
            HUNDREDFOLD_SCRUB_ENV: "ACME_LISTED_KEY_A,ACME_LISTED_KEY_B",
            ACME_UNLISTED: "yes",
          },
          // stdin closed: the stdio server ends as soon as it has started.
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.on("exit", (c) => resolve(c ?? -1));
      });
      expect(code).toBe(0);
      expect(JSON.parse(fs.readFileSync(outFile, "utf-8"))).toEqual({ a: null, b: null, list: null, keep: "yes" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
