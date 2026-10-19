import { randomBytes } from "node:crypto";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { logger } from "../shared/logger.js";

/**
 * A client for the Muse Session Protocol (MSP): JSON-RPC 2.0, one JSON object
 * per line, over a child's stdin and stdout.
 *
 * Nothing here knows what a Muse turn is. It frames and correlates messages,
 * so the turn engine and anything else that needs a short-lived `muse serve`
 * (model discovery, usage reads) share one transport. The child process that
 * carries it, and its shutdown, are `musecode-process.ts`.
 *
 * Three kinds of message arrive on stdout:
 *   - a response, which resolves the request it carries the id of;
 *   - a notification, which is handed to the notification handler;
 *   - a request FROM the server (`approval/request`, `userInput/request`), which
 *     the server-request handler answers. The answer is the protocol's
 *     presentation receipt only: the decision itself travels as a client command.
 */

const JSONRPC = "2.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** JSON-RPC error codes this client produces itself. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** A JSON-RPC error response: the server's code, message and `data`. */
export class MspError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "MspError";
    this.code = code;
    this.data = data;
  }

  /** The server's typed failure class (`data.kind`, e.g. `sessionNotFound`). */
  get kind(): string | undefined {
    const kind = this.data?.kind;
    return typeof kind === "string" ? kind : undefined;
  }
}

/** The connection ended (child exited, stdout closed, client closed) with the request unanswered. */
export class MspClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MspClosedError";
  }
}

export class MspTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`MSP request ${method} timed out after ${timeoutMs} ms`);
    this.name = "MspTimeoutError";
  }
}

export type MspNotificationHandler = (method: string, params: Record<string, unknown>) => void;
/** Answers a server-initiated request with its result. Throwing answers with an error. */
export type MspServerRequestHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface MspRequestOptions {
  /** Reject if no response arrives in this long. Defaults to two minutes. */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface MspClientInfo {
  name: string;
  version: string;
}

export interface MspInitializeOptions {
  clientInfo: MspClientInfo;
  /** `false` makes the server withhold `userInput/request`. */
  userInputDialogs?: boolean;
  /** Capabilities to ask the host for (`sessionMcp`, say). The ones it grants come back in `grantedCapabilities`. */
  requestedCapabilities?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A UUIDv7 (RFC 9562): a millisecond timestamp, then random bits. MSP wants one as every command's `commandId`. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class MspClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly lines: readline.Interface;
  private notificationHandler: MspNotificationHandler | undefined;
  private serverRequestHandler: MspServerRequestHandler | undefined;
  private closedReason: string | undefined;
  private readonly closeListeners: Array<(reason: string) => void> = [];

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    this.lines = readline.createInterface({ input: output, terminal: false });
    this.lines.on("line", (line) => this.readLine(line));
    this.lines.on("close", () => this.close("MSP output closed"));
    // A write to a child that has already died raises EPIPE; the close path
    // reports the real failure.
    this.input.on("error", (err: Error) => {
      logger.debug(`MSP input error: ${err.message}`);
      this.close(`MSP input failed: ${err.message}`);
    });
  }

  /** Receives every notification. Set before the first request, or early ones are missed. */
  onNotification(handler: MspNotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: MspServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Called once when the connection ends, with why. Runs immediately if it already has. */
  onClose(listener: (reason: string) => void): void {
    if (this.closedReason !== undefined) listener(this.closedReason);
    else this.closeListeners.push(listener);
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** `initialize`, then the `initialized` notification. Every other method answers `notInitialized` before this. */
  async initialize(opts: MspInitializeOptions): Promise<Record<string, unknown>> {
    const capabilities = {
      ...(opts.userInputDialogs === undefined ? {} : { userInputDialogs: opts.userInputDialogs }),
      ...(opts.requestedCapabilities?.length ? { requestedCapabilities: opts.requestedCapabilities } : {}),
    };
    const result = await this.request("initialize", {
      clientInfo: opts.clientInfo,
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    });
    this.notify("initialized", {});
    return asRecord(result) ?? {};
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, opts: MspRequestOptions = {}): Promise<T> {
    if (this.closedReason !== undefined) return Promise.reject(new MspClosedError(`${this.closedReason} (before ${method})`));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new MspTimeoutError(method, timeoutMs));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: JSONRPC, id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closedReason !== undefined) return;
    this.write({ jsonrpc: JSONRPC, method, params });
  }

  /** End the child's stdin, which is how `muse serve` is told to shut down. */
  end(): void {
    try {
      this.input.end();
    } catch {
      /* already closed */
    }
  }

  /** Reject everything outstanding and stop reading. Idempotent. */
  close(reason = "MSP client closed"): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    try {
      this.lines.close();
    } catch {
      /* ignore */
    }
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new MspClosedError(`${reason} (while waiting for ${entry.method})`));
    }
    for (const listener of this.closeListeners.splice(0)) listener(reason);
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.input.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      logger.debug(`MSP write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private readLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(trimmed));
    } catch {
      logger.debug(`MSP unparseable line: ${trimmed.slice(0, 100)}`);
      return;
    }
    if (!message) return;
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = message.id;
    if (method === undefined) {
      if (typeof id === "number") this.settleResponse(id, message);
      return;
    }
    const params = asRecord(message.params) ?? {};
    if (id === undefined || id === null) this.dispatchNotification(method, params);
    else void this.answerServerRequest(id, method, params);
  }

  private settleResponse(id: number, message: Record<string, unknown>): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const error = asRecord(message.error);
    if (error) {
      const code = typeof error.code === "number" ? error.code : INTERNAL_ERROR;
      const text = typeof error.message === "string" ? error.message : `MSP error ${code}`;
      entry.reject(new MspError(code, text, asRecord(error.data)));
      return;
    }
    entry.resolve(message.result ?? {});
  }

  private dispatchNotification(method: string, params: Record<string, unknown>): void {
    if (!this.notificationHandler) return;
    try {
      this.notificationHandler(method, params);
    } catch (err) {
      // A handler that throws must not take the reader with it: the next line is a different event.
      logger.warn(`MSP notification handler threw on ${method}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async answerServerRequest(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
    const reply = (body: Record<string, unknown>) => this.write({ jsonrpc: JSONRPC, id, ...body });
    if (!this.serverRequestHandler) {
      reply({ error: { code: METHOD_NOT_FOUND, message: `no handler for ${method}` } });
      return;
    }
    try {
      reply({ result: (await this.serverRequestHandler(method, params)) ?? {} });
    } catch (err) {
      reply({ error: { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
