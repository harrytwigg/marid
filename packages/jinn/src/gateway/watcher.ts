import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { CONFIG_PATH, CRON_JOBS, JINN_HOME, ORG_DIR, PLUGINS_DIR, SKILLS_DIR, CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface WatcherCallbacks {
  onConfigReload: () => void;
  onCronReload: () => void;
  onOrgChange: () => void;
  onSkillsChange: () => void;
  /** A department's `INSTRUCTIONS.md` was added, edited or removed: its stage directory is regenerated from it. */
  onDepartmentInstructionsChange: () => void;
  onPluginsChange: () => void;
}

let watchers: FSWatcher[] = [];
let pluginsDebounce: Debounced | null = null;

/** A debounced call whose pending timer can be cancelled from outside the closure. */
export type Debounced = (() => void) & { cancel: () => void };

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  schedule.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return schedule;
}

/**
 * Sync symlinks in .claude/skills/ and .agents/skills/ to match skills/.
 * Each skill directory gets a relative symlink: ../../skills/<name>
 */
export function syncSkillSymlinks(): void {
  const targetDirs = [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR];

  // Get current skill directories
  let skillNames: string[] = [];
  if (fs.existsSync(SKILLS_DIR)) {
    skillNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  for (const targetDir of targetDirs) {
    fs.mkdirSync(targetDir, { recursive: true });

    // Remove stale symlinks
    const existing = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of existing) {
      if (!skillNames.includes(entry.name)) {
        const linkPath = path.join(targetDir, entry.name);
        try {
          fs.unlinkSync(linkPath);
          logger.debug(`Removed stale skill symlink: ${linkPath}`);
        } catch {
          // ignore
        }
      }
    }

    // Create missing symlinks (with copy fallback for Windows without Developer Mode)
    for (const name of skillNames) {
      const linkPath = path.join(targetDir, name);
      const relTarget = path.join("..", "..", "skills", name);
      const absTarget = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(linkPath)) {
        try {
          fs.symlinkSync(relTarget, linkPath);
          logger.debug(`Created skill symlink: ${linkPath} -> ${relTarget}`);
        } catch {
          try {
            fs.cpSync(absTarget, linkPath, { recursive: true });
            logger.debug(`Copied skill (symlink unavailable): ${linkPath}`);
          } catch {
            // ignore — skill won't be discoverable from this path
          }
        }
      }
    }
  }
}

/** Directories a plugin carries but does not consist of: the dependencies it was
 *  installed with, and the checkout it came from. Both are large, both change
 *  without the plugin changing, and watching either only costs handles. */
const UNWATCHED_PLUGIN_DIRS = new Set(["node_modules", ".git"]);

/** Read relative to the plugins root, so a home that happens to sit under a path
 *  with one of those names is still watched. Exported for the test that holds the
 *  set to what it claims, rather than measuring it through the filesystem. */
export function isUnwatchedPluginPath(target: string): boolean {
  return path
    .relative(PLUGINS_DIR, target)
    .split(path.sep)
    .some((segment) => UNWATCHED_PLUGIN_DIRS.has(segment));
}

/** Whether `target` is `knowledge/departments` itself, something inside it, or a parent of it: the paths the instructions watcher has to walk through. */
export function isDepartmentInstructionsPath(target: string, departmentsDir: string): boolean {
  const rel = path.relative(departmentsDir, target);
  const walkingDown = path.relative(target, departmentsDir);
  return (!rel.startsWith("..") && !path.isAbsolute(rel)) || (!walkingDown.startsWith("..") && !path.isAbsolute(walkingDown));
}

/**
 * A department's instructions become its stage directory's CLAUDE.md (FR-029), so an edit
 * to `knowledge/departments/<slug>/INSTRUCTIONS.md` regenerates it. Only that subtree is
 * walked, and only that file triggers: a scoped session writing its own notes there is not
 * a change. An instance with no `knowledge/` has nothing to watch; the stage directory is
 * synced before every scoped spawn regardless.
 */
function watchDepartmentInstructions(onChange: () => void, debounceMs: number): FSWatcher | null {
  const knowledgeDir = path.join(JINN_HOME, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return null;
  const departmentsDir = path.join(knowledgeDir, "departments");
  const changed = debounce(() => {
    logger.info("A department's INSTRUCTIONS.md changed, regenerating its stage directory...");
    onChange();
  }, debounceMs);
  const instructionsWatcher = watch(knowledgeDir, {
    ignoreInitial: true,
    depth: 2,
    ignored: (target) => !isDepartmentInstructionsPath(target, departmentsDir),
  });
  instructionsWatcher.on("all", (_event, target) => {
    if (path.basename(target) === "INSTRUCTIONS.md") changed();
  });
  return instructionsWatcher;
}

export function startWatchers(callbacks: WatcherCallbacks): void {
  const DEBOUNCE_MS = 500;

  const configWatcher = watch(CONFIG_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  configWatcher.on(
    "change",
    debounce(() => {
      logger.info("config.yaml changed, reloading...");
      callbacks.onConfigReload();
    }, DEBOUNCE_MS),
  );

  const cronWatcher = watch(CRON_JOBS, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  cronWatcher.on(
    "change",
    debounce(() => {
      logger.info("cron/jobs.json changed, reloading...");
      callbacks.onCronReload();
    }, DEBOUNCE_MS),
  );

  const orgWatcher = watch(ORG_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  orgWatcher.on(
    "all",
    debounce(() => {
      logger.info("org/ directory changed, reloading...");
      callbacks.onOrgChange();
    }, DEBOUNCE_MS),
  );

  // Watch skills/ directory for added/removed skill folders → sync symlinks
  const skillsWatcher = watch(SKILLS_DIR, {
    ignoreInitial: true,
    depth: 0,
  });
  skillsWatcher.on(
    "all",
    debounce(() => {
      logger.info("skills/ directory changed, syncing symlinks...");
      syncSkillSymlinks();
      callbacks.onSkillsChange();
    }, DEBOUNCE_MS),
  );

  const instructionsWatcher = watchDepartmentInstructions(callbacks.onDepartmentInstructionsChange, DEBOUNCE_MS);

  // Plugins arrive by having a directory dropped into the instance home, and
  // their code lives inside it — server.js at the plugin root, or wherever its
  // manifest points. So this one goes the whole way down, unlike skills/: an edit
  // to a plugin's backend is a new incarnation, and nothing else would see it.
  // Make the root so a new instance can discover its first plugin.
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const pluginsWatcher = watch(PLUGINS_DIR, {
    ignoreInitial: true,
    ignored: isUnwatchedPluginPath,
  });
  pluginsDebounce = debounce(() => {
    logger.info("plugins/ directory changed, rescanning...");
    callbacks.onPluginsChange();
  }, DEBOUNCE_MS);
  pluginsWatcher.on("all", pluginsDebounce);

  watchers = [configWatcher, cronWatcher, orgWatcher, skillsWatcher, ...(instructionsWatcher ? [instructionsWatcher] : []), pluginsWatcher];
  logger.info("File watchers started");
}

export async function stopWatchers(): Promise<void> {
  // Closing a chokidar watcher does not disarm a debounce already counting down,
  // so without this a change landing inside the window fires a rescan into a
  // torn-down gateway and keeps the event loop alive.
  pluginsDebounce?.cancel();
  pluginsDebounce = null;
  await Promise.all(watchers.map((w) => w.close()));
  watchers = [];
  logger.info("File watchers stopped");
}
