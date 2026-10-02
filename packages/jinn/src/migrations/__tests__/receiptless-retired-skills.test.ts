import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { matchesReceiptlessRetiredSkill, receiptlessRetiredSkillNames } from "../receiptless-retired-skills.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (relative: string) => fs.readFileSync(path.join(here, "fixtures", relative), "utf8")
const inputs = { portalName: "Jinn", portalSlug: "jinn" }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function installSkill(name: string, content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-receiptless-skill-"))
  roots.push(root)
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "SKILL.md"), content)
  return dir
}

describe("receiptless retirement: experiments skill", () => {
  const versions = [
    ["0.29.x", "v0.29.1/experiments/SKILL.md"],
    ["0.30.0 and later", "v0.33.3/experiments/SKILL.md"],
  ] as const

  it("is registered", () => {
    expect(receiptlessRetiredSkillNames()).toContain("experiments")
  })

  it.each(versions)("matches the unmodified %s skill", (_label, file) => {
    expect(matchesReceiptlessRetiredSkill(installSkill("experiments", fixture(file)), "experiments", inputs)).toBe(true)
  })

  it.each(versions)("rejects a modified copy of the %s skill", (_label, file) => {
    const dir = installSkill("experiments", `${fixture(file)}\nOperator customization.\n`)
    expect(matchesReceiptlessRetiredSkill(dir, "experiments", inputs)).toBe(false)
  })

  it("rejects arbitrary third content", () => {
    const dir = installSkill("experiments", "---\nname: experiments\ndescription: mine\n---\n\n# My own experiments\n")
    expect(matchesReceiptlessRetiredSkill(dir, "experiments", inputs)).toBe(false)
  })

  it("rejects a copy with an extra file", () => {
    const dir = installSkill("experiments", fixture("v0.33.3/experiments/SKILL.md"))
    fs.writeFileSync(path.join(dir, "notes.md"), "keep\n")
    expect(matchesReceiptlessRetiredSkill(dir, "experiments", inputs)).toBe(false)
  })
})

describe("receiptless retirement: workflow skill", () => {
  const shipped = (version: string) =>
    fs.readFileSync(path.join(here, "../../../template/migrations", version, "files/target/skills/workflow/SKILL.md"), "utf8")
  const versions = [
    ["0.26.0", () => shipped("0.26.0")],
    ["0.31.0", () => shipped("0.31.0")],
    ["0.33.3", () => fixture("v0.33.3/workflow/SKILL.md")],
  ] as const

  it("is registered", () => {
    expect(receiptlessRetiredSkillNames()).toContain("workflow")
  })

  it.each(versions)("matches the unmodified %s skill", (_label, content) => {
    expect(matchesReceiptlessRetiredSkill(installSkill("workflow", content()), "workflow", inputs)).toBe(true)
  })

  it("rejects a modified copy", () => {
    const dir = installSkill("workflow", `${fixture("v0.33.3/workflow/SKILL.md")}\nOperator customization.\n`)
    expect(matchesReceiptlessRetiredSkill(dir, "workflow", inputs)).toBe(false)
  })
})

describe("receiptless retirement: existing single-version skills", () => {
  const migrate = fixture("v0.32.0/migrate/SKILL.md")

  it("still matches the unmodified migrate skill, with its portal name substituted", () => {
    const portal = { portalName: "Acme Portal", portalSlug: "acme-portal" }
    const dir = installSkill("migrate", migrate.replaceAll("{{portalName}}", portal.portalName))
    expect(matchesReceiptlessRetiredSkill(dir, "migrate", portal)).toBe(true)
  })

  it("still rejects a modified migrate skill", () => {
    const dir = installSkill("migrate", `${migrate.replaceAll("{{portalName}}", "Jinn")}\nextra\n`)
    expect(matchesReceiptlessRetiredSkill(dir, "migrate", inputs)).toBe(false)
  })

  it("rejects a skill with no fingerprint", () => {
    expect(matchesReceiptlessRetiredSkill(installSkill("notes", "# Notes\n"), "notes", inputs)).toBe(false)
  })
})
