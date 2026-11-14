import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncTemplateSkills } from "../sync-template-skills.js"
import { OLD } from "../../shared/legacy-names.js";

const roots: string[] = []
const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex")
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const DEFAULT_TEMPLATE_SKILLS = {
  "cron-manager": { "SKILL.md": "# Cron Manager\nshipped by {{portalName}}\n" },
  notes: { "SKILL.md": "# Notes\n", "reference.md": "durable knowledge\n" },
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function fixture(templateSkills: Record<string, Record<string, string>> = DEFAULT_TEMPLATE_SKILLS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-skill-sync-"))
  roots.push(root)
  const home = path.join(root, "home")
  const templateDir = path.join(root, "template")
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "config.yaml"), 'hundredfold:\n  version: "0.30.0"\ncustom: keep\n')
  for (const [name, files] of Object.entries(templateSkills)) {
    for (const [file, content] of Object.entries(files)) {
      write(path.join(templateDir, "skills", name, file), content)
    }
  }
  fs.writeFileSync(path.join(templateDir, "skills.json"), "[]\n")
  return { root, home, templateDir }
}

const sync = (home: string, templateDir: string, packageVersion = "0.31.0") =>
  syncTemplateSkills({ instanceHome: home, templateDir, packageVersion })

const receiptPath = (home: string) => path.join(home, ".hundredfold-template-skills.json")
const backupDirs = (home: string) => {
  const root = path.join(home, ".migration-backups")
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : []
}

describe("syncTemplateSkills: shipped skills", () => {
  it("rewrites a stale skill, adds a missing one, and stamps the package version", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/cron-manager/SKILL.md"), "# Cron Manager\nstale\n")

    const result = sync(home, templateDir)

    expect(fs.readFileSync(path.join(home, "skills/cron-manager/SKILL.md"), "utf8")).toBe(`# Cron Manager\nshipped by ${OLD.portalName}\n`) // rename:keep: the name a config with no portalName has always had
    expect(fs.readFileSync(path.join(home, "skills/notes/SKILL.md"), "utf8")).toBe("# Notes\n")
    expect(fs.readFileSync(path.join(home, "skills/notes/reference.md"), "utf8")).toBe("durable knowledge\n")
    expect(result.added).toEqual(["notes"])
    expect(result.updated).toEqual(["cron-manager"])
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).toContain('version: "0.31.0"')
  })

  it("substitutes the instance portal name into materialized files", () => {
    const { home, templateDir } = fixture()
    fs.writeFileSync(path.join(home, "config.yaml"), 'hundredfold:\n  version: "0.30.0"\nportal:\n  portalName: Atlas\n')

    sync(home, templateDir)

    expect(fs.readFileSync(path.join(home, "skills/cron-manager/SKILL.md"), "utf8")).toBe("# Cron Manager\nshipped by Atlas\n")
  })

  it("deletes a file the template no longer ships from inside a shipped skill", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/notes/SKILL.md"), "# Notes\n")
    write(path.join(home, "skills/notes/retired-helper.md"), "gone next release\n")

    const result = sync(home, templateDir)

    expect(fs.existsSync(path.join(home, "skills/notes/retired-helper.md"))).toBe(false)
    expect(result.updated).toContain("notes")
  })

  it("seeds skills.json when missing and never rewrites an existing one", () => {
    const { home, templateDir } = fixture()
    sync(home, templateDir)
    expect(fs.readFileSync(path.join(home, "skills.json"), "utf8")).toBe("[]\n")

    fs.writeFileSync(path.join(home, "skills.json"), '[{"name":"installed"}]\n')
    sync(home, templateDir, "0.31.1")
    expect(fs.readFileSync(path.join(home, "skills.json"), "utf8")).toBe('[{"name":"installed"}]\n')
  })
})

describe("syncTemplateSkills: user-owned content", () => {
  it("leaves everything the template does not ship byte-for-byte identical", () => {
    const { home, templateDir } = fixture()
    const owned = {
      "skills/my-thing/SKILL.md": "# Mine\n",
      "org/marketer.yaml": "name: marketer\n",
      "knowledge/user-profile.md": "# Me\n",
      "CLAUDE.md": "# House rules\n",
      "skills.json": '[{"name":"installed"}]\n',
    }
    for (const [relative, content] of Object.entries(owned)) write(path.join(home, relative), content)
    const before = Object.keys(owned).map((relative) => hash(fs.readFileSync(path.join(home, relative))))

    sync(home, templateDir)

    const after = Object.keys(owned).map((relative) => hash(fs.readFileSync(path.join(home, relative))))
    expect(after).toEqual(before)
  })
})

