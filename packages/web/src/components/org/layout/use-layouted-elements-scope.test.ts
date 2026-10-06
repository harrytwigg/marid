import { describe, expect, it } from "vitest"
import type { Employee, OrgHierarchy } from "@/lib/api"
import { computeOrgLayout } from "./use-layouted-elements"

/* The org tree stamps each department's group box with its scope; an open department's carries none. */

const emp = (name: string, department: string, extra: Partial<Employee> = {}): Employee =>
  ({ name, displayName: name, department, rank: "employee", engine: "claude", model: "sonnet", persona: "x", chain: [name], ...extra }) as Employee

const employees = [
  emp("coo", "", { rank: "executive" }),
  emp("eng-dev", "engineering", { rank: "manager" }),
  emp("side-dev", "side-project", { rank: "manager" }),
]
const hierarchy: OrgHierarchy = { root: "coo", sorted: ["eng-dev", "side-dev"], warnings: [] }

const groups = (scopes?: Record<string, "scoped" | "dedicated">) =>
  Object.fromEntries(
    computeOrgLayout(employees, hierarchy, null, scopes)
      .nodes.filter((node) => node.type === "departmentGroup")
      .map((node) => [(node.data as { label: string }).label, (node.data as { scope?: string }).scope]),
  )

describe("computeOrgLayout scopes", () => {
  it("stamps a scoped department's group box and leaves the others without a scope", () => {
    expect(groups({ "side-project": "scoped" })).toEqual({ engineering: undefined, "side-project": "scoped" })
  })

  it("stamps a dedicated one", () => {
    expect(groups({ engineering: "dedicated" })).toEqual({ engineering: "dedicated", "side-project": undefined })
  })

  it("is the layout it always was when no scopes are passed", () => {
    const plain = computeOrgLayout(employees, hierarchy, null)
    const none = computeOrgLayout(employees, hierarchy, null, {})
    expect(none.nodes.map((n) => [n.id, n.position])).toEqual(plain.nodes.map((n) => [n.id, n.position]))
    expect(groups()).toEqual({ engineering: undefined, "side-project": undefined })
  })
})
