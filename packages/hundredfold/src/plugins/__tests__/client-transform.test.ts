import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginClientModule } from "../client-transform.js";

let dir: string;
let counter = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-client-transform-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One plugin's client half on disk. Each case gets an id of its own, because
 *  the cache the module keeps is keyed on exactly that. */
function client(source: string): { id: string; file: string } {
  counter += 1;
  const id = `plugin-${counter}`;
  const file = path.join(dir, `${id}.js`);
  fs.writeFileSync(file, source);
  return { id, file };
}

describe("pluginClientModule", () => {
  it("leaves plain ESM to be served as its own bytes", async () => {
    const { id, file } = client("import { jsx } from '@hundredfold/plugin-sdk'\nexport default { id: 'x', render: () => jsx('p', {}) }\n");
    expect(await pluginClientModule(id, file)).toEqual({ kind: "raw" });
  });

  it("compiles JSX against the automatic runtime the loader already resolves", async () => {
    const { id, file } = client("export const Panel = () => <p className=\"lead\">hi</p>\n");

    const module = await pluginClientModule(id, file);

    expect(module.kind).toBe("transformed");
    const code = module.kind === "transformed" ? module.code : "";
    expect(code).toContain('from "react/jsx-runtime"');
    // The dev runtime is not in the loader's allowlist, so emitting it would
    // make every JSX plugin fail to load with an unresolvable specifier.
    expect(code).not.toContain("jsx-dev-runtime");
  });

  it("names the file, the line and the reason when neither parse succeeds", async () => {
    const { id, file } = client("export const Broken = () => <p>unclosed\n");

    const module = await pluginClientModule(id, file);

    expect(module.kind).toBe("error");
    const message = module.kind === "error" ? module.message : "";
    expect(message).toContain(path.basename(file));
    expect(message).toMatch(/:\d+:\d+:/);
  });

  it("answers the same module for an unmodified file, and recompiles after an edit", async () => {
    const { id, file } = client("export const Panel = () => <p>one</p>\n");

    const first = await pluginClientModule(id, file);
    expect(await pluginClientModule(id, file)).toBe(first);

    fs.writeFileSync(file, "export const Panel = () => <p>two, and longer</p>\n");
    const second = await pluginClientModule(id, file);
    expect(second).not.toBe(first);
    expect(second.kind === "transformed" && second.code).toContain("two, and longer");
  });

  it("caches a broken file too, so a request cannot re-parse it on every load", async () => {
    const { id, file } = client("export const Broken = () => <p>unclosed\n");

    expect(await pluginClientModule(id, file)).toBe(await pluginClientModule(id, file));
  });

  it("leaves a file that vanished to the file server's 404", async () => {
    const { id, file } = client("export default {}\n");
    fs.rmSync(file);

    expect(await pluginClientModule(id, file)).toEqual({ kind: "raw" });
  });
});
