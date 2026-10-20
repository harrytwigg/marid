import { engineAvailable, engineSupportsRemote, isKnownEngine, type EngineName } from "../shared/models.js";
import type { JinnConfig, ModelRegistry } from "../shared/types.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";

/**
 * Whether `engine` is installed where a session runs: for one that runs on a
 * remote host (`destination`) and can go there, on that host as the facts
 * learned from its last spawn say, and a host not probed yet counts as having
 * it (the spawn then says if it does not); otherwise on this gateway.
 */
export function engineInstalledWhereRun(config: JinnConfig, engine: string, destination: string | undefined): boolean {
  if (destination && engineSupportsRemote(engine)) return remoteEngineAvailable(destination, engine) !== false;
  return engineAvailable(config, engine as EngineName);
}

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
