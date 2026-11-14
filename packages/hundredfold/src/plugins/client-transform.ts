/**
 * What `GET /api/plugins/<id>/client` serves, for a client half that may be JSX.
 *
 * The no-build door stays open by not becoming a build: a plain-ESM `client.js`
 * is still served as its own bytes, and only a file that turns out to hold JSX
 * is compiled. `jsx: "automatic"` emits `react/jsx-runtime`, which is already one
 * of the three specifiers the web loader resolves to the app's live namespaces
 * (web/src/plugins/sdk/runtime.ts), so a compiled plugin lands on the running
 * React rather than on a second dispatcher.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { transform, type Message } from "esbuild";
import { fileStamp } from "./file-stamp.js";

/** Serve the file unchanged, serve this code instead, or refuse with a reason. */
export type ClientModule =
  | { kind: "raw" }
  | { kind: "transformed"; code: string }
  | { kind: "error"; message: string };

interface CacheEntry {
  stamp: string;
  module: ClientModule;
}

/** One entry per plugin, replaced when its file changes, so this is bounded by
 *  how many plugins are installed. Errors are cached with the rest: a plugin
 *  that will not compile must not be re-parsed on every load until its author
 *  fixes it. */
const cache = new Map<string, CacheEntry>();

/** `<file>:<line>:<column>: <reason>`, so the operator gets somewhere to look
 *  rather than a verdict. */
function failureMessage(error: unknown, sourcefile: string): string {
  const first = (error as { errors?: Message[] }).errors?.[0];
  if (!first) return `${sourcefile}: ${error instanceof Error ? error.message : String(error)}`;
  const at = first.location ? `:${first.location.line}:${first.location.column}` : "";
  return `${sourcefile}${at}: ${first.text}`;
}

/** The import esbuild's automatic runtime adds, and only when it found JSX to
 *  compile. It is the one thing in the output that says the source needed
 *  compiling at all — a file that hand-writes this same import is compiled too,
 *  which costs it its own formatting and nothing else. */
const AUTOMATIC_RUNTIME = 'from "react/jsx-runtime"';

async function compile(file: string): Promise<ClientModule> {
  const sourcefile = path.basename(file);
  let source: string;
  try {
    source = await fs.readFile(file, "utf-8");
  } catch {
    // Unreadable is not a compile failure. Left as raw, the file server answers
    // the 404 it answers today for a client half that is not there.
    return { kind: "raw" };
  }

  let code: string;
  try {
    ({ code } = await transform(source, {
      loader: "jsx",
      jsx: "automatic",
      // The dev runtime imports `react/jsx-dev-runtime`, which the loader's
      // allowlist does not carry: every compiled plugin would fail to resolve.
      jsxDev: false,
      format: "esm",
      target: "es2022",
      sourcefile,
    }));
  } catch (error) {
    return { kind: "error", message: failureMessage(error, sourcefile) };
  }

  // JSX is a superset of ESM, so this one parse also answers "was any of it
  // JSX?", and a file where none of it was keeps its own bytes rather than
  // esbuild's. Asking under the JS loader first would answer the same question
  // by compiling every JSX plugin twice.
  return code.includes(AUTOMATIC_RUNTIME) ? { kind: "transformed", code } : { kind: "raw" };
}

/** What to serve for one plugin's client half, compiling it only when the file
 *  on disk has changed since the last answer. */
export async function pluginClientModule(id: string, file: string): Promise<ClientModule> {
  const stamp = await fileStamp(file);
  if (stamp === null) {
    cache.delete(id);
    return { kind: "raw" };
  }

  const cached = cache.get(id);
  if (cached?.stamp === stamp) return cached.module;

  const module = await compile(file);
  cache.set(id, { stamp, module });
  return module;
}
