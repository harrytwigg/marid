import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("third-party notices", () => {
  it("ships the file that carries the Phosphor Icons MIT notice", () => {
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toContain("THIRD-PARTY-NOTICES.md");

    const notice = readFileSync(join(PKG, "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notice).toContain("Copyright (c) 2023 Phosphor Icons");
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });
});
