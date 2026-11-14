import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Every path a home fixture writes, so a restore can be compared entry by entry. */
export const HOME_CONTENT: Record<string, string> = {
  "config.yaml": "port: 7901\n",
  "cron/jobs.json": '{"jobs":[]}\n',
  "docs/overview.md": "# Overview\n",
  "knowledge/notes.md": "a durable note\n",
  "org/a-lead.yaml": "name: a-lead\n",
  "secrets/api-keys.json": '{"placeholder":"not-a-real-key"}\n',
  "skills/demo/SKILL.md": "---\nname: demo\n---\n",
};

/** Reproducible bulk the archive must leave behind. */
const HOME_JUNK: Record<string, string> = {
  "node_modules/left-pad/index.js": "module.exports = 1\n",
  "skills/demo/node_modules/dep/index.js": "module.exports = 2\n",
  "skills/demo/.git/config": "[core]\n",
  "skills/demo/.venv/pyvenv.cfg": "home = /usr\n",
  "skills/demo/__pycache__/mod.pyc": "bytecode\n",
  "tmp/scratch.txt": "scratch\n",
  "uploads/photo.bin": "binary\n",
};

function writeAll(home: string, entries: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(entries)) {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

/** A synthetic instance home: the content worth keeping, the bulk that is not,
 *  and a live WAL registry.db whose rows have never been checkpointed. */
export function makeHome(root: string, name: string, options: { registryRows?: number } = {}): string {
  const home = path.join(root, name);
  writeAll(home, HOME_CONTENT);
  writeAll(home, HOME_JUNK);

  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const db = new Database(path.join(home, "sessions", "registry.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO sessions (label) VALUES (?)");
    for (let i = 0; i < (options.registryRows ?? 12); i += 1) insert.run(`session-${i}`);
  } finally {
    db.close();
  }
  return home;
}

export function registryRowCount(file: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
  } finally {
    db.close();
  }
}
