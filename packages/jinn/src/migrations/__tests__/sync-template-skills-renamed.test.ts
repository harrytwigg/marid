import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }))

import { syncTemplateSkills } from "../sync-template-skills.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const write = (file: string, content: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

/** An instance an older build synced: its receipt names the skills that build shipped, under the old file name. */
function instance() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sync-renamed-"))
  roots.push(root)
  const home = path.join(root, "home")
  const templateDir = path.join(root, "template")
  write(path.join(home, "config.yaml"), 'jinn:\n  version: "0.30.0"\n')
  write(path.join(home, "skills", "retired", "SKILL.md"), "# Retired\n")
  write(path.join(home, "skills", "mine", "SKILL.md"), "# Written by the operator\n")
  write(path.join(templateDir, "skills", "notes", "SKILL.md"), "# Notes\n")
  write(path.join(templateDir, "skills.json"), "[]\n")
  return { home, templateDir }
}

describe("the template-skills receipt across a codename change", () => {
  it("reads the receipt the old name wrote, so a retired skill is still told from the operator's own", () => {
    const { home, templateDir } = instance()
    write(path.join(home, ".jinn-template-skills.json"), JSON.stringify({ version: "0.30.0", skills: ["retired"] }))

    const result = syncTemplateSkills({ instanceHome: home, templateDir, packageVersion: "0.31.0" })

    expect(result.removed).toEqual(["retired"])
    expect(fs.existsSync(path.join(home, "skills", "retired"))).toBe(false)
    expect(fs.readFileSync(path.join(home, "skills", "mine", "SKILL.md"), "utf8")).toBe("# Written by the operator\n")
    expect(JSON.parse(fs.readFileSync(path.join(home, ".acme-template-skills.json"), "utf8")).skills).toEqual(["notes"])
  })

  it("prefers the receipt under the current name once there is one", () => {
    const { home, templateDir } = instance()
    write(path.join(home, ".jinn-template-skills.json"), JSON.stringify({ version: "0.30.0", skills: ["retired"] }))
    write(path.join(home, ".acme-template-skills.json"), JSON.stringify({ version: "0.31.0", skills: [] }))

    const result = syncTemplateSkills({ instanceHome: home, templateDir, packageVersion: "0.31.0" })

    expect(result.removed).toEqual([])
    expect(fs.existsSync(path.join(home, "skills", "retired"))).toBe(true)
  })
})
