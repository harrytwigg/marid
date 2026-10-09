import type {
  Employee,
  Engine,
  JinnConfig,
  OrgHierarchy,
  Session,
  StreamDelta,
} from "../../shared/types.js";
import type { UpdateSessionFields } from "../registry.js";

/** Org orientation for a turn, or the reason the roster could not be read. */
export interface TurnHierarchy {
  hierarchy?: OrgHierarchy;
  /** Why the roster is missing, when it is. Never swallowed — the prompt says so. */
  unavailable?: string;
}

/** What a settled turn reports outward once its receipt is written. */
export interface TurnReceipt {
  session: Session;
  result: string | null;
  error: string | null;
  cost?: number;
  durationMs?: number;
}

/**
 * The only seam between a turn and the transport carrying it. The connector
 * runner and the web runner are the same code and differ ONLY in which
 * implementation of this they hand to `runTurn`; the status reconciler is a
 * third consumer that never enters `runTurn` at all, settling a turn whose
 * runner is already gone through this same seam.
 */
export interface TurnSurface {
  /** The turn is live: show whatever "working" affordance the transport has. */
  started(): Promise<void>;
  /** One engine stream block. Transports without a live view ignore it. */
  delta(delta: StreamDelta): void;
  /** Lifecycle prose that is not the answer — rate-limit banners, warnings. */
  notice(text: string): Promise<void>;
  /** Deliver text to the human channel. Never throws; delivery is best-effort. */
  reply(text: string): Promise<void>;
  /** Enter (true) or leave (false) the rate-limit waiting affordance. */
  waiting(active: boolean): Promise<void>;
  /** A terminal receipt was written: clear affordances, publish completion. */
  settled(receipt: TurnReceipt): Promise<void>;
}

/** Everything one turn needs that the transport adapter must supply. */
export interface TurnInput {
  /** Live session with its attempt already begun by the caller. */
  session: Session;
  attemptToken: string;
  prompt: string;
  attachments: string[];
  employee?: Employee;
  config: JinnConfig;
  engines: Map<string, Engine>;
  /** Overrides the engine-map lookup — the web CLI view's PTY-backed engine. */
  engineOverride?: Engine;
  gatewayBootId: string;
  /** Connector ids offered to the system prompt. */
  connectorNames: string[];
  /** Org orientation for the system prompt, or the reason there is none. */
  roster?: TurnHierarchy;
  /** Where the turn appears to the engine. */
  channel: string;
  thread?: string;
  user: string;
  channelName?: string;
  /**
   * Transport fields folded into the terminal write, re-read at settle time so
   * a connector turn records the freshest merged transportMeta. Web turns carry
   * none: their reply context never moves mid-turn.
   */
  terminalFields?: () => UpdateSessionFields;
  /**
   * Whether to announce the pre-run "you may be near a Claude usage limit"
   * heads-up. Connector turns announce it unless they are cron; web turns never
   * do, because the dashboard already shows the limit state.
   */
  announceUsageWarnings?: boolean;
}

/** A preflight that refused to run the turn, with the error it settles as. */
export interface TurnAbort {
  ok: false;
  error: string;
  /** Answered without running the engine, and not a failure: the turn settles
   *  as succeeded with `error` shown as a notice (an operator `/compact` the
   *  session's engine cannot run). */
  declined?: boolean;
}

/** Everything preflight resolved, ready for `engine.run`. */
export interface TurnPlan {
  ok: true;
  engine: Engine;
  /** Engine name at turn start; stale results from any other engine are dropped. */
  engineName: string;
  engineConfig: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
  effortLevel?: string;
  model?: string;
  resumeSessionId?: string;
  /** Resume ref captured at turn start, so a mid-turn write cannot alter it. */
  resumeNativeId?: string;
  mcpConfigPath?: string;
  resolvedMcp?: import("../../shared/types.js").ResolvedMcpConfig;
  runtimeSource: string;
  /** Prompt actually sent — may carry a synthesized engine-switch transcript. */
  promptToRun: string;
  /** True when the prompt carries a sync transcript whose markers settle clears. */
  syncRequested: boolean;
  /** True when the prompt carries messages an interrupt kept from the engine. */
  carriedInterruptedPrompts: boolean;
  /** Appended to the prompt when the engine is called (board-reminder.ts); undefined carries none. */
  boardReminder?: string;
  /** This turn is `/compact`: the engine's own compaction, not a prompt. */
  compaction: boolean;
  /** Built per model attempt, because a model fallback re-fingerprints context. */
  prepareContext: (model: string | undefined) => {
    fingerprint: string;
    refresh: string | undefined;
    systemPrompt: string;
  };
}

export type TurnPreflight = TurnPlan | TurnAbort;

/** One turn's resolved plan, live machinery, and transport, threaded together. */
export interface TurnRun {
  input: TurnInput;
  plan: TurnPlan;
  surface: TurnSurface;
  heartbeat: import("./heartbeat.js").TurnHeartbeat;
  partialStream: import("../partial-stream.js").PartialStreamWriter;
  turnStartedAt: number;
  terminalFields: () => UpdateSessionFields;
}
