import { isKnownEngine } from "../shared/models.js";
import type { ModelRegistry } from "../shared/types.js";

/**
 * The model registry as a chain walk reads it: an entry per known engine, whose
 * `available` means what the caller means by usable (registered with this
 * gateway and installed where the session runs), over the real registry's model
 * lists. Built lazily, one engine at a time: a chain names a few engines and the
 * check can probe.
 */
export function availabilityRegistry(base: ModelRegistry, isAvailable: (engine: string) => boolean): ModelRegistry {
  const memo = new Map<string, ModelRegistry[string] | undefined>();
  const entry = (name: string): ModelRegistry[string] | undefined => {
    if (!isKnownEngine(name)) return undefined;
    return { ...(base[name] ?? { models: [] }), available: isAvailable(name) } as ModelRegistry[string];
  };
  return new Proxy({} as ModelRegistry, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      if (!memo.has(name)) memo.set(name, entry(name));
      return memo.get(name);
    },
  });
}
