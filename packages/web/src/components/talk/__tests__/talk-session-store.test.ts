import { beforeEach, describe, expect, it } from "vitest"
import { browserInstanceId } from "../context/browser-instance"
import {
  clearResumableTalkSession,
  readResumableTalkSession,
  rememberResumableTalkSession,
} from "../talk-session-store"

beforeEach(() => {
  sessionStorage.clear()
})

describe("the resumable Talk session", () => {
  it("survives a reload in storage scoped to this browser instance", () => {
    rememberResumableTalkSession("talk-12")

    expect(readResumableTalkSession()).toBe("talk-12")
    expect(sessionStorage.getItem(`hundredfold-talk-resumable:${browserInstanceId()}`)).toBe("talk-12")
  })

  it("only clears the candidate it was asked to forget", () => {
    rememberResumableTalkSession("talk-newer")

    clearResumableTalkSession("talk-older")
    expect(readResumableTalkSession()).toBe("talk-newer")

    clearResumableTalkSession("talk-newer")
    expect(readResumableTalkSession()).toBeNull()
  })
})
