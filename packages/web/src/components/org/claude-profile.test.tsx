import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ClaudeProfileBadge, ClaudeProfileRow, claudeProfileLabel } from "@/components/org/claude-profile"

const profile = { path: "/Users/operator/.claude-friend", key: "7c2aa2a9" }

describe("Claude profile badge and row", () => {
  it("labels a profile by its directory name", () => {
    expect(claudeProfileLabel(profile)).toBe(".claude-friend")
    expect(claudeProfileLabel({ path: "/x/.claude-work/", key: "k" })).toBe(".claude-work")
  })

  it("shows the badge for a named profile, with the full path on hover", () => {
    render(<ClaudeProfileBadge profile={profile} />)
    const badge = screen.getByTestId("claude-profile-badge")
    expect(badge.textContent).toBe(".claude-friend")
    expect(badge.getAttribute("title")).toBe("Runs on the Claude profile /Users/operator/.claude-friend")
  })

  it("shows nothing for the default profile", () => {
    const { container } = render(<><ClaudeProfileBadge profile={null} /><ClaudeProfileRow profile={undefined} /></>)
    expect(container.innerHTML).toBe("")
  })

  it("shows the profile row read-only: the path, the key and where it is set", () => {
    render(<ClaudeProfileRow profile={profile} />)
    const row = screen.getByTestId("claude-profile-row")
    expect(row.textContent).toContain("/Users/operator/.claude-friend")
    expect(row.textContent).toContain("7c2aa2a9")
    expect(row.textContent).toContain("claudeConfigDir")
    expect(row.querySelector("input, button, textarea")).toBeNull()
  })
})
