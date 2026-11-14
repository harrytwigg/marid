import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import {
  ensureDefaultInstance,
  findInstance,
  loadInstances,
  recordInstanceRenamed,
  resolveHostDataDir,
  resolveInstancesRegistryPath,
  resolvePreviousInstancesRegistryPath,
  saveInstances,
} from "../directory.js";
import { normalizeWorkspaceName, resolveInstanceHome } from "../create.js";
import { isDefaultHome, resolveHundredfoldInstance, resolveHomeIdentity } from "../../shared/home.js";
import { assertContainerPrimaryCommand } from "../../cli/container-contract.js";
import { formatPairingInstructions } from "../../cli/pair.js";
import { OLD } from "../../shared/legacy/names.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "identity-"))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

const entry = (name: string, home: string, port = 7000) => ({ name, home, port, createdAt: "2026-01-01T00:00:00.000Z" });

describe("the host registry's place", () => {
  it("is named for the codename on each platform, and the legacy place is known", () => {
    expect(resolveHostDataDir({ platform: "darwin", home: "/h", env: {} })).toBe("/h/Library/Application Support/Acme");
    expect(resolveHostDataDir({ platform: "linux", home: "/h", env: {} })).toBe("/h/.config/acme");
    expect(resolvePreviousInstancesRegistryPath({ platform: "linux", home: "/h", env: {} })).toBe(`/h/.config/${OLD.codename}/instances.json`);
    expect(resolvePreviousInstancesRegistryPath({ platform: "linux", home: "/h", env: { [`${OLD.upper}_INSTANCES_REGISTRY`]: "/x/i.json" } })).toBeNull();
    expect(resolveInstancesRegistryPath({ platform: "linux", home: "/h", env: { [`${OLD.upper}_INSTANCES_REGISTRY`]: "/x/i.json" } })).toBe("/x/i.json");
  });

  it("carries an earlier codename's registry forward the first time it is read", () => {
    const previous = path.join(root, "old", "instances.json");
    const current = path.join(root, "new", "instances.json");
    saveInstances([entry(OLD.codename, `/h/.${OLD.codename}`), entry(`${OLD.codename}-john`, `/h/.${OLD.codename}-john`, 7001)], { registryPath: previous });
    const loaded = loadInstances({ registryPath: current, previousRegistryPath: previous, legacyRegistryPath: path.join(root, "none.json") });
    expect(loaded.map((instance) => instance.name)).toEqual([OLD.codename, `${OLD.codename}-john`]);
    expect(fs.existsSync(current)).toBe(true);
    // The old file is left for rollback, and the new one is read from now on.
    expect(fs.existsSync(previous)).toBe(true);
    saveInstances([entry("acme", "/h/.acme")], { registryPath: current });
    expect(loadInstances({ registryPath: current, previousRegistryPath: previous }).map((instance) => instance.name)).toEqual(["acme"]);
  });
});

