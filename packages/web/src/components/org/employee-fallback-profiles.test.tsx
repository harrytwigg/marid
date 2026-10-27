import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FallbackChainsResponse } from "@jinn/fallback-chain-wire"
import type { Employee } from "@/lib/api"

const registry = vi.hoisted(() => ({ current: undefined as unknown }))
const chains = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock("@/hooks/use-model-registry", async (importActual) => ({
  ...(await importActual<typeof import("@/hooks/use-model-registry")>()),
  useModelRegistry: () => ({ data: registry.current }),
}))
vi.mock("@/hooks/use-fallback-chains", async (importActual) => ({
  ...(await importActual<typeof import("@/hooks/use-fallback-chains")>()),
  useFallbackChains: () => ({ data: chains.current }),
}))

import { EmployeeFallbackField } from "./employee-fallback-field"
import { chainBlocked, declaredAccountOf, employeeDestination, fallbackFieldState, profileLabels, profilesForEmployee } from "./employee-fallback"

/* Which declared accounts an employee's chain may name: a remote employee's are the remote accounts on
 * its own user@host, a local employee's the local ones, and its own account is found the same way. */

const model = (id: string) => ({ id, label: id, supportsEffort: false, effortLevels: [] })
const entry = (name: string) => ({ name, available: true, defaultModel: "m", effortMechanism: "none", models: [model("m")] })

const CHAINS: FallbackChainsResponse = {
  profiles: [
    { name: "work", account: "claude:k1", configDir: "/home/me/.claude-b" },
    { name: "spare", account: "claude@me@build-host:k2", configDir: "/home/me/.claude-b", remote: { host: "build-host", destination: "me@build-host" } },
    { name: "bare", account: "claude@build-host:k3", configDir: "/home/me/.claude-c", remote: { host: "build-host", destination: "build-host" } },
    { name: "elsewhere", account: "claude@me@other-host:k4", configDir: "/home/me/.claude-d", remote: { host: "other-host", destination: "me@other-host" } },
  ],
  subjects: [],
}

const LOCAL: Employee = {
  name: "writer", displayName: "Writer", department: "content", rank: "employee",
  engine: "claude", model: "sonnet", persona: "p", claudeProfile: { path: "/home/me/.claude-b", key: "k1" },
}
const REMOTE: Employee = {
  ...LOCAL, name: "builder", displayName: "Builder", claudeProfile: null,
  remoteHost: "build-host", remoteUser: "me", remoteClaudeConfigDir: "/home/me/.claude-b",
}

beforeEach(() => {
  registry.current = { default: "claude", engines: { claude: entry("claude"), codex: entry("codex") } }
  chains.current = CHAINS
})

describe("profilesForEmployee", () => {
  it("gives a local employee only the local accounts", () => {
    expect(profilesForEmployee(LOCAL, CHAINS).map((p) => p.name)).toEqual(["work"])
  })

  it("gives a remote employee only the remote accounts on its own user@host", () => {
    expect(profilesForEmployee(REMOTE, CHAINS).map((p) => p.name)).toEqual(["spare"])
  })

  it("matches an employee with no user on the bare host, and never across users", () => {
    expect(profilesForEmployee({ ...REMOTE, remoteUser: undefined }, CHAINS).map((p) => p.name)).toEqual(["bare"])
    expect(profilesForEmployee({ ...REMOTE, remoteUser: "you" }, CHAINS)).toEqual([])
  })

  it("names the destination for the host, and none for a local employee", () => {
    expect(employeeDestination(REMOTE)).toBe("me@build-host")
    expect(employeeDestination(LOCAL)).toBeUndefined()
  })

  it("labels a remote account with its destination and leaves a local one as its name", () => {
    expect(profileLabels(CHAINS.profiles)).toEqual({
      spare: "spare (me@build-host)", bare: "bare (build-host)", elsewhere: "elsewhere (me@other-host)",
    })
  })
})

describe("declaredAccountOf", () => {
  it("finds a local employee's account by directory among the local accounts only", () => {
    // The remote account has the same path; it is on another machine and is not this profile.
    expect(declaredAccountOf(LOCAL, CHAINS)).toBe("work")
    expect(declaredAccountOf(LOCAL, { ...CHAINS, profiles: CHAINS.profiles.slice(1) })).toBeUndefined()
  })

  it("finds a remote employee's account by destination and directory", () => {
    expect(declaredAccountOf(REMOTE, CHAINS)).toBe("spare")
    expect(declaredAccountOf({ ...REMOTE, remoteClaudeConfigDir: "/home/me/.claude-b/" }, CHAINS)).toBe("spare")
  })

  it("finds none for a remote employee that names no directory, or one that is not a declared account", () => {
    expect(declaredAccountOf({ ...REMOTE, remoteClaudeConfigDir: undefined }, CHAINS)).toBeUndefined()
    expect(declaredAccountOf({ ...REMOTE, remoteClaudeConfigDir: "/home/me/.claude-z" }, CHAINS)).toBeUndefined()
    expect(declaredAccountOf({ ...REMOTE, remoteHost: "other-host" }, CHAINS)).toBeUndefined()
  })
})

