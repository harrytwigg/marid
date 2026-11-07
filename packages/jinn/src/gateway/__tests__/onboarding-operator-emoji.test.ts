import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-operator-emoji-"));
const jinnHome = path.join(root, "instance");
process.env.JINN_HOME = jinnHome;
fs.mkdirSync(jinnHome, { recursive: true });

type Api = typeof import("../api.js");

let api: Api;
let currentConfig: JinnConfig;

function baseConfig(): JinnConfig {
  return {
    gateway: {},
    engines: { default: "codex", claude: {} },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
    portal: { companyName: "Example Company", operatorName: "Operator", setupComplete: true, onboarded: true },
  } as unknown as JinnConfig;
}

function readPortal(): Record<string, unknown> {
  const parsed = yaml.load(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")) as Record<string, any>;
  return parsed.portal;
}

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const capture = makeResponse();
  await api.handleApiRequest(
    req as unknown as Parameters<Api["handleApiRequest"]>[0],
    capture.res,
    {
      gatewayAuthToken: "test-token",
      jinnHome,
      getConfig: () => currentConfig,
      // The live gateway refreshes its in-memory copy right after the write, so
      // a follow-up GET reads what actually landed on disk rather than the
      // pre-write object.
      reloadConfig: () => {
        currentConfig = yaml.load(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")) as JinnConfig;
      },
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngines: () => new Map(),
        getEngine: () => undefined,
      },
    } as unknown as import("../api.js").ApiContext,
  );
  return capture;
}

beforeAll(async () => {
  api = await import("../api.js");
}, 60_000);

const claudeMdPath = path.join(jinnHome, "CLAUDE.md");

function writeOperatingManual(name: string, language?: string) {
  const languageSection = language
    ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
    : "";
  fs.writeFileSync(
    claudeMdPath,
    `# Operating Manual\n\nYou are **${name}**, a personal AI assistant and COO of an AI organization.${languageSection}\n`,
  );
}

beforeEach(() => {
  currentConfig = baseConfig();
  fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));
  fs.rmSync(claudeMdPath, { force: true });
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

describe("operator emoji on /api/onboarding", () => {
  it("returns null when the portal has no operator emoji", async () => {
    const response = await call("GET", "/api/onboarding");

    expect(response.status).toBe(200);
    expect(response.body.operatorEmoji).toBeNull();
  });

  it("returns the configured operator emoji", async () => {
    currentConfig = { ...baseConfig(), portal: { ...baseConfig().portal, operatorEmoji: "🦊" } } as JinnConfig;

    const response = await call("GET", "/api/onboarding");

    expect(response.body.operatorEmoji).toBe("🦊");
  });

  it("persists a posted operator emoji without disturbing the other portal names", async () => {
    const response = await call("POST", "/api/onboarding", { operatorEmoji: "🦊" });

    expect(response.status).toBe(200);
    expect(readPortal()).toMatchObject({
      operatorEmoji: "🦊",
      operatorName: "Operator",
      companyName: "Example Company",
    });
    expect((await call("GET", "/api/onboarding")).body.operatorEmoji).toBe("🦊");
  });

  it("clears the field on an empty string rather than writing an empty value", async () => {
    await call("POST", "/api/onboarding", { operatorEmoji: "🦊" });

    await call("POST", "/api/onboarding", { operatorEmoji: "" });

    expect(readPortal()).not.toHaveProperty("operatorEmoji");
    expect((await call("GET", "/api/onboarding")).body.operatorEmoji).toBeNull();
  });

  it("leaves a customized operating manual untouched on an emoji-only post", async () => {
    writeOperatingManual("Northwind", "Esperanto");
    const before = fs.readFileSync(claudeMdPath, "utf-8");

    await call("POST", "/api/onboarding", { operatorEmoji: "🦊" });

    expect(fs.readFileSync(claudeMdPath, "utf-8")).toBe(before);
  });

  it("renames the operating manual on a portal-name post while keeping the configured language", async () => {
    currentConfig = {
      ...baseConfig(),
      portal: { ...baseConfig().portal, language: "Esperanto" },
    } as JinnConfig;
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));
    writeOperatingManual("Northwind", "Esperanto");

    await call("POST", "/api/onboarding", { portalName: "Contoso" });

    const md = fs.readFileSync(claudeMdPath, "utf-8");
    expect(md).toContain("You are **Contoso**,");
    expect(md).toContain("Always respond in Esperanto.");
  });
});
