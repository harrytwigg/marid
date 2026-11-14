import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-claim-race-"));
process.env.HUNDREDFOLD_HOME = home;

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "fixtures", "claim-race-worker.mjs");
const claimsPath = path.resolve(here, "../../../dist/src/work-items/claims.js");
const RACERS = 8;

interface RaceResult {
  owner: string;
  state: string;
}

function race(workItemId: string, owner: string, startAt: number): Promise<RaceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, home, claimsPath, workItemId, owner, String(startAt)], {
      env: { ...process.env, HUNDREDFOLD_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claim racer ${owner} exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout) as RaceResult);
    });
  });
}

let workItemId: string;

beforeAll(async () => {
  const { createWorkItem } = await import("../store.js");
  workItemId = createWorkItem({ title: "Contended pickup", source: "human" }).id;
});

describe("claimWorkItem under real concurrency", () => {
  // Eight OS processes, one database, one Todo, all entering the claim at the
  // same wall-clock instant. Their reads are therefore all stale: a claim that
  // decides from a preceding SELECT tells several of them they won. Only a
  // compare-and-swap deciding on its own rowcount leaves exactly one winner.
  it("hands the Todo to exactly one of eight simultaneous owners", async () => {
    const startAt = Date.now() + 1_500;
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, index) => race(workItemId, `racer-${index}`, startAt)),
    );

    const acquired = results.filter((result) => result.state === "acquired");
    expect(acquired).toHaveLength(1);
    expect(results.filter((result) => result.state === "held")).toHaveLength(RACERS - 1);
  }, 30_000);
});
