import type { EngineName } from "./models.js";

/**
 * `engines.musecode`: Muse Code (`muse` CLI). `bin` is optional and PATH-resolved.
 * `model` is a Muse catalog id (`muse-spark-1.2`); `effortLevel` rides on each
 * turn as `reasoningEffort`.
 */
export interface MusecodeEngineConfig {
  bin?: string;
  model?: string;
  effortLevel?: string;
  childEffortOverride?: string;
  fallback?: EngineName[];
  fallbackModelMap?: Record<string, string>;
}