describe("syncTemplateSkills: retiring a shipped skill", () => {
  it("removes only names the previous receipt claims Hundredfold shipped", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/retired/SKILL.md"), "# Retired\n")
    write(path.join(home, "skills/my-thing/SKILL.md"), "# Mine\n")
    fs.writeFileSync(receiptPath(home), JSON.stringify({ version: "0.30.0", skills: ["cron-manager", "retired"] }))

    const result = sync(home, templateDir)

    expect(result.removed).toEqual(["retired"])
    expect(fs.existsSync(path.join(home, "skills/retired"))).toBe(false)
    expect(fs.existsSync(path.join(home, "skills/my-thing/SKILL.md"))).toBe(true)
  })

  it("removes nothing on a first run and writes the receipt", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/legacy/SKILL.md"), "# Legacy\n")

    const result = sync(home, templateDir)

    expect(result.removed).toEqual([])
    expect(fs.existsSync(path.join(home, "skills/legacy/SKILL.md"))).toBe(true)
    expect(JSON.parse(fs.readFileSync(receiptPath(home), "utf8"))).toEqual({
      version: "0.31.0",
      skills: ["cron-manager", "notes"],
    })
  })
})

describe("syncTemplateSkills: recoverability", () => {
  it("backs up the pre-sync bytes of every file it overwrites or deletes", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/cron-manager/SKILL.md"), "# Cron Manager\nhand-edited\n")
    write(path.join(home, "skills/notes/SKILL.md"), "# Notes\n")
    write(path.join(home, "skills/notes/retired-helper.md"), "about to be deleted\n")

    const result = sync(home, templateDir)

    expect(result.backupDir).not.toBeNull()
    expect(fs.readFileSync(path.join(result.backupDir!, "skills/cron-manager/SKILL.md"), "utf8")).toBe("# Cron Manager\nhand-edited\n")
    expect(fs.readFileSync(path.join(result.backupDir!, "skills/notes/retired-helper.md"), "utf8")).toBe("about to be deleted\n")
  })

  it("backs up config.yaml and the ownership receipt before overwriting them", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/cron-manager/SKILL.md"), "# Cron Manager\nstale\n")
    const configBefore = fs.readFileSync(path.join(home, "config.yaml"), "utf8")
    const receiptBefore = JSON.stringify({ version: "0.30.0", skills: ["cron-manager"] })
    fs.writeFileSync(receiptPath(home), receiptBefore)

    const result = sync(home, templateDir)

    expect(fs.readFileSync(path.join(result.backupDir!, "config.yaml"), "utf8")).toBe(configBefore)
    expect(fs.readFileSync(path.join(result.backupDir!, ".hundredfold-template-skills.json"), "utf8")).toBe(receiptBefore)
  })

  it("is a no-op on a second run and creates no second backup directory", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/cron-manager/SKILL.md"), "# Cron Manager\nstale\n")
    sync(home, templateDir)
    const afterFirst = backupDirs(home)
    const configAfterFirst = fs.readFileSync(path.join(home, "config.yaml"), "utf8")

    const second = sync(home, templateDir)

    expect(second).toEqual({ added: [], updated: [], removed: [], backupDir: null })
    expect(backupDirs(home)).toEqual(afterFirst)
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).toBe(configAfterFirst)
  })
})

