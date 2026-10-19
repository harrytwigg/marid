import { fireEvent, render, screen, within } from "@testing-library/react"
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

import { EmployeeFallbackField, EmployeeFallbackRow, EmployeeFallbackSummary } from "./employee-fallback-field"
import { sameChain } from "./employee-fallback"

const model = (id: string) => ({ id, label: id, supportsEffort: false, effortLevels: [] })
const entry = (name: string) => ({ name, available: true, defaultModel: "m", effortMechanism: "none", models: [model("m")] })
const resolved = (engine: string, over: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink => ({
  engine, key: `${engine}|${over.profile ?? ""}|${over.model ?? ""}`, account: engine, label: engine, origin: "config", ...over,
})

const EMP: Employee = {
  name: "writer", displayName: "Writer", department: "content", rank: "employee",
  engine: "claude", model: "sonnet", persona: "p", claudeProfile: { path: "/profiles/work", key: "k" },
}

const subject = (kind: "engine" | "account" | "employee", id: string, configured: boolean, effective: ResolvedFallbackLink[]) => ({
  kind, id, primary: null, configured: configured ? effective.map(({ engine, profile, model: m }) => ({ engine, profile, model: m })) : null, legacy: false, effective,
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

describe("EmployeeFallbackField", () => {
  it("offers to use the default, naming where it comes from: the account when it writes a chain", () => {
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={null} onChange={() => {}} />)

    const choice = screen.getByRole("combobox", { name: "Fallback chain" }) as HTMLSelectElement
    expect(choice.value).toBe("inherit")
    expect(within(choice).getByRole("option", { name: "Use the default (from Claude · work)" })).toBeTruthy()
    expect(within(choice).getByRole("option", { name: "Custom" })).toBeTruthy()
    // The default's own chain, read-only: no rows to edit.
    expect(screen.getByText("opencode · x/y")).toBeTruthy()
    expect(document.querySelector("[data-chain-row]")).toBeNull()
  })

  it("names the engine when the employee is on no declared account", () => {
    render(<EmployeeFallbackField employee={{ ...EMP, claudeProfile: null }} engine="claude" value={null} onChange={() => {}} />)

    expect(screen.getByRole("option", { name: "Use the default (from Claude)" })).toBeTruthy()
    expect(screen.getByText("Codex")).toBeTruthy()
  })

  it("starts Custom from the chain the default runs, so it is edited rather than rebuilt", () => {
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={null} onChange={onChange} />)

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback chain" }), { target: { value: "custom" } })

    expect(onChange).toHaveBeenCalledWith([{ engine: "opencode", model: "x/y" }])
  })

  it("goes back to the default with null", () => {
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={[{ engine: "codex" }]} onChange={onChange} />)

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback chain" }), { target: { value: "inherit" } })

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it("edits a custom chain on the same rows an engine chain has", () => {
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={[{ engine: "claude" }]} onChange={onChange} />)

    // A Claude row takes a profile, from the declared accounts.
    const profile = screen.getByRole("combobox", { name: "Profile of link 1 of the Writer chain" })
    fireEvent.change(profile, { target: { value: "work" } })
    expect(onChange).toHaveBeenCalledWith([{ engine: "claude", profile: "work" }])

    fireEvent.click(screen.getByRole("button", { name: "Add a target to the Writer chain" }))
    expect(onChange).toHaveBeenLastCalledWith([{ engine: "claude" }, { engine: "codex" }])
  })

  it("refuses the employee own target in the loader sentence", () => {
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={[{ engine: "claude", profile: "work" }]} onChange={() => {}} />)

    expect(document.querySelector("[data-chain-problem]")?.textContent).toBe(
      "fallback[0] (claude · work) is the target this chain falls back from; give it another profile or model",
    )
  })

  it("shows the gateway's problems with the employee chain, whichever way it is set", () => {
    chains.current = {
      profiles: [],
      subjects: [{ ...subject("employee", "writer", true, []), problems: ["fallback[0]: \"nope\" is not a known engine (claude, codex)"] }],
    }
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={[{ engine: "codex" }]} onChange={() => {}} />)

    expect(screen.getByText('fallback[0]: "nope" is not a known engine (claude, codex)').getAttribute("role")).toBe("alert")
  })

  it("says an empty custom chain means no fallback", () => {
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={[]} onChange={() => {}} />)

    expect(screen.getByText("No fallback. Claude waits for its own limit to reset.")).toBeTruthy()
  })
})

