import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FallbackChainsResponse, ResolvedFallbackLink } from "@jinn/fallback-chain-wire"
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

const model = (id: string) => ({ id, label: id, supportsEffort: false, effortLevels: [] })
const entry = (name: string) => ({ name, available: true, defaultModel: "m", effortMechanism: "none", models: [model("m")] })
const resolved = (engine: string, over: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink => ({
  engine, key: `${engine}|${over.profile ?? ""}|${over.model ?? ""}`, account: engine, label: engine, origin: "config", ...over,
})

const EMP: Employee = {
  name: "writer", displayName: "Writer", department: "content", rank: "employee",
  engine: "claude", model: "sonnet", persona: "p", claudeProfile: { path: "/profiles/work", key: "k" },
}

const subject = (
  kind: "engine" | "account" | "employee", id: string, configured: boolean, effective: ResolvedFallbackLink[],
  from?: { source: "employee" | "account" | "engine" | "none"; sourceId?: string },
) => ({
  kind, id, primary: null, configured: configured ? effective.map(({ engine, profile, model: m }) => ({ engine, profile, model: m })) : null, legacy: false, effective,
  ...(from ?? {}),
})

beforeEach(() => {
  registry.current = { default: "claude", engines: { claude: entry("claude"), codex: entry("codex"), opencode: entry("opencode") } }
  chains.current = {
    profiles: [{ name: "work", account: "claude:k", configDir: "/profiles/work" }],
    subjects: [
      subject("engine", "claude", true, [resolved("codex")]),
      subject("account", "work", true, [resolved("opencode", { model: "x/y" })]),
    ],
  } satisfies FallbackChainsResponse
})


beforeEach(() => {
  registry.current = { default: "claude", engines: { claude: entry("claude"), codex: entry("codex"), opencode: entry("opencode") } }
  chains.current = {
    profiles: [{ name: "work", account: "claude:k", configDir: "/profiles/work" }],
    subjects: [
      subject("engine", "claude", true, [resolved("codex")]),
      subject("account", "work", true, [resolved("opencode", { model: "x/y" })]),
    ],
  } satisfies FallbackChainsResponse
})

describe("the chain an employee inherits, in the gateway's order", () => {
  const profiles = [{ name: "work", account: "claude:k", configDir: "/profiles/work" }]
  const engineChain = subject("engine", "claude", true, [resolved("codex")])

  it("on a declared account that writes no chain is none, not the engine's", () => {
    chains.current = { profiles, subjects: [engineChain, subject("account", "work", false, [])] }
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={null} onChange={() => {}} />)

    expect(screen.getByRole("option", { name: "Use the default (from Claude · work)" })).toBeTruthy()
    expect(screen.getByText("No fallback. Claude waits for its own limit to reset.")).toBeTruthy()
    expect(screen.queryByText("Codex")).toBeNull()
  })

  it("on a named profile that is not declared is none, and says so", () => {
    chains.current = { profiles, subjects: [engineChain] }
    const undeclared = { ...EMP, claudeProfile: { path: "/profiles/other", key: "o" } }
    render(<EmployeeFallbackField employee={undeclared} engine="claude" value={null} onChange={() => {}} />)

    expect(screen.getByRole("option", { name: "Use the default (from Claude · a profile with no declared account)" })).toBeTruthy()
    expect(document.querySelector("[data-no-fallback]")?.getAttribute("data-no-fallback")).toBe("undeclared")
    expect(screen.getByText(/not a declared account\. Declare it under engines\.claude\.accounts/)).toBeTruthy()
    // Never the plain wording, which reads as a deliberate choice.
    expect(screen.queryByText("No fallback. Claude waits for its own limit to reset.")).toBeNull()
  })

  it("on the default profile is the engine's chain", () => {
    chains.current = { profiles, subjects: [engineChain] }
    render(<EmployeeFallbackField employee={{ ...EMP, claudeProfile: null }} engine="claude" value={null} onChange={() => {}} />)

    expect(screen.getByText("Codex")).toBeTruthy()
  })
})


