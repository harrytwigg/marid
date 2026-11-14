import { describe, expect, it } from "vitest"
import { hashKeyNames, isRenamed, pluginSdkSpecifiers, readResponseHeader, requestHeaderName, responseHeaderNames } from "../codename"
import { OLD } from "@hundredfold/legacy-names";

describe("browser-side codename names", () => {
  it("knows whether a rename is in effect", () => {
    expect(isRenamed(OLD.codename)).toBe(false)
    expect(isRenamed("acme")).toBe(true)
  })

  it("sends the current header and reads either", () => {
    expect(requestHeaderName("config-revision", "acme")).toBe("X-Acme-Config-Revision")
    expect(responseHeaderNames("config-revision", "acme")).toEqual(["X-Acme-Config-Revision", `X-${OLD.title}-Config-Revision`])
    expect(responseHeaderNames("config-revision", OLD.codename)).toEqual([`X-${OLD.title}-Config-Revision`])
  })

  it("reads a response header from a gateway of either build", () => {
    const from = (name: string, value: string) => new Headers({ [name]: value })
    expect(readResponseHeader(from(`X-${OLD.title}-Config-Revision`, "old"), "config-revision", "acme")).toBe("old")
    expect(readResponseHeader(from("X-Acme-Config-Revision", "new"), "config-revision", "acme")).toBe("new")
    expect(readResponseHeader(new Headers({ [`X-${OLD.title}-Config-Revision`]: "old", "X-Acme-Config-Revision": "new" }), "config-revision", "acme")).toBe("new")
    expect(readResponseHeader(new Headers(), "config-revision", "acme")).toBeNull()
  })

  it("keeps an empty revision rather than skipping to the legacy header", () => {
    expect(readResponseHeader(new Headers({ "X-Acme-Config-Revision": "", [`X-${OLD.title}-Config-Revision`]: "old" }), "config-revision", "acme")).toBe("")
  })

  it("reads a launch URL's fragment keys under either spelling", () => {
    expect(hashKeyNames("bootstrap", "acme")).toEqual(["acme-bootstrap", `${OLD.codename}-bootstrap`])
    expect(hashKeyNames("pair", OLD.codename)).toEqual([`${OLD.codename}-pair`])
  })

  it("accepts a plugin's import of the SDK by either package name", () => {
    expect(pluginSdkSpecifiers("acme")).toEqual(["@acme/plugin-sdk", `@${OLD.codename}/plugin-sdk`])
    expect(pluginSdkSpecifiers(OLD.codename)).toEqual([`@${OLD.codename}/plugin-sdk`])
    expect(pluginSdkSpecifiers()).toEqual(["@hundredfold/plugin-sdk", `@${OLD.codename}/plugin-sdk`])
  })
})
