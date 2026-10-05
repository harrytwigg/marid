import { describe, expect, it } from "vitest"
import { buildFeed, stripCommentMarkers } from "../task-page/activity-feed"
import { whisperOf } from "../task-page/whisper"
import { comment, event, run } from "./fixtures/task-wire"

/* Todos v2 slice 6 — the activity feed's pure model (design-doc §7.2.11): which
 * blocks a run of events and comments folds into, the whisper line each event
 * reads as, and the pipeline-marker strip. The rendered sections that sit on top
 * of it live in task-sections.test.tsx. */

describe("the merged feed model", () => {
  it("folds runs of ≥3 machine events, keeps short runs as whispers, and never collapses comments", () => {
    const blocks = buildFeed(
      [
        event("e1", "created", "2026-07-20T08:00:00.000Z"),
        event("e2", "metadata_edited", "2026-07-20T09:00:00.000Z"),
        event("e3", "label_changed", "2026-07-20T10:00:00.000Z"),
        event("e4", "status_change", "2026-07-21T09:00:00.000Z", { fromStatus: "backlog", toStatus: "executing" }),
        event("e5", "comment_added", "2026-07-21T10:00:00.000Z"), // hidden — the comment is the voice
      ],
      [comment("wic_1", "Form states are in", "2026-07-20T09:30:00.000Z")],
      [],
    )
    // e1+e2 (run of 2, split by the comment) → whispers; comment; e3+e4 run of 2 → whispers.
    expect(blocks.map((b) => b.kind)).toEqual(["event", "event", "comment", "event", "event"])

    const folded = buildFeed(
      [
        event("e1", "created", "2026-07-20T08:00:00.000Z"),
        event("e2", "metadata_edited", "2026-07-20T09:00:00.000Z"),
        event("e3", "label_changed", "2026-07-20T10:00:00.000Z"),
        event("e4", "relation_added", "2026-07-20T11:00:00.000Z"),
        event("e5", "note", "2026-07-20T12:00:00.000Z"),
      ],
      [],
      [],
    )
    // The birth whisper never folds; the remaining run of 3 does.
    expect(folded.map((b) => b.kind)).toEqual(["event", "fold"])
  })

  it("brackets a mid-run comment between the attempt's start and end", () => {
    const blocks = buildFeed(
      [],
      [comment("wic_1", "Halfway", "2026-07-22T08:20:00.000Z")],
      [run("wir_1", { startedAt: "2026-07-22T08:00:00.000Z", endedAt: "2026-07-22T08:40:00.000Z" })],
    )
    expect(blocks.map((b) => b.kind)).toEqual(["run-start", "comment", "run-end"])
  })

  it("gives an open attempt a start and no end, and never folds a run boundary away", () => {
    const open = buildFeed([], [], [run("wir_open", { endedAt: null, outcome: null })])
    expect(open.map((b) => b.kind)).toEqual(["run-start"])

    // Three quiet events would fold on their own; the attempt that started
    // among them splits the stretch instead of being swallowed by it.
    const amongQuiet = buildFeed(
      [
        event("e1", "metadata_edited", "2026-07-22T07:00:00.000Z"),
        event("e2", "label_changed", "2026-07-22T07:10:00.000Z"),
        event("e3", "relation_added", "2026-07-22T09:00:00.000Z"),
        event("e4", "note", "2026-07-22T09:10:00.000Z"),
      ],
      [],
      [run("wir_1")],
    )
    expect(amongQuiet.map((b) => b.kind)).toEqual(["event", "event", "run-start", "run-end", "event", "event"])
  })

  it("sorts a thread by its latest reply, so a reply made mid-attempt lands inside it", () => {
    const blocks = buildFeed(
      [],
      [
        comment("wic_root", "Starting", "2026-07-22T09:50:00.000Z"),
        comment("wic_reply", "Halfway", "2026-07-22T10:20:00.000Z", { parentCommentId: "wic_root" }),
      ],
      [run("wir_1", { startedAt: "2026-07-22T10:00:00.000Z", endedAt: "2026-07-22T10:40:00.000Z" })],
    )
    // Replies stay grouped under their root, so the block carries several
    // timestamps and only one position. The newest is the one that keeps the
    // reply on the right side of the attempt it answers.
    expect(blocks.map((b) => b.kind)).toEqual(["run-start", "comment", "run-end"])
  })

  it("whispers read as actor + verb (bounce carries its round)", () => {
    expect(whisperOf(event("e", "status_change", "t", { toStatus: "in_review" })).text).toBe("moved it to In review")
    // History written before the retired statuses were migrated still names them.
    expect(whisperOf(event("e", "status_change", "t", { toStatus: "escalated" as never })).text).toBe("moved it to Escalated")
    expect(whisperOf(event("e", "note", "t", { detail: { assignee: "@operator" } })).text).toBe("assigned it to the operator")
    expect(
      whisperOf(event("e", "status_change", "t", { fromStatus: "in_review", toStatus: "executing", detail: { bounce: true, rounds: 2 } })).text,
    ).toBe("sent it back · round 2")
    expect(whisperOf(event("e", "escalated", "t", { detail: { reason: "max-rounds-exhausted" } })).text).toContain("rounds exhausted")
    // Approval rows written before the approval flow was removed stay in history
    // as plain lines; they carry no decision and render without one.
    expect(whisperOf(event("e", "approval_requested", "t", { detail: { request: "ship it?" } })).text).toBe("approval requested")
    expect(whisperOf(event("e", "approval_decided", "t", { detail: { decision: "approve" } })).text).toBe("approval decided")
    // A suppressed dispatch has to name the guard, or the operator re-arms blind.
    expect(whisperOf(event("e", "respawn_guard_held", "t", { detail: { guard: "active_pr" } })).text).toContain("active_pr")
    // A clock-driven resume has to read as the wait ending, not as the raw kind
    // falling through the table as "availability resumed".
    expect(whisperOf(event("e", "availability_resumed", "t", { detail: { engine: "claude", source: "stated" } })).text)
      .toBe("claude window reopened, stated")
  })

  it("reads a project move as a project move, in either direction", () => {
    expect(whisperOf(event("e", "project_changed", "t", { detail: { from: null, to: "prj_0a1b2c3d4e5f" } })).text).toBe("moved it to a project")
    expect(whisperOf(event("e", "project_changed", "t", { detail: { from: "prj_0a1b2c3d4e5f", to: null } })).text).toBe("took it out of its project")
  })

  it("leaves inline HTML comments and fenced examples intact", () => {
    expect(stripCommentMarkers(
      "Before\n<!-- pipeline-status -->\nInline <!-- keep --> text\n<!-- keep --> visible <!-- too -->\n```\n<!-- code -->\n```\n<!-- /pipeline-status -->\nAfter",
    )).toBe("Before\nInline <!-- keep --> text\n<!-- keep --> visible <!-- too -->\n```\n<!-- code -->\n```\nAfter")
  })

})
