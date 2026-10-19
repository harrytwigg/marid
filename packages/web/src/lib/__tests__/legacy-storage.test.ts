import { beforeEach, describe, expect, it, vi } from "vitest"
import { deleteLegacyShellCache, migrateLegacyStorage } from "../legacy-storage"

/** What a browser that used the app before a rename really holds: plain keys, the dotted and colon forms the
 *  desktop app and the notes editor use, and dynamic tails (a session id, an origin, a note path). */
const REAL_SHAPED: Record<string, string> = {
  "jinn-settings": '{"theme":"dark"}',
  "jinn-theme": "dark",
  "jinn-onboarded": "true",
  "jinn-chat-tabs": '["s1"]',
  "jinn-view-mode-4f1c": "terminal",
  "jinn-chat-draft:https://gw.example:": "half a message",
  "jinn.native.gateway-profiles.v1": '{"profiles":[{"id":"a","origin":"https://gw.example"}],"activeId":"a"}',
  "jinn.native.active-origin": "https://gw.example",
  "jinn.plugin.notes.collapsed": "1",
  "jinn:note-draft:v1:knowledge/plan.md": "# unsaved",
  "jinn:notes:last-location:v1": "knowledge/plan.md",
  "theme-other-app": "kept",
}

let storage: Storage
beforeEach(() => {
  storage = window.localStorage
  storage.clear()
  for (const [key, value] of Object.entries(REAL_SHAPED)) storage.setItem(key, value)
})

describe("migrateLegacyStorage", () => {
  it("copies every key under all three prefixes, dynamic tails included, to the new prefix", () => {
    const copied = migrateLegacyStorage(storage, "acme")
    expect(copied).toBe(11)
    expect(storage.getItem("acme-settings")).toBe('{"theme":"dark"}')
    expect(storage.getItem("acme-view-mode-4f1c")).toBe("terminal")
    expect(storage.getItem("acme-chat-draft:https://gw.example:")).toBe("half a message")
    expect(storage.getItem("acme.native.gateway-profiles.v1")).toBe(REAL_SHAPED["jinn.native.gateway-profiles.v1"])
    expect(storage.getItem("acme.native.active-origin")).toBe("https://gw.example")
    expect(storage.getItem("acme.plugin.notes.collapsed")).toBe("1")
    expect(storage.getItem("acme:note-draft:v1:knowledge/plan.md")).toBe("# unsaved")
    expect(storage.getItem("acme:notes:last-location:v1")).toBe("knowledge/plan.md")
  })

  it("keeps the old keys, so an older build run again still finds its state", () => {
    migrateLegacyStorage(storage, "acme")
    for (const [key, value] of Object.entries(REAL_SHAPED)) expect(storage.getItem(key)).toBe(value)
    expect(storage.getItem("acme-theme-other-app")).toBeNull()
  })

  it("copies once: a later change under the old key is not copied over a newer value", () => {
    migrateLegacyStorage(storage, "acme")
    storage.setItem("acme-theme", "light")
    storage.setItem("jinn-theme", "sepia")
    expect(migrateLegacyStorage(storage, "acme")).toBe(0)
    expect(storage.getItem("acme-theme")).toBe("light")
  })

  it("never overwrites a key the new prefix already holds", () => {
    storage.setItem("acme-theme", "light")
    migrateLegacyStorage(storage, "acme")
    expect(storage.getItem("acme-theme")).toBe("light")
    expect(storage.getItem("acme-settings")).toBe('{"theme":"dark"}')
  })

  it("does nothing while the codename is unchanged", () => {
    expect(migrateLegacyStorage(storage, "jinn")).toBe(0)
    expect(storage.length).toBe(Object.keys(REAL_SHAPED).length)
  })

  it("leaves a storage that refuses to be read or written alone", () => {
    const blocked = { getItem: vi.fn(() => { throw new Error("blocked") }), length: 0 } as unknown as Storage
    expect(migrateLegacyStorage(blocked, "acme")).toBe(0)
  })
})

describe("deleteLegacyShellCache", () => {
  it("deletes the orphaned service-worker cache once the name has changed", async () => {
    const cacheStorage = { delete: vi.fn(async () => true) }
    expect(await deleteLegacyShellCache(cacheStorage, "acme")).toBe(true)
    expect(cacheStorage.delete).toHaveBeenCalledWith("jinn-app-shell")
  })

  it("leaves the cache alone while it is this build's own, and when there is no cache storage", async () => {
    const cacheStorage = { delete: vi.fn(async () => true) }
    expect(await deleteLegacyShellCache(cacheStorage, "jinn")).toBe(false)
    expect(cacheStorage.delete).not.toHaveBeenCalled()
    expect(await deleteLegacyShellCache(undefined, "acme")).toBe(false)
  })

  it("does not let a failing cache storage break start-up", async () => {
    expect(await deleteLegacyShellCache({ delete: async () => { throw new Error("denied") } }, "acme")).toBe(false)
  })
})
