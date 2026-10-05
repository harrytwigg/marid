import { describe, expect, it } from "vitest"
import { matchAppRoute } from "../app-routes"
import { navigationFor } from "../nav"
import { TALK_SURFACE_COVERAGE } from "@/components/talk/context/coverage"
import { describeLocation } from "@/components/talk/context/page-snapshot"

describe("the Projects page route", () => {
  it("is a core route with semantic Talk coverage", () => {
    const route = matchAppRoute("/projects")
    expect(route?.id).toBe("projects")
    expect(TALK_SURFACE_COVERAGE.projects).toMatchObject({ status: "supported" })
  })

  it("has a nav entry after Todos, reachable from the mobile overflow", () => {
    const nav = navigationFor(false)
    const hrefs = nav.items.map((item) => item.href)
    expect(hrefs.indexOf("/projects")).toBe(hrefs.indexOf("/todos") + 1)
    expect(nav.overflowHrefs).toContain("/projects")
  })

  it("is described to Talk as its own page, and the board reports its project filter", () => {
    expect(describeLocation("/projects", "").kind).toBe("projects")
    expect(describeLocation("/projects/extra", "").kind).toBe("other")
    expect(describeLocation("/todos", "?project=prj_garden000001").filters).toMatchObject({ project: "prj_garden000001" })
  })
})
