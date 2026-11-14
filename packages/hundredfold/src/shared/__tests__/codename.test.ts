import { describe, expect, it } from "vitest";
import {
  LEGACY_CODENAME,
  currentInstanceName,
  instanceNameFor,
  legacyInstanceName,
  nameAliases,
  namesFor,
} from "../codename.js";

const acme = namesFor("acme");
const same = namesFor(LEGACY_CODENAME);

describe("codename names", () => {
  it("derives every case form from the one word", () => {
    expect(acme).toEqual({ codename: "acme", upper: "ACME", title: "Acme", renamed: true });
    expect(same.renamed).toBe(false);
  });

  it("refuses a word that could not be an instance name or a header segment", () => {
    for (const bad of ["", "Acme", "a-b", "9lives", "a_b", "a b"]) expect(() => namesFor(bad)).toThrow(/invalid codename/);
  });

  it("lists the current spelling first, and a single one while nothing is renamed", () => {
    expect(nameAliases((n) => `x-${n.codename}`, acme)).toEqual(["x-acme", "x-jinn"]);
    expect(nameAliases((n) => `x-${n.codename}`, same)).toEqual(["x-jinn"]);
  });
});

describe("instance names", () => {
  it("maps the default instance and every named one, and leaves a name that never carried the codename", () => {
    expect(currentInstanceName("jinn", acme)).toBe("acme");
    expect(currentInstanceName("jinn-yorio", acme)).toBe("acme-yorio");
    expect(currentInstanceName("sandbox", acme)).toBe("sandbox");
    expect(currentInstanceName("jinnova", acme)).toBe("jinnova");
  });

  it("maps back, so an old `-i` name and a new one resolve to the same instance", () => {
    expect(legacyInstanceName("acme", acme)).toBe("jinn");
    expect(legacyInstanceName("acme-yorio", acme)).toBe("jinn-yorio");
    expect(legacyInstanceName("acmeology", acme)).toBe("acmeology");
    for (const name of ["jinn", "jinn-a", "jinn-a-b", "other"]) {
      expect(legacyInstanceName(currentInstanceName(name, acme), acme)).toBe(name);
    }
  });

  it("is the identity while no rename is in effect", () => {
    for (const name of ["jinn", "jinn-a", "other"]) {
      expect(currentInstanceName(name, same)).toBe(name);
      expect(legacyInstanceName(name, same)).toBe(name);
    }
  });

  it("builds the name of the default instance and of a named one", () => {
    expect(instanceNameFor(undefined, acme)).toBe("acme");
    expect(instanceNameFor("yorio", acme)).toBe("acme-yorio");
  });
});