describe("the chain editor for a remote employee", () => {
  it("offers the default profile and its own host's accounts, labelled with the host", () => {
    render(<EmployeeFallbackField employee={REMOTE} engine="claude" value={[{ engine: "claude" }]} onChange={() => {}} />)

    const profile = screen.getByRole("combobox", { name: "Profile of link 1 of the Builder chain" })
    expect(within(profile).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default profile", "spare (me@build-host)"])
  })

  it("offers a local employee only its local accounts", () => {
    render(<EmployeeFallbackField employee={LOCAL} engine="claude" value={[{ engine: "claude" }]} onChange={() => {}} />)

    const profile = screen.getByRole("combobox", { name: "Profile of link 1 of the Writer chain" })
    expect(within(profile).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default profile", "work"])
  })

  it("tells an account on the wrong side from the host, and keeps 'names no account' for a name declared nowhere", () => {
    const show = (employee: Employee, profile: string) => {
      const { unmount } = render(<EmployeeFallbackField employee={employee} engine="claude" value={[{ engine: "claude", profile }]} onChange={() => {}} />)
      const shown = [...document.querySelectorAll("[data-chain-problem]")].map((p) => p.textContent)
      unmount()
      return shown
    }
    expect(show(REMOTE, "work")).toEqual(['fallback[0]: profile "work" is a local profile; a remote employee falls back only to an account declared with remoteHost build-host'])
    expect(show(REMOTE, "elsewhere")).toEqual(['fallback[0]: profile "elsewhere" is declared on me@other-host, not me@build-host'])
    expect(show(LOCAL, "spare")).toEqual(['fallback[0]: profile "spare" is declared on me@build-host; a local employee falls back only to a local account'])
    expect(show(REMOTE, "ghost")).toEqual(['fallback[0]: profile "ghost" names no account under engines.claude.accounts'])
    expect(show(REMOTE, "bare")).toEqual(['fallback[0]: profile "bare" is declared on build-host, not me@build-host'])
    // Its own host's account raises nothing (this employee names no directory, so it is not its own target).
    expect(show({ ...REMOTE, remoteClaudeConfigDir: undefined }, "spare")).toEqual([])
  })

  it("holds a save whose chain names a local profile, and lets one that names its own host's account through", () => {
    const registryValue = registry.current as never
    const own = (links: { engine: string; profile?: string }[]) => ({ links, expanded: links.map(() => false), legacy: false })
    const { accounts } = fallbackFieldState(REMOTE, "claude", null, CHAINS)
    expect(chainBlocked(registryValue, own([{ engine: "claude", profile: "work" }]), [], accounts, true)).toBe(true)
    expect(chainBlocked(registryValue, own([{ engine: "claude", profile: "elsewhere" }]), [], accounts, true)).toBe(true)
    expect(chainBlocked(registryValue, own([{ engine: "claude", profile: "ghost" }]), [], accounts, true)).toBe(true)
    expect(chainBlocked(registryValue, own([{ engine: "claude", profile: "spare" }]), [], accounts, true)).toBe(false)
  })

  it("keeps a remote employee's own declared account out of its own chain, with or without the profile", () => {
    // spare is this employee's own login: a chain naming it, spelled either way, is its own target.
    const registryValue = registry.current as never
    const own = (links: { engine: string; profile?: string }[]) => ({ links, expanded: links.map(() => false), legacy: false })
    const selves = [{ engine: "claude", profile: "spare", model: "sonnet" }, { engine: "claude", profile: "spare" }, { engine: "claude" }, { engine: "claude", model: "sonnet" }]
    expect(chainBlocked(registryValue, own([{ engine: "claude", profile: "spare" }]), selves, { names: ["spare"] }, true)).toBe(true)
  })
})

describe("what a remote employee inherits", () => {
  it("is its engine's chain, even when its directory is a declared remote account", () => {
    const withEngineChain: FallbackChainsResponse = {
      ...CHAINS,
      subjects: [{
        kind: "engine", id: "claude", primary: null, configured: null, legacy: false,
        effective: [{ engine: "codex", key: "codex||", account: "codex", label: "codex", origin: "config" }],
      }],
    }
    const state = fallbackFieldState(REMOTE, "claude", null, withEngineChain)
    expect(state.inherited).toMatchObject({ label: "Claude", source: "engine", links: [{ engine: "codex" }] })
    // The own target is still its declared account, for refusing a link to it.
    expect(state.self).toMatchObject({ engine: "claude", profile: "spare" })
  })

  it("is still a local employee's account chain when it is on a declared account", () => {
    const state = fallbackFieldState(LOCAL, "claude", null, CHAINS)
    expect(state.inherited).toMatchObject({ label: "Claude · work", source: "account" })
  })
})
