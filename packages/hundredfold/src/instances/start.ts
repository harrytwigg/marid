import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cloneCurrentTailscaleServe,
  type AccessProvisionResult,
  type ExecFileFn,
} from "./access.js";
import { assertSecondaryInstancesSupported, isPortAvailable } from "./create.js";
import { buildSandboxChildEnv } from "../shared/sandbox-env.js";
import {
  loadInstances,
  saveInstances,
  type DirectoryOptions,
  type Instance,
} from "./directory.js";

const execFileAsync = promisify(nodeExecFile);

export interface StartInstanceInput {
  instance: Instance;
  currentPort: number;
}

export interface StartInstanceResult {
  instance: Instance;
  warning?: string;
}

export interface StartInstanceDependencies extends DirectoryOptions {
  cliEntry?: string;
  execFile?: ExecFileFn;
  isPortAvailable?: (port: number) => Promise<boolean>;
  waitForHealth?: (port: number) => Promise<boolean>;
  provisionAccess?: (options: { currentPort: number; newPort: number }) => Promise<AccessProvisionResult>;
}

function resolveCliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../bin/hundredfold.js"),
    path.resolve(here, "../../dist/bin/hundredfold.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function defaultExecFile(file: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number }) {
  return execFileAsync(file, args, { ...options, encoding: "utf8" }).then((result) => ({
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  }));
}

function defaultWaitForHealth(port: number, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/status", timeout: 750 }, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve(true);
        retry();
      });
      const retry = () => {
        request.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, 200).unref?.();
      };
      request.once("error", retry);
      request.once("timeout", retry);
      request.end();
    };
    attempt();
  });
}

export async function startInstance(
  input: StartInstanceInput,
  dependencies: StartInstanceDependencies = {},
): Promise<StartInstanceResult> {
  assertSecondaryInstancesSupported();
  if (!fs.existsSync(path.join(input.instance.home, "config.yaml"))) {
    throw new Error(`Workspace directory ${input.instance.home} is not initialized`);
  }
  if (!await (dependencies.isPortAvailable ?? isPortAvailable)(input.instance.port)) {
    throw new Error(`Port ${input.instance.port} is already in use`);
  }

  const execFile = dependencies.execFile ?? defaultExecFile;
  // The child is a different instance: it inherits none of this one's identity —
  // not the binding it would start on, and not the session credentials it would act as.
  const childEnv: NodeJS.ProcessEnv = {
    ...buildSandboxChildEnv({ home: input.instance.home, instance: input.instance.name }),
    HUNDREDFOLD_NO_OPEN: "1",
  };
  await execFile(process.execPath, [dependencies.cliEntry ?? resolveCliEntry(), "start", "--daemon"], {
    env: childEnv,
    timeout: 30_000,
  });

  if (!await (dependencies.waitForHealth ?? defaultWaitForHealth)(input.instance.port)) {
    throw new Error(`Workspace started but did not become healthy on port ${input.instance.port}`);
  }

  const provision = await (dependencies.provisionAccess ?? cloneCurrentTailscaleServe)({
    currentPort: input.currentPort,
    newPort: input.instance.port,
  });
  let instance = input.instance;
  if (provision.status === "configured") {
    instance = { ...instance, accessUrls: { ...instance.accessUrls, remote: provision.url } };
    const instances = loadInstances(dependencies);
    saveInstances(instances.map((candidate) => candidate.id === instance.id ? instance : candidate), dependencies);
  }

  return {
    instance,
    ...(provision.status === "failed" ? { warning: provision.warning } : {}),
  };
}
