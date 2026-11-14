import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { useRouteParams } from "@hundredfoldhq/plugin-sdk"
import { contributions } from "@/contrib/registry"
import { AREAS } from "@/contrib/types"
import { scanDiskPlugins } from "@/plugins/disk-plugins"
import { ContributedRoute, contributedRouteFor, firstSegment, reservedSegments } from "../contributed-route"

// The host wraps a contributed page in the app's chrome. That chrome is the
// whole dashboard shell, and these cases are about routing, so it stands in as
// a passthrough — the same substitution the settings suite makes.
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

/**
 * The `routes` host. Three properties matter and are tested as three: a
 * contributed page is reachable, a nested path resolves to the right one of a
 * plugin's own pages with its parameters captured, and a contribution that
 * names one of the app's own routes is dropped rather than served in its place.
 */

const RESERVED = reservedSegments(["/", "/settings", "/notes/*", "/todos/:todoId"])

const disposers: (() => void)[] = []
let warn: ReturnType<typeof vi.spyOn>

/** A contribution under an id nothing else has used. The host explains a
 *  rejection once per id for the life of the module, so cases that share one
 *  would be reading each other's console. */
let counter = 0
function contribute(name: string, data: unknown, render?: () => ReactNode): string {
  const id = `${name}-${(counter += 1)}`
  disposers.push(contributions.register({ id, area: AREAS.routes, data, render }, `plugin:${id}`))
  return id
}

const routesArea = () => contributions.getArea(AREAS.routes)

/** Every line the host has explained a rejection with so far. */
const warnings = (): string[] => warn.mock.calls.map((call: unknown[]) => String(call[0]))

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks()
})

/* First in the file on purpose: "the plugins have been looked for" is a
 * one-way flag, so the window before it flips can only be observed before
 * anything else settles it. */
describe("before the plugins have been looked for", () => {
  it("waits at an unclaimed URL rather than bouncing a bookmarked plugin page", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/inbox-demo"]}>
        <Routes>
          <Route path="/" element={<p>chat</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(container.textContent).toBe("")
  })
})

describe("reservedSegments", () => {
  it("claims the whole subtree a parameterised or splat route owns", () => {
    expect(firstSegment("/notes/*")).toBe("/notes")
    expect(firstSegment("/todos/:todoId")).toBe("/todos")
    expect([...RESERVED]).toEqual(expect.arrayContaining(["/", "/settings", "/notes", "/todos"]))
  })
})

