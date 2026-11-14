import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveClaudeConfigDir } from "../shared/home.js";

/**
 * Every Claude Code config directory a home's sessions may have written transcripts under: the gateway's
 * own profile, each declared Claude account, and each employee's own profile. Read from the home's files
 * rather than from the running gateway's registry, so it works before the gateway has started and
 * before this process has settled which home it belongs to.
 */

function readYaml(file: string): unknown {
  try {
    return yaml.load(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function absoluteDir(value: unknown): string | undefined {
  return typeof value === "string" && path.isAbsolute(value.trim()) ? value.trim() : undefined;
}

function accountDirs(home: string): string[] {
  const accounts = record(record(record(readYaml(path.join(home, "config.yaml")))?.engines)?.claude)?.accounts;
  return Object.values(record(accounts) ?? {}).flatMap((entry) => {
    // A remote account's directory is on another host, not a profile directory of this one.
    if (record(entry)?.remoteHost !== undefined) return [];
    const dir = absoluteDir(record(entry)?.configDir);
    return dir ? [dir] : [];
  });
}

function employeeDirs(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return employeeDirs(full);
    if (!/\.ya?ml$/.test(entry.name)) return [];
    const dir = absoluteDir(record(readYaml(full))?.claudeConfigDir);
    return dir ? [dir] : [];
  });
}

export function claudeConfigDirsOf(home: string): string[] {
  return [...new Set([resolveClaudeConfigDir(), ...accountDirs(home), ...employeeDirs(path.join(home, "org"))])];
}