describe("the chain an employee inherits comes from the gateway", () => {
  it("is the employee subject's effective chain, unchanged, whatever the account and engine subjects say", () => {
    chains.current = {
      profiles: [{ name: "work", account: "claude:k", configDir: "/profiles/work" }],
      subjects: [
        subject("engine", "claude", true, [resolved("codex")]),
        subject("account", "work", true, [resolved("codex")]),
        subject("employee", "writer", false, [resolved("opencode", { model: "x/y" }), resolved("grok")], { source: "account", sourceId: "work" }),
      ],
    }
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={null} onChange={() => {}} />)
    expect(screen.getByRole("option", { name: "Use the default (from Claude · work)" })).toBeTruthy()

    expect(Array.from(document.querySelectorAll("[data-fallback-list] li")).map((li) => li.textContent)).toEqual(["1. opencode · x/y", "2. Grok"])
    // The gateway is the source here, so it is not presented as a preview.
    expect(document.querySelector("[data-chain-preview]")).toBeNull()
  })

  it("starts Custom from that chain, and says none when the gateway reports none", () => {
    chains.current = {
      profiles: [],
      subjects: [subject("engine", "claude", true, [resolved("codex")]), subject("employee", "writer", false, [], { source: "engine", sourceId: "claude" })],
    }
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={{ ...EMP, claudeProfile: null }} engine="claude" value={null} onChange={onChange} />)
    expect(screen.getByText("No fallback. Claude waits for its own limit to reset.")).toBeTruthy()

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback chain" }), { target: { value: "custom" } })
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("is a marked preview, worked out here, when the engine on screen is not the saved one", () => {
    chains.current = {
      profiles: [],
      subjects: [
        subject("engine", "claude", true, [resolved("opencode")]),
        subject("engine", "codex", true, [resolved("grok")]),
        subject("employee", "writer", false, [resolved("opencode")]),
      ],
    }
    render(<EmployeeFallbackField employee={{ ...EMP, claudeProfile: null }} engine="codex" value={null} onChange={() => {}} />)

    expect(Array.from(document.querySelectorAll("[data-fallback-list] li")).map((li) => li.textContent)).toEqual(["1. Grok"])
    expect(document.querySelector("[data-chain-preview]")?.textContent).toBe("(preview, until you save)")
  })

  it("is worked out from the account or engine only for a draft: the stored chain is custom and the operator chose the default", () => {
    chains.current = {
      profiles: [],
      subjects: [subject("engine", "claude", true, [resolved("codex")]), subject("employee", "writer", true, [resolved("opencode")])],
    }
    render(<EmployeeFallbackField employee={{ ...EMP, claudeProfile: null, fallback: [{ engine: "opencode" }] } as Employee} engine="claude" value={null} onChange={() => {}} />)

    expect(Array.from(document.querySelectorAll("[data-fallback-list] li")).map((li) => li.textContent)).toEqual(["1. Codex"])
    expect(document.querySelector("[data-chain-preview]")?.textContent).toBe("(preview, until you save)")
  })
})


describe("the gateway's sentence about a stored employee chain", () => {
  const sentence = "fallback[1] duplicates fallback[0] (codex): a chain tries each target once, so list it once"
  const stored = { ...EMP, fallback: [{ engine: "codex" }, { engine: "codex" }] } as Employee
  const dup = [{ engine: "codex" }, { engine: "codex" }]

  beforeEach(() => {
    chains.current = { profiles: [], subjects: [{ ...subject("employee", "writer", true, []), problems: [sentence] }] }
  })

  it("shows once while the chain is as stored, with the row's own sentence", () => {
    render(<EmployeeFallbackField employee={stored} engine="claude" value={dup} onChange={() => {}} />)

    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  it("is gone once the operator has edited the chain, since it describes what was stored", () => {
    render(<EmployeeFallbackField employee={stored} engine="claude" value={[{ engine: "codex" }]} onChange={() => {}} />)

    expect(screen.queryByText(sentence)).toBeNull()
  })
})

describe("the gateway's source decides an employee's inherited chain", () => {
  it("shows a named profile the gateway reports as none with the undeclared wording, whatever the account subjects say", () => {
    chains.current = {
      profiles: [{ name: "work", account: "claude:k", configDir: "/profiles/work" }],
      subjects: [subject("account", "work", true, [resolved("codex")]), subject("employee", "writer", false, [], { source: "none" })],
    }
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={null} onChange={() => {}} />)
    expect(document.querySelector("[data-no-fallback]")?.getAttribute("data-no-fallback")).toBe("undeclared")
    expect(document.querySelector("[data-chain-preview]")).toBeNull()
  })

  it("starts Custom from the links as written, never the models the gateway filled in to run", () => {
    chains.current = {
      profiles: [{ name: "B", account: "claude:b", configDir: "/profiles/b" }],
      subjects: [subject("employee", "writer", false, [
        resolved("claude", { profile: "B", model: "sonnet", key: "claude|B|sonnet", written: { engine: "claude", profile: "B" } }),
        resolved("codex", { model: "gpt-mapped", key: "codex||gpt-mapped", written: { engine: "codex" } }),
      ], { source: "engine", sourceId: "claude" })],
    }
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={{ ...EMP, claudeProfile: null }} engine="claude" value={null} onChange={onChange} />)
    fireEvent.change(screen.getByRole("combobox", { name: "Fallback chain" }), { target: { value: "custom" } })
    expect(onChange).toHaveBeenCalledWith([{ engine: "claude", profile: "B" }, { engine: "codex" }])
  })
})
