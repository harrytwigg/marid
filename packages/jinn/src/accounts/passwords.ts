import crypto from "node:crypto";

/**
 * Password hashing for user accounts (docs/design/board-members.md, "Passwords").
 *
 * Node's built-in async scrypt at N = 2^15, r = 8, p = 1. That needs ~32 MiB per hash, and the
 * default `maxmem` (32 MiB) throws at these parameters, so `maxmem` is raised to 64 MiB. Stored as
 * `scrypt$<N>$<r>$<p>$<salt>$<key>` (base64url) so a later parameter change can still verify old hashes.
 *
 * A hash costs ~120 ms and ~32 MiB, and per-address rate limits alone do not bound attempts spread
 * over many addresses, so every hash goes through one process-wide limiter: at most two run at once
 * and at most sixteen wait. Past that the caller is told to come back later.
 */

export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_BYTES = 64;
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const HASH_MAX_RUNNING = 2;
export const HASH_MAX_QUEUED = 16;

/** Thrown when the hashing queue is full. The route answers 429 with `Retry-After`. */
export class HashBusyError extends Error {
  readonly retryAfterSeconds = 2;
  constructor() {
    super("Too many sign-in attempts in progress");
    this.name = "HashBusyError";
  }
}

export interface HashLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running now and tasks waiting, for tests and diagnostics. */
  stats(): { running: number; queued: number };
}

export function createHashLimiter(maxRunning = HASH_MAX_RUNNING, maxQueued = HASH_MAX_QUEUED): HashLimiter {
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return {
    stats: () => ({ running, queued: waiting.length }),
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= maxRunning) {
        if (waiting.length >= maxQueued) throw new HashBusyError();
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      running += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** The limiter every account hash goes through. */
export const globalHashLimiter: HashLimiter = createHashLimiter();

function scryptKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_BYTES, { N: n, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required";
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}

export async function hashPassword(password: string, limiter: HashLimiter = globalHashLimiter): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const key = await limiter.run(() => scryptKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P));
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

interface ParsedHash { n: number; r: number; p: number; salt: Buffer; key: Buffer }

/** Never run a stored cost above ours: a corrupted row must not become a memory or CPU lever. */
function costAllowed(n: number, r: number, p: number): boolean {
  if (![n, r, p].every(Number.isInteger)) return false;
  return n >= 2 && n <= SCRYPT_N && (n & (n - 1)) === 0 && r >= 1 && r <= SCRYPT_R && p >= 1 && p <= SCRYPT_P;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])] as [number, number, number];
  if (!costAllowed(n, r, p)) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  return salt.length === 0 || key.length !== SCRYPT_KEY_BYTES ? null : { n, r, p, salt, key };
}

/** Whether `password` matches `stored`. A malformed `stored` is a mismatch, not an error. */
export async function verifyPassword(password: string, stored: string, limiter: HashLimiter = globalHashLimiter): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await limiter.run(() => scryptKey(password, parsed.salt, parsed.n, parsed.r, parsed.p));
  return crypto.timingSafeEqual(candidate, parsed.key);
}

let dummyHash: Promise<string> | null = null;

/**
 * Spend one hash against a fixed dummy, so a sign-in for an unknown or disabled address takes as long as
 * one for a real account. Always false.
 */
export async function verifyAgainstDummy(password: string, limiter: HashLimiter = globalHashLimiter): Promise<false> {
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString("base64url"), createHashLimiter(1, 1));
  await verifyPassword(password, await dummyHash, limiter);
  return false;
}
