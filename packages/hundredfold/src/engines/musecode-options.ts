import type { RemoteExecutionConfig } from "../shared/config-types.js";
import type { ModelEffortLevels } from "./opencode-variant.js";
import type { MuseModelCost, MuseUsageSnapshot } from "./musecode-turn.js";

/** What the gateway builds a `MusecodeEngine` with. */
export interface MusecodeEngineOptions {
  /** Told of every subscription-usage snapshot a turn's host reports. */
  onUsage?: (usage: MuseUsageSnapshot) => void;
  /** The per-million-token rates of a model, once a catalog knows them. Without one a turn carries no cost. */
  modelCost?: (modelId: string | undefined) => MuseModelCost | undefined;
  /**
   * Called before a turn on a session that already has a conversation, to let go
   * of a terminal view that holds it: Muse refuses a second owner, so a turn
   * cannot resume a session its terminal has open.
   */
  releaseView?: (sessionId: string) => Promise<void>;
  /**
   * The levels the registry knows for a model (an unset model means the engine's default), read per turn.
   * A turn sends `reasoningEffort` only when its own model lists it. Without this, any level in Muse's vocabulary is sent.
   */
  effortLevels?: () => ModelEffortLevels;
  /** The `remote` block, read per turn so a config reload reaches the next one. A remote employee's turn needs it to run on its host. */
  remote?: () => RemoteExecutionConfig | undefined;
  /** The gateway's port, which a remote turn's reverse tunnel forwards to. */
  gatewayPort?: () => number;
  /** How long an accepted turn may go unheard before it is given up on. Defaults to the watchdog's `FIRST_EVENT_TIMEOUT_MS`. */
  firstEventTimeoutMs?: number;
}
