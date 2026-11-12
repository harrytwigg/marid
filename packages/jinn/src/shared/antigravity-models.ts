import { spawn } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";
import { isSpellableModelId } from "./model-id.js";
import { buildEngineChildEnv } from "./child-env.js";

export interface AntigravityModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function labelAntigravityModel(id: string): string {
  return id.replace(/\s+\(([^)]+)\)\s*$/, " $1");
}

/** One catalog line as a model, or nothing when the line does not carry an id. */
function antigravityModelFromLine(line: string): ModelInfo | undefined {
  const tab = line.indexOf("\t");
  const id = tab === -1 ? line : line.slice(0, tab).trim();
  if (!isSpellableModelId(id)) {
    logger.warn(`agy models: ignoring a line that is not a model id: ${JSON.stringify(line)}`);
    return undefined;
  }
  return {
    id,
    label: (tab === -1 ? "" : line.slice(tab + 1).trim()) || labelAntigravityModel(id),
    supportsEffort: false,
    effortLevels: [],
  };
}

/**
 * The `agy models` catalog, one model per line.
 *
 * A line is either a bare id or `id<TAB>label` — newer builds print the second
 * form, and reading it as one id is what put `gemini-3.7-flash-high\tGemini 3.7
 * Flash (High)` into the registry and then onto an `--model` argv. The tab is the
 * only separator worth splitting on: ids here legitimately contain spaces and
 * parentheses, so a bare line keeps its whole text as before.
 *
 * A line whose id still carries a control character after that is dropped rather
 * than shipped. `defaultModel` is the first SURVIVOR for the same reason: it is
 * what a workflow's engine substitution runs on when no model is pinned. The
 * duplicate check moved onto the id with the split, since two lines can now agree
 * on one and differ only in their label.
 */
export function parseAntigravityModels(output: string): AntigravityModelDiscovery {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (!line || /^usage:/i.test(line) || /^flags:/i.test(line)) continue;

    const model = antigravityModelFromLine(line);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { defaultModel: models[0]?.id, models };
}

export async function discoverAntigravityModels(bin: string): Promise<AntigravityModelDiscovery> {
  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const proc = spawn(bin, ["models"], { env: buildEngineChildEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 1000);
        finish(out);
      }, 14000);
      proc.on("close", () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finish(out);
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        logger.warn(`agy models failed: ${e.message}`);
        finish("");
      });
    } catch (e) {
      logger.warn(`agy models spawn failed: ${e instanceof Error ? e.message : e}`);
      finish("");
    }
  });
  return parseAntigravityModels(output);
}