describe("one identity per instance", () => {
  it("finds an instance by either spelling of its name", () => {
    const options = { registryPath: path.join(root, "r.json") };
    saveInstances([entry(`${OLD.codename}-john`, `/h/.${OLD.codename}-john`)], options);
    vi.stubEnv(`${OLD.upper}_INSTANCES_REGISTRY`, options.registryPath);
    expect(findInstance(`${OLD.codename}-john`)?.home).toBe(`/h/.${OLD.codename}-john`);
    expect(findInstance("acme-john")?.home).toBe(`/h/.${OLD.codename}-john`);
    expect(findInstance("acme-other")).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("does not add a second default instance beside one an earlier codename registered", () => {
    const registryPath = path.join(root, "r.json");
    saveInstances([entry(OLD.codename, path.join(root, `.${OLD.codename}`))], { registryPath });
    vi.stubEnv(`${OLD.upper}_INSTANCES_REGISTRY`, registryPath);
    ensureDefaultInstance();
    expect(loadInstances({ registryPath }).map((instance) => instance.name)).toEqual([OLD.codename]);
    fs.rmSync(registryPath);
    ensureDefaultInstance();
    expect(loadInstances({ registryPath }).map((instance) => instance.name)).toEqual(["acme"]);
    vi.unstubAllEnvs();
  });

  it("records a moved home under the new name and path, and only once", () => {
    const options = { registryPath: path.join(root, "r.json") };
    saveInstances([entry(`${OLD.codename}-john`, `/h/.${OLD.codename}-john`), entry(`${OLD.codename}-other`, `/h/.${OLD.codename}-other`, 7002)], options);
    expect(recordInstanceRenamed({ fromHome: `/h/.${OLD.codename}-john`, toHome: "/h/.acme-john" }, options)).toBe(true);
    expect(recordInstanceRenamed({ fromHome: `/h/.${OLD.codename}-john`, toHome: "/h/.acme-john" }, options)).toBe(false);
    expect(loadInstances(options).map((instance) => [instance.name, instance.home])).toEqual([
      ["acme-john", "/h/.acme-john"],
      [`${OLD.codename}-other`, `/h/.${OLD.codename}-other`],
    ]);
  });

  it("resolves `-i` in either spelling, with or without the prefix, to the registered home", () => {
    const instances = [entry(`${OLD.codename}-john`, `/h/.${OLD.codename}-john`)].map((value) => ({ ...value, id: "x" }));
    for (const selector of ["john", `${OLD.codename}-john`, "acme-john"]) expect(resolveInstanceHome(selector, instances, "/h")).toBe(`/h/.${OLD.codename}-john`);
    expect(resolveInstanceHome(OLD.codename, instances, "/h")).toBe("/h/.acme");
    expect(resolveInstanceHome("acme", instances, "/h")).toBe("/h/.acme");
    expect(resolveInstanceHome(`${OLD.codename}-new`, [], "/h")).toBe("/h/.acme-new");
  });

  it("names a new workspace after the current codename and refuses either default name", () => {
    expect(normalizeWorkspaceName(`${OLD.codename}-Yorio`)).toMatchObject({ slug: "yorio", instanceName: "acme-yorio", homeName: ".acme-yorio" });
    expect(normalizeWorkspaceName("acme-Yorio")).toMatchObject({ slug: "yorio", instanceName: "acme-yorio" });
    expect(() => normalizeWorkspaceName(OLD.codename)).toThrow();
    expect(() => normalizeWorkspaceName("acme")).toThrow();
  });

  it("names an instance by its current name whichever the home or the variable says", () => {
    expect(resolveHundredfoldInstance(`/h/.${OLD.codename}-john`)).toBe("acme-john");
    expect(resolveHundredfoldInstance("/h/.acme-john")).toBe("acme-john");
    expect(resolveHundredfoldInstance(`/h/.${OLD.codename}`)).toBe("acme");
    vi.stubEnv(`${OLD.upper}_INSTANCE`, `${OLD.codename}-john`);
    expect(resolveHundredfoldInstance()).toBe("acme-john");
    vi.unstubAllEnvs();
  });

  it("calls both default paths the default home, a link left at the old one included", () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    fs.mkdirSync(path.join(root, ".acme"));
    fs.symlinkSync(path.join(root, ".acme"), path.join(root, `.${OLD.codename}`), "dir");
    expect(isDefaultHome(path.join(root, ".acme"))).toBe(true);
    expect(isDefaultHome(path.join(root, `.${OLD.codename}`))).toBe(true);
    expect(resolveHomeIdentity(path.join(root, `.${OLD.codename}`))).toBe(path.join(root, ".acme"));
    expect(isDefaultHome(path.join(root, ".acme-john"))).toBe(false);
  });

  it("accepts a container's primary home under the old path and the old name", () => {
    const home = path.join(root, `.${OLD.codename}`);
    fs.mkdirSync(home);
    const env = { [`${OLD.upper}_CONTAINER`]: "1", [`_${OLD.upper}_CONTAINER_SERVICE_START`]: "1", [`${OLD.upper}_CONTAINER_PRIMARY_HOME`]: home, [`${OLD.upper}_HOME`]: home, [`${OLD.upper}_INSTANCE`]: OLD.codename };
    expect(() => assertContainerPrimaryCommand("start", undefined, env)).not.toThrow();
    expect(() => assertContainerPrimaryCommand("start", undefined, { ...env, [`${OLD.upper}_INSTANCE`]: "acme" })).not.toThrow();
    expect(() => assertContainerPrimaryCommand("start", undefined, { ...env, [`${OLD.upper}_INSTANCE`]: `${OLD.codename}-other` })).toThrow(/one Hundredfold instance/);
  });

  it("hints the pairing command by the current codename", () => {
    expect(formatPairingInstructions({ code: "ABCD", ttlSeconds: 300 } as never, 7000)).toContain("Instance: acme (port 7000)");
  });
});