describe("a contributed path", () => {
  it("resolves to the contribution that claims it", () => {
    const id = contribute("page", { path: "/inbox-demo" }, () => null)

    expect(contributedRouteFor("/inbox-demo", routesArea(), RESERVED)?.contribution.id).toBe(id)
  })

  it("renders at that path inside the router", () => {
    contribute("page", { path: "/inbox-demo" }, () => <p>the plugin page</p>)

    render(
      <MemoryRouter initialEntries={["/inbox-demo"]}>
        <Routes>
          <Route path="/settings" element={<p>the real settings page</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("the plugin page")).toBeTruthy()
  })

  it("is dropped when it collides with one of the app's own routes", () => {
    contribute("squatter", { path: "/settings" }, () => <p>the plugin page</p>)

    expect(contributedRouteFor("/settings", routesArea(), RESERVED)).toBeNull()
    expect(warn.mock.calls[0]?.[0]).toContain("/settings")
  })

  it("does not shadow that route when the router matches it", () => {
    contribute("squatter", { path: "/settings" }, () => <p>the plugin page</p>)

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<p>the real settings page</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("the real settings page")).toBeTruthy()
    expect(screen.queryByText("the plugin page")).toBeNull()
  })

  it("is dropped when it has nothing to render", () => {
    contribute("renderless", { path: "/renderless" })
    contribute("pathless", {}, () => null)

    expect(contributedRouteFor("/renderless", routesArea(), RESERVED)).toBeNull()
  })

  it("is dropped when it is nested under one of the app's own routes", () => {
    contribute("nested-squatter", { path: "/settings/plugins" }, () => null)
    contribute("param-squatter", { path: "/todos/:todoId" }, () => null)

    expect(contributedRouteFor("/settings/plugins", routesArea(), RESERVED)).toBeNull()
    expect(contributedRouteFor("/todos/7", routesArea(), RESERVED)).toBeNull()
    expect(warnings().join("\n")).toContain("/settings/plugins")
  })

  it("does not shadow a nested app route when the router matches it", () => {
    contribute("nested-squatter", { path: "/settings/plugins" }, () => <p>the plugin page</p>)

    render(
      <MemoryRouter initialEntries={["/settings/plugins"]}>
        <Routes>
          <Route path="/settings/plugins" element={<p>the real plugin store</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("the real plugin store")).toBeTruthy()
    expect(screen.queryByText("the plugin page")).toBeNull()
  })

  it("sends a URL nobody claims back to chat rather than to a router error", async () => {
    // One pass, so the host knows the plugins have been looked for. There is no
    // gateway here, so it finds nothing and settles anyway, which is the point.
    await scanDiskPlugins()

    render(
      <MemoryRouter initialEntries={["/nothing-here"]}>
        <Routes>
          <Route path="/" element={<p>chat</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("chat")).toBeTruthy()
  })

  it("explains each rejected contribution once, not on every navigation", () => {
    contribute("repeat-squatter", { path: "/settings" }, () => null)

    contributedRouteFor("/settings", routesArea(), RESERVED)
    contributedRouteFor("/settings", routesArea(), RESERVED)
    contributedRouteFor("/elsewhere", routesArea(), RESERVED)

    expect(warn).toHaveBeenCalledTimes(1)
  })
})

/** A plugin's detail page, reading the segment it was reached at through the
 *  SDK. It never looks at `window.location`: the param is handed to it. */
function DetailPage() {
  return <p>item {useRouteParams().id}</p>
}

describe("a plugin with nested pages", () => {
  /** The param page is registered FIRST, so a static page winning at
   *  `/x/settings` is precedence rather than registration order. */
  function contributeFeature() {
    return {
      detail: contribute("feature-detail", { path: "/x/:id" }, () => <DetailPage />),
      index: contribute("feature-index", { path: "/x" }, () => <p>the index page</p>),
      settings: contribute("feature-settings", { path: "/x/settings" }, () => <p>the settings page</p>),
    }
  }

  it("resolves its index, its static child, and its param child", () => {
    const ids = contributeFeature()

    expect(contributedRouteFor("/x", routesArea(), RESERVED)?.contribution.id).toBe(ids.index)
    expect(contributedRouteFor("/x/settings", routesArea(), RESERVED)?.contribution.id).toBe(ids.settings)
    expect(contributedRouteFor("/x/42", routesArea(), RESERVED)).toMatchObject({
      contribution: { id: ids.detail },
      params: { id: "42" },
    })
  })

  it("matches nothing at a depth none of its pages claims", () => {
    contributeFeature()

    expect(contributedRouteFor("/x/42/edit", routesArea(), RESERVED)).toBeNull()
  })

  it("hands the captured segment to the page through the SDK", () => {
    contributeFeature()

    render(
      <MemoryRouter initialEntries={["/x/42"]}>
        <Routes>
          <Route path="/settings" element={<p>the real settings page</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("item 42")).toBeTruthy()
  })
})

describe("a malformed contributed path", () => {
  /* Every one of these is a path a plugin author could plausibly write, and
   * each is dropped for a reason the console says out loud. The `url` column is
   * the URL that path would have claimed had it been accepted: asserting the
   * rejection alone would pass for a matcher that merely fails to parse it. */
  const malformed = [
    { path: "inbox", reason: "absolute", url: "inbox" },
    { path: "/a//b", reason: "empty segment", url: "/a//b" },
    { path: "/a/", reason: "empty segment", url: "/a/" },
    { path: "/a/*", reason: "wildcard", url: "/a/*" },
    { path: "/:id/b", reason: "static segment", url: "/anything/b" },
    { path: "/a/:id/:id", reason: "twice", url: "/a/1/2" },
  ]

  it("is rejected with the reason, and never matches", () => {
    for (const { path } of malformed) contribute("malformed", { path }, () => null)

    for (const { url } of malformed) {
      expect(contributedRouteFor(url, routesArea(), RESERVED)).toBeNull()
    }

    const logged = warnings()
    for (const { path, reason } of malformed) {
      expect(logged.find((line) => line.includes(`"${path}"`))).toContain(reason)
    }
  })
})
