/**
 * Fake `ws` transport shared by the OpenAI realtime suites.
 *
 * Stands in for a socket so the adapter's protocol translation can be driven
 * with the exact frames the live Realtime API emits. Hand-rolled rather than an
 * EventEmitter subclass so a test can assert on `sent` and replay frames in a
 * single tick.
 *
 * Suites wire it up with `vi.mock("ws", async () => ({ default: (await
 * import("./helpers/fake-realtime-socket.js")).FakeSocket }))`. The factory
 * imports this module rather than closing over the suite's own import binding,
 * because `vi.mock` is hoisted above every import in the calling file. Nothing
 * here imports the adapter at module scope for the same reason: that would pull
 * `ws` back in while its mock factory is still resolving.
 */
import type { RealtimeEvent, RealtimeProvider, RealtimeSessionOptions } from "../../../../shared/voice.js";

type Listener = (...args: never[]) => void;

export class FakeSocket {
  static last: FakeSocket | undefined;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  on(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  once(event: string, listener: Listener): void {
    const wrapped = (...args: never[]): void => {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== wrapped));
      listener(...args);
    };
    this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...(args as never[]));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", 1000, Buffer.from(""));
  }
}

/** Drop the socket left behind by the previous test, so `lastSocket` cannot
 *  silently assert against a stale connection. */
export function resetSocket(): void {
  FakeSocket.last = undefined;
}

export function lastSocket(): FakeSocket {
  const socket = FakeSocket.last;
  if (!socket) throw new Error("the adapter never opened a socket");
  return socket;
}

export function receive(message: unknown): void {
  lastSocket().emit("message", Buffer.from(JSON.stringify(message)));
}

export function sentTypes(): string[] {
  return lastSocket().sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

/** True once `promise` has settled, without leaving it unhandled either way.
 *  The marker is a timer rather than a resolved promise so every pending
 *  microtask drains first, otherwise a just-settled promise still reads pending. */
export async function settled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const marker = new Promise((resolve) => setTimeout(() => resolve(pending), 0));
  return (await Promise.race([promise.catch(() => undefined), marker])) !== pending;
}

/** The adapter, resolved lazily so the mocked `ws` is in place first. */
export async function realtimeAdapter(): Promise<typeof import("../../openai.js")> {
  return await import("../../openai.js");
}

/** Connect a provider against the fake transport and collect everything it emits. */
export async function connected(
  options: RealtimeSessionOptions = {},
): Promise<{ provider: RealtimeProvider; events: RealtimeEvent[] }> {
  const { createOpenAiRealtimeProvider } = await realtimeAdapter();
  const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
  const events: RealtimeEvent[] = [];
  provider.on((event) => events.push(event));
  const connecting = provider.connect(options);
  lastSocket().emit("open");
  receive({ type: "session.updated" });
  await connecting;
  return { provider, events };
}
