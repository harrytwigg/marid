import type Database from "better-sqlite3";

// The plugin key/value store lives in the registry database rather than under
// PLUGINS_DIR: that directory is watched (gateway/watcher.ts), so a plugin
// writing a key would trip a debounced rescan of every plugin on the box.
const PLUGIN_KV_DDL = `
CREATE TABLE IF NOT EXISTS plugin_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
`;

export function migratePluginsSchema(db: Database.Database): void {
  db.exec(PLUGIN_KV_DDL);
}