describe("an employee chain written in engine names", () => {
  // The gateway may hand an employee chain back as the names it was written in.
  const legacy = { ...EMP, fallback: ["codex"] } as unknown as Employee
  const effective = [resolved("codex"), resolved("opencode", { model: "x/y", origin: "legacy" })]

  beforeEach(() => {
    chains.current = { profiles: [], subjects: [{ ...subject("employee", "writer", true, effective), legacy: true }] }
  })

  it("shows what runs, marks the link another chain contributed, and says so once", () => {
    render(<EmployeeFallbackField employee={legacy} engine="claude" value={[{ engine: "codex" }]} onChange={() => {}} />)

    expect(Array.from(document.querySelectorAll("[data-chain-row]")).map((r) => r.getAttribute("data-chain-row"))).toEqual(["codex", "opencode · x/y"])
    expect(document.querySelectorAll("[data-chain-expanded]").length).toBe(1)
    expect(document.querySelector("[data-chain-legacy-notice]")).toBeTruthy()
  })

  it("writes the whole effective chain, as links, on the first edit, so the expansion is not lost", () => {
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={legacy} engine="claude" value={[{ engine: "codex" }]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Move opencode · x/y earlier in the Writer chain" }))

    expect(onChange).toHaveBeenCalledWith([{ engine: "opencode", model: "x/y" }, { engine: "codex" }])
  })
})

describe("choosing Custom before the gateway has answered", () => {
  it("is not offered, and does nothing if forced, rather than writing an empty chain that means no fallback", () => {
    chains.current = undefined
    const onChange = vi.fn()
    render(<EmployeeFallbackField employee={EMP} engine="claude" value={null} onChange={onChange} />)

    expect((screen.getByRole("option", { name: "Custom" }) as HTMLOptionElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole("combobox", { name: "Fallback chain" }), { target: { value: "custom" } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("a chain with a problem", () => {
  it("tells the editor to hold the save, and lets go once it is valid", () => {
    const onBlockedChange = vi.fn()
    const { rerender } = render(<EmployeeFallbackField employee={EMP} engine="claude" value={[{ engine: "claude", profile: "work" }]} onChange={() => {}} onBlockedChange={onBlockedChange} />)
    expect(onBlockedChange).toHaveBeenLastCalledWith(true)

    rerender(<EmployeeFallbackField employee={EMP} engine="claude" value={[{ engine: "codex" }]} onChange={() => {}} onBlockedChange={onBlockedChange} />)
    expect(onBlockedChange).toHaveBeenLastCalledWith(false)
  })
})

describe("a chain stored with a repeated target", () => {
  const stored = { ...EMP, fallback: [{ engine: "codex" }, { engine: "codex" }] } as Employee

  it("does not hold a save of something else: the chain was not touched", () => {
    const onBlockedChange = vi.fn()
    render(<EmployeeFallbackField employee={stored} engine="claude" value={[{ engine: "codex" }, { engine: "codex" }]} onChange={() => {}} onBlockedChange={onBlockedChange} />)

    expect(document.querySelector("[data-chain-problem]")).toBeTruthy()
    expect(onBlockedChange).toHaveBeenLastCalledWith(false)
  })

  it("holds the save once the chain is edited and still repeats the target", () => {
    const onBlockedChange = vi.fn()
    render(<EmployeeFallbackField employee={stored} engine="claude" value={[{ engine: "codex" }, { engine: "codex" }, { engine: "opencode" }]} onChange={() => {}} onBlockedChange={onBlockedChange} />)

    expect(onBlockedChange).toHaveBeenLastCalledWith(true)
  })
})

describe("sameChain", () => {
  it("compares links, not the order their fields were written in", () => {
    expect(sameChain([{ engine: "claude", model: "opus", profile: "A" }], [{ engine: "claude", profile: "A", model: "opus" }])).toBe(true)
    expect(sameChain([{ engine: "claude" }], [{ engine: "claude", profile: "A" }])).toBe(false)
    expect(sameChain(null, [])).toBe(false)
    expect(sameChain(null, null)).toBe(true)
  })
})

describe("EmployeeFallbackRow for a system employee", () => {
  it("shows the chain it follows, with nothing to edit, because the gateway refuses to set it", () => {
    chains.current = { profiles: [], subjects: [subject("employee", "writer", false, [resolved("codex")])] }
    render(<EmployeeFallbackRow employee={EMP} engine="claude" value={null} onChange={() => {}} locked />)

    expect(document.querySelector("[data-employee-fallback-row=locked]")).toBeTruthy()
    expect(document.querySelector("[data-fallback-list] li")?.textContent).toBe("1. Codex")
    expect(screen.queryByRole("combobox", { name: "Fallback chain" })).toBeNull()
  })
})

describe("EmployeeFallbackSummary", () => {
  it("lists the chain that would run, read-only, and says it is the default", () => {
    chains.current = { profiles: [], subjects: [subject("employee", "writer", false, [resolved("codex"), resolved("opencode", { model: "x/y" })])] }
    render(<EmployeeFallbackSummary employee={EMP} />)

    const list = document.querySelector("[data-fallback-list]")!
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["1. Codex", "2. opencode · x/y"])
    expect(screen.getByText(/the default/)).toBeTruthy()
  })

  it("says custom when the employee writes its own", () => {
    chains.current = { profiles: [], subjects: [subject("employee", "writer", true, [resolved("codex")])] }
    render(<EmployeeFallbackSummary employee={EMP} />)

    expect(screen.getByText(/custom/)).toBeTruthy()
  })

  it("shows nothing until the gateway has a chain to show", () => {
    chains.current = undefined
    render(<EmployeeFallbackSummary employee={EMP} />)

    expect(document.querySelector("[data-employee-fallback-summary]")).toBeNull()
  })
})