describe("syncTemplateSkills: path safety", () => {
  it("throws and writes nothing when a receipt name escapes the skills directory", () => {
    const { root, home, templateDir } = fixture()
    fs.writeFileSync(path.join(root, "outside.md"), "untouched\n")
    fs.writeFileSync(receiptPath(home), JSON.stringify({ version: "0.30.0", skills: ["../../outside.md"] }))

    expect(() => sync(home, templateDir)).toThrow(/inside the skills directory/)

    expect(fs.readFileSync(path.join(root, "outside.md"), "utf8")).toBe("untouched\n")
    expect(fs.existsSync(path.join(home, "skills/notes/SKILL.md"))).toBe(false)
    expect(backupDirs(home)).toEqual([])
  })

  it("replaces a symlinked destination with a regular file and leaves its target alone", () => {
    const { root, home, templateDir } = fixture()
    const target = path.join(root, "linked.md")
    fs.writeFileSync(target, "link target\n")
    fs.mkdirSync(path.join(home, "skills/cron-manager"), { recursive: true })
    fs.symlinkSync(target, path.join(home, "skills/cron-manager/SKILL.md"))

    sync(home, templateDir)

    const destination = path.join(home, "skills/cron-manager/SKILL.md")
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(destination, "utf8")).toBe(`# Cron Manager\nshipped by ${OLD.portalName}\n`) // rename:keep: the name a config with no portalName has always had
    expect(fs.readFileSync(target, "utf8")).toBe("link target\n")
  })

  it("refuses to write through a symlinked skill directory", () => {
    const { root, home, templateDir } = fixture()
    const outside = path.join(root, "outside-skill")
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, "SKILL.md"), "not ours\n")
    fs.mkdirSync(path.join(home, "skills"), { recursive: true })
    fs.symlinkSync(outside, path.join(home, "skills/cron-manager"))

    expect(() => sync(home, templateDir)).toThrow(/symlink/)

    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("not ours\n")
    expect(fs.lstatSync(path.join(home, "skills/cron-manager")).isSymbolicLink()).toBe(true)
  })

  it("refuses a receipt name that resolves to the skills directory itself", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/my-thing/SKILL.md"), "# Mine\n")
    fs.writeFileSync(receiptPath(home), JSON.stringify({ version: "0.30.0", skills: ["."] }))

    expect(() => sync(home, templateDir)).toThrow(/skills directory/)

    expect(fs.existsSync(path.join(home, "skills/my-thing/SKILL.md"))).toBe(true)
  })

  it("refuses a template entry that is a symlink instead of copying through it", () => {
    const { root, home, templateDir } = fixture()
    fs.writeFileSync(path.join(root, "secret.md"), "not ours to ship\n")
    fs.symlinkSync(path.join(root, "secret.md"), path.join(templateDir, "skills/notes/leaked.md"))

    expect(() => sync(home, templateDir)).toThrow(/not a regular file/)

    expect(fs.existsSync(path.join(home, "skills"))).toBe(false)
  })
})

describe("syncTemplateSkills: nothing is written until everything can be written", () => {
  it("refuses a config.yaml whose hundredfold key is not a mapping before touching a single skill", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/cron-manager/SKILL.md"), "# Cron Manager\nstale\n")
    fs.writeFileSync(path.join(home, "config.yaml"), "hundredfold: false\n")

    expect(() => sync(home, templateDir)).toThrow(/isn't a mapping/)

    expect(fs.readFileSync(path.join(home, "skills/cron-manager/SKILL.md"), "utf8")).toBe("# Cron Manager\nstale\n")
    expect(fs.existsSync(receiptPath(home))).toBe(false)
    expect(fs.existsSync(path.join(home, "skills/notes"))).toBe(false)
    expect(backupDirs(home)).toEqual([])
  })
})

describe("syncTemplateSkills: honest failure", () => {
  it("refuses a receipt that is present but unreadable instead of erasing the evidence", () => {
    const { home, templateDir } = fixture()
    write(path.join(home, "skills/retired/SKILL.md"), "# Retired\n")
    fs.writeFileSync(receiptPath(home), "{ not json")

    expect(() => sync(home, templateDir)).toThrow(/\.hundredfold-template-skills\.json/)

    expect(fs.existsSync(path.join(home, "skills/retired/SKILL.md"))).toBe(true)
    expect(fs.readFileSync(receiptPath(home), "utf8")).toBe("{ not json")
  })

  it("reports why a malformed config.yaml stopped the sync", () => {
    const { home, templateDir } = fixture()
    fs.writeFileSync(path.join(home, "config.yaml"), "hundredfold:\n  version: [\n")

    expect(() => sync(home, templateDir)).toThrow(/config\.yaml/)
  })
})
