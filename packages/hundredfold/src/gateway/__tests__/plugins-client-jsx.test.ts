import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { call, install, pluginsDir, resetPlugins, startHarness, writeConfig } from "./plugins-api-harness.js";

/**
 * How many times the client-serving path has reached the compiler. The cache
 * assertion below is on this rather than on wall-clock: a cache that was quietly
 * removed still answers fast enough for a timing test to pass.
 */
const { transforms } = vi.hoisted(() => ({ transforms: { count: 0 } }));

vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild")>();
  return {
    ...actual,
    transform: (...args: Parameters<typeof actual.transform>) => {
      transforms.count += 1;
      return actual.transform(...args);
    },
  };
});

/** A client half written the way it would be by hand, with formatting esbuild
 *  would not have chosen. Serving it back byte for byte is the claim. */
const HAND_WRITTEN = `import { jsx, jsxs } from '@hundredfoldhq/plugin-sdk'

export default {
  id: 'calls',
  register(ctx) {
    ctx.contribute({ id: 'p', area: 'x', render: () => jsxs('div', { children: [ jsx('b', {}) ] }) })
  },
}
`;

const WITH_JSX = `function Panel({ label }) {
  return <section className="panel">{label} waiting</section>
}

export default {
  id: 'jsx',
  register(ctx) {
    ctx.contribute({ id: 'page', area: 'routes', data: { path: '/jsx' }, render: () => <Panel label="nothing" /> })
  },
}
`;

/** The shape every real plugin has: JSX and the SDK together. What it must not
 *  compile to is a fourth specifier, which the loader would reject. */
const WITH_JSX_AND_SDK = `import { AREAS, React } from '@hundredfoldhq/plugin-sdk'

export function Panel() {
  const [count] = React.useState(0)
  return <p>{count}</p>
}

export const area = AREAS.routes
`;

const clientPath = (id: string) => path.join(pluginsDir, id, "client.js");

/** Every bare specifier the served module imports — the ones the web loader has
 *  to resolve against its allowlist rather than against a URL. */
function bareImports(code: string): string[] {
  const specifiers = [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]);
  return [...new Set(specifiers.filter((specifier) => !/^[./]|^[a-z][a-z0-9+.-]*:/i.test(specifier)))];
}

let onConfigReload: () => void;

beforeAll(async () => {
  ({ onConfigReload } = await startHarness());
});

beforeEach(() => {
  resetPlugins();
  writeConfig({ enabled: ["jsx", "calls", "broken"] });
  onConfigReload();
  install("jsx", { id: "jsx", name: "JSX" }, { "client.js": WITH_JSX });
  install("calls", { id: "calls", name: "Calls" }, { "client.js": HAND_WRITTEN });
  transforms.count = 0;
});

describe("GET /api/plugins/:id/client with JSX", () => {
  it("serves JSX as ESM importing only the runtime the loader already resolves", async () => {
    const served = await call("GET", "/api/plugins/jsx/client");

    expect(served.status).toBe(200);
    expect(served.headers["Content-Type"]).toBe("application/javascript");
    expect(served.headers["Cache-Control"]).toBe("no-store");
    expect(served.bodyText).not.toContain("<section");
    expect(bareImports(served.bodyText)).toEqual(["react/jsx-runtime"]);
  });

  it("adds nothing outside the allowlist to a plugin that imports the SDK too", async () => {
    install("both", { id: "both", name: "Both" }, { "client.js": WITH_JSX_AND_SDK });
    writeConfig({ enabled: ["both"] });
    onConfigReload();

    const served = await call("GET", "/api/plugins/both/client");

    expect(served.status).toBe(200);
    expect(bareImports(served.bodyText).sort()).toEqual(["@hundredfoldhq/plugin-sdk", "react/jsx-runtime"]);
  });

  it("serves a hand-written jsx() client half byte for byte", async () => {
    const served = await call("GET", "/api/plugins/calls/client");

    expect(served.status).toBe(200);
    expect(served.bodyText).toBe(fs.readFileSync(clientPath("calls"), "utf-8"));
  });

  it("compiles once for an unmodified file, and again after an edit", async () => {
    await call("GET", "/api/plugins/jsx/client");
    // Exactly one: the compile is also the parse that decides whether the file
    // needed compiling, so a first request never reaches esbuild twice.
    expect(transforms.count).toBe(1);

    const cached = await call("GET", "/api/plugins/jsx/client");
    expect(transforms.count).toBe(1);
    expect(cached.status).toBe(200);

    fs.writeFileSync(clientPath("jsx"), "export const Edited = () => <p>edited, and a different length</p>\n");
    const reread = await call("GET", "/api/plugins/jsx/client");

    expect(transforms.count).toBe(2);
    expect(reread.bodyText).toContain("edited, and a different length");
  });

  it("answers 422 naming the file, the line and the reason when JSX will not parse", async () => {
    install("broken", { id: "broken", name: "Broken" }, { "client.js": "export const Panel = () => <p>unclosed\n" });

    const served = await call("GET", "/api/plugins/broken/client");

    expect(served.status).toBe(422);
    expect(served.body.error).toContain("client.js");
    expect(served.body.error).toMatch(/:\d+:\d+:/);
  });

  it("carries that reason onto the inventory row the settings list renders", async () => {
    install("broken", { id: "broken", name: "Broken" }, { "client.js": "export const Panel = () => <p>unclosed\n" });

    const listed = await call("GET", "/api/plugins");
    const row = listed.body.inventory.find((entry: { id: string }) => entry.id === "broken");

    expect(row.status).toBe("error");
    expect(row.error).toMatch(/client\.js:\d+:\d+:/);
    // Still served, so the dashboard asks and gets the 422 that leaves whatever
    // is already running in place rather than unloading it as missing.
    expect(listed.body.plugins.map((entry: { id: string }) => entry.id)).toContain("broken");
  });
});
