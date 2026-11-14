import { initDb } from "../shared/db.js";

/**
 * The key/value store one plugin sees. Every method is already bound to the
 * plugin it was made for, so no call takes an id: a plugin cannot name another
 * plugin's namespace because there is nowhere in this interface to put one.
 */
export interface PluginStorage {
  /** The stored value, or undefined when this plugin has never written that key. */
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** This plugin's keys, in insertion-independent alphabetical order. */
  keys(): string[];
}

/** The store for one plugin id, with the id closed over rather than passed in. */
export function pluginStorage(id: string): PluginStorage {
  return {
    get(key) {
      const row = initDb()
        .prepare("SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?")
        .pluck()
        .get(id, key) as string | undefined;
      return row === undefined ? undefined : JSON.parse(row);
    },
    set(key, value) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        // JSON.stringify returns undefined for undefined, functions and symbols.
        // Saying so beats better-sqlite3's "Invalid value" on the bind below.
        throw new TypeError(`plugin storage values must be JSON-serializable; set("${key}") got ${typeof value}`);
      }
      initDb()
        .prepare(
          "INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?) " +
            "ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
        )
        .run(id, key, encoded);
    },
    delete(key) {
      initDb().prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?").run(id, key);
    },
    keys() {
      return initDb()
        .prepare("SELECT key FROM plugin_kv WHERE plugin_id = ? ORDER BY key")
        .pluck()
        .all(id) as string[];
    },
  };
}
