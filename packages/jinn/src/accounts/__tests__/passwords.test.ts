import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HASH_MAX_QUEUED, HASH_MAX_RUNNING, HashBusyError, SCRYPT_MAXMEM, SCRYPT_N, createHashLimiter, hashPassword,
  passwordProblem, verifyAgainstDummy, verifyPassword,
} from "../passwords.js";

describe("scrypt parameters on the pinned Node", () => {
  it("hashes at N=2^15 r=8 p=1 with a 64 MiB maxmem, in the documented stored form", async () => {
    const stored = await hashPassword("a perfectly fine password");
    const [scheme, n, r, p, salt, key] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect([Number(n), Number(r), Number(p)]).toEqual([32768, 8, 1]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(key!, "base64url")).toHaveLength(64);
    expect(SCRYPT_MAXMEM).toBe(64 * 1024 * 1024);
    expect(await verifyPassword("a perfectly fine password", stored)).toBe(true);
    expect(await verifyPassword("a perfectly fine passwore", stored)).toBe(false);
  });

  it("needs the raised maxmem: Node's default limit throws at these parameters", async () => {
    const attempt = (maxmem?: number) => new Promise<void>((resolve, reject) => {
      crypto.scrypt("pw", Buffer.alloc(16), 64, { N: SCRYPT_N, r: 8, p: 1, ...(maxmem ? { maxmem } : {}) }, (e) => (e ? reject(e) : resolve()));
    });
    await expect(attempt()).rejects.toThrow(/memory limit/i);
    await expect(attempt(SCRYPT_MAXMEM)).resolves.toBeUndefined();
  });

  it("treats a malformed or over-cost stored hash as a mismatch rather than running it", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1048576$8$1$c2FsdA$a2V5")).toBe(false);
    expect(await verifyPassword("x", `scrypt$32768$8$4$c2FsdA$${Buffer.alloc(64).toString("base64url")}`)).toBe(false);
  });

  it("enforces 12 to 256 characters and no composition rules", () => {
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem("x".repeat(257))).toMatch(/at most 256/);
    expect(passwordProblem("aaaaaaaaaaaa")).toBeNull();
    expect(passwordProblem(undefined)).toMatch(/required/);
  });
});

describe("the global hashing cap", () => {
  it("runs 2 at once, queues 16, and refuses the next with HashBusyError", async () => {
    expect([HASH_MAX_RUNNING, HASH_MAX_QUEUED]).toEqual([2, 16]);
    const limiter = createHashLimiter();
    const gates: Array<() => void> = [];
    const task = () => new Promise<void>((resolve) => gates.push(resolve));
    const accepted = Array.from({ length: 18 }, () => limiter.run(task));
    await Promise.resolve();
    expect(limiter.stats()).toEqual({ running: 2, queued: 16 });
    await expect(limiter.run(task)).rejects.toBeInstanceOf(HashBusyError);
    let settled = 0;
    accepted.forEach((p) => void p.then(() => { settled += 1; }));
    while (settled < 18) {
      gates.splice(0).forEach((open) => open());
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(accepted);
    expect(limiter.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("never has more than 2 running, even when a caller arrives as a slot is handed on", async () => {
    const limiter = createHashLimiter(2, 16);
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
    };
    const calls = [limiter.run(task), limiter.run(task), limiter.run(task)];
    await new Promise((r) => setImmediate(r));
    gates.shift()!(); // the first finishes: its slot goes to the waiting third
    calls.push(limiter.run(task)); // arrives in the gap a decrement-then-wake release left open
    calls.push(limiter.run(task));
    await new Promise((r) => setImmediate(r));
    expect(peak).toBeLessThanOrEqual(2);
    let settled = 0;
    calls.forEach((p) => void p.then(() => { settled += 1; }));
    while (settled < calls.length) { gates.splice(0).forEach((open) => open()); await new Promise((r) => setImmediate(r)); }
    expect(peak).toBe(2);
    expect(limiter.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("releases its slot when a task throws", async () => {
    const limiter = createHashLimiter(1, 0);
    await expect(limiter.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("the dummy hash", () => {
  it("spends one real hash and is always false", async () => {
    const limiter = createHashLimiter();
    const run = vi.spyOn(limiter, "run");
    expect(await verifyAgainstDummy("anything at all", limiter)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
