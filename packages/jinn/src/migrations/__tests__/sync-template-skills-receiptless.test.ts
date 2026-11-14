import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { syncTemplateSkills } from "../sync-template-skills.js"

const roots: string[] = []
const retiredTemplate = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/v0.32.0/migrate/SKILL.md"),
  "utf8",
)

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function fixture(portalName = "Hundredfold") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-receiptless-retirement-"))
  roots.push(root)
  const home = path.join(root, "home")
  const templateDir = path.join(root, "template")
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `jinn:\n  version: "0.32.0"\nportal:\n  portalName: ${portalName}\n`,
  )
  write(path.join(templateDir, "skills/current/SKILL.md"), "# Current\n")
  fs.writeFileSync(path.join(templateDir, "skills.json"), "[]\n")
  write(path.join(home, "skills/migrate/SKILL.md"), retiredTemplate.replaceAll("{{portalName}}", portalName))
  write(path.join(home, "skills/operator-authored/SKILL.md"), "# Operator authored\n")
  return { root, home, templateDir }
}

const sync = (home: string, templateDir: string) => syncTemplateSkills({
  instanceHome: home,
  templateDir,
  packageVersion: "0.33.0",
})

describe("syncTemplateSkills: receipt-less retirement", () => {
  it("removes an unmodified formerly shipped skill and leaves operator skills untouched", () => {
    const { home, templateDir } = fixture("Acme Portal")

    const result = sync(home, templateDir)

    expect(result.removed).toEqual(["migrate"])
    expect(fs.existsSync(path.join(home, "skills/migrate"))).toBe(false)
    expect(fs.readFileSync(path.join(result.backupDir!, "skills/migrate/SKILL.md"), "utf8")).toBe(
      retiredTemplate.replaceAll("{{portalName}}", "Acme Portal"),
    )
    expect(fs.readFileSync(path.join(home, "skills/operator-authored/SKILL.md"), "utf8")).toBe("# Operator authored\n")
  })

  it("preserves a modified formerly shipped skill and leaves operator skills untouched", () => {
    const { home, templateDir } = fixture()
    fs.appendFileSync(path.join(home, "skills/migrate/SKILL.md"), "\nOperator customization.\n")

    const result = sync(home, templateDir)

    expect(result.removed).toEqual([])
    expect(fs.readFileSync(path.join(home, "skills/migrate/SKILL.md"), "utf8")).toContain("Operator customization.")
    expect(fs.readFileSync(path.join(home, "skills/operator-authored/SKILL.md"), "utf8")).toBe("# Operator authored\n")
  })

  it("is idempotent on the second boot", () => {
    const { home, templateDir } = fixture()
    const first = sync(home, templateDir)
    const backupsAfterFirst = fs.readdirSync(path.join(home, ".migration-backups"))

    const second = sync(home, templateDir)

    expect(first.removed).toEqual(["migrate"])
    expect(second).toEqual({ added: [], updated: [], removed: [], backupDir: null })
    expect(fs.readdirSync(path.join(home, ".migration-backups"))).toEqual(backupsAfterFirst)
  })

  it("does not delete a retired file when its backup cannot be written", () => {
    const { home, templateDir } = fixture()
    const retiredFile = path.join(home, "skills/migrate/SKILL.md")
    const before = fs.readFileSync(retiredFile)
    fs.writeFileSync(path.join(home, ".migration-backups"), "not a directory\n")

    expect(() => sync(home, templateDir)).toThrow()

    expect(fs.readFileSync(retiredFile)).toEqual(before)
    expect(fs.existsSync(path.join(home, "skills/current"))).toBe(false)
  })

  it("preserves a same-named skill when its shape differs from the published payload", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/migrate/operator-note.md"), "keep this\n")

    const result = sync(home, templateDir)

    expect(result.removed).toEqual([])
    expect(fs.readFileSync(path.join(home, "skills/migrate/operator-note.md"), "utf8")).toBe("keep this\n")
  })

  it("still refuses an outside-home receipt before applying any planned change", () => {
    const { root, home, templateDir } = fixture()
    const outside = path.join(root, "outside.md")
    fs.writeFileSync(outside, "untouched\n")
    fs.writeFileSync(
      path.join(home, ".jinn-template-skills.json"),
      JSON.stringify({ version: "0.32.0", skills: ["../../outside.md"] }),
    )

    expect(() => sync(home, templateDir)).toThrow(/inside the skills directory/)
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched\n")
    expect(fs.existsSync(path.join(home, "skills/current"))).toBe(false)
    expect(fs.existsSync(path.join(home, ".migration-backups"))).toBe(false)
  })
})
