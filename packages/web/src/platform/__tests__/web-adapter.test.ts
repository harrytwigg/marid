import { describe, expect, it, vi } from "vitest"
import { createPlatform, type Runtime } from "../contracts"
import { createWebAdapter, type WebPlatformEnvironment } from "../adapters/web"

const runtime: Runtime = {
  container: "browser",
  os: "unknown",
  engine: "unknown",
  secureContext: true,
  appVersion: "test",
  userAgent: "web-adapter-test",
}

function environment(overrides: Partial<WebPlatformEnvironment> = {}): WebPlatformEnvironment {
  return {
    secureContext: true,
    ...overrides,
  }
}

function webPlatform(overrides: Partial<WebPlatformEnvironment> = {}) {
  return createPlatform({ runtime, adapters: [createWebAdapter(environment(overrides))] })
}

describe("web platform adapter", () => {
  it("reports capability state live", async () => {
    const env = environment()
    const platform = createPlatform({ runtime, adapters: [createWebAdapter(env)] })

    await expect(platform.capability("sharing.share")).resolves.toMatchObject({ supported: false })
    env.share = vi.fn(async () => {})
    await expect(platform.capability("sharing.share")).resolves.toMatchObject({ supported: true })
  })

  it("reports live notification permission and availability", async () => {
    let permission: "prompt" | "denied" | "granted" = "prompt"
    const platform = webPlatform({
      notificationPermission: () => permission,
      requestNotificationPermission: async () => permission,
      presentNotification: vi.fn(),
    })

    await expect(platform.capability("notifications.present")).resolves.toMatchObject({
      supported: true,
      permission: "prompt",
      available: false,
    })
    permission = "denied"
    await expect(platform.capability("notifications.present")).resolves.toMatchObject({
      supported: true,
      permission: "denied",
      available: false,
    })
    await expect(platform.perform({ kind: "notifications.present", title: "Ready" })).resolves.toEqual({
      status: "denied",
      permission: "denied",
    })
  })

  it("fails closed outside a secure context", async () => {
    const share = vi.fn(async () => {})
    const platform = webPlatform({ secureContext: false, share })

    await expect(platform.perform({ kind: "sharing.share", text: "hello" }))
      .resolves.toMatchObject({ status: "unsupported" })
    expect(share).not.toHaveBeenCalled()
  })

  it("copies with the legacy path where the async clipboard API is withheld", async () => {
    const writeClipboard = vi.fn(async () => {})
    const copyLegacy = vi.fn(() => true)
    const platform = webPlatform({ secureContext: false, writeClipboard, copyLegacy })

    await expect(platform.capability("clipboard.copy")).resolves.toMatchObject({ supported: true, available: true })
    await expect(platform.perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toEqual({ status: "performed", value: { method: "legacy-copy" } })
    expect(copyLegacy).toHaveBeenCalledWith("hello")
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it("reports clipboard copy unsupported when no copy path exists", async () => {
    const platform = webPlatform({ secureContext: false })
    await expect(platform.perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toMatchObject({ status: "unsupported" })
    await expect(platform.capability("clipboard.copy")).resolves.toMatchObject({ supported: false })
  })

  it("reports a failed legacy copy instead of a silent success", async () => {
    await expect(webPlatform({ secureContext: false, copyLegacy: () => false }).perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toMatchObject({ status: "failed", error: { code: "clipboard-write" } })
    await expect(webPlatform({ secureContext: false, copyLegacy: () => { throw new Error("boom") } }).perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toMatchObject({ status: "failed" })
  })

  it("falls back to the legacy copy when the async write is rejected", async () => {
    const writeClipboard = vi.fn(async () => { throw new DOMException("blocked", "NotAllowedError") })
    const copyLegacy = vi.fn(() => true)
    await expect(webPlatform({ writeClipboard, copyLegacy }).perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toEqual({ status: "performed", value: { method: "legacy-copy" } })
    expect(writeClipboard).toHaveBeenCalledWith("hello")
    // With no fallback to try, the browser's own verdict stands.
    await expect(webPlatform({ writeClipboard }).perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toEqual({ status: "denied", permission: "denied" })
    // An aborted write is the user's call; it is not retried behind their back.
    const aborted = vi.fn(async () => { throw new DOMException("cancelled", "AbortError") })
    await expect(webPlatform({ writeClipboard: aborted, copyLegacy }).perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toEqual({ status: "cancelled" })
    expect(copyLegacy).toHaveBeenCalledTimes(1)
  })

  it("classifies sharing success, cancellation, denial, failure, and missing support", async () => {
    await expect(webPlatform({ share: vi.fn(async () => {}) }).perform({ kind: "sharing.share", text: "hello" }))
      .resolves.toEqual({ status: "performed", value: { method: "share" } })
    await expect(webPlatform({ share: vi.fn(async () => { throw new DOMException("cancelled", "AbortError") }) })
      .perform({ kind: "sharing.share", text: "hello" })).resolves.toEqual({ status: "cancelled" })
    await expect(webPlatform({ share: vi.fn(async () => { throw new DOMException("blocked", "NotAllowedError") }) })
      .perform({ kind: "sharing.share", text: "hello" })).resolves.toEqual({ status: "denied", permission: "denied" })
    await expect(webPlatform({ share: vi.fn(async () => { throw new Error("provider down") }) })
      .perform({ kind: "sharing.share", text: "hello" })).resolves.toMatchObject({ status: "failed" })
    await expect(webPlatform().perform({ kind: "sharing.share", text: "hello" }))
      .resolves.toMatchObject({ status: "unsupported" })
  })

  it("invokes sharing synchronously to preserve transient user activation", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const share = vi.fn(() => pending)
    const result = webPlatform({ share }).perform({ kind: "sharing.share", text: "hello" })

    expect(share).toHaveBeenCalledOnce()
    release()
    await expect(result).resolves.toMatchObject({ status: "performed" })
  })

  it("classifies decorative feedback without ever throwing", async () => {
    const vibrate = vi.fn(() => true)
    await expect(webPlatform({ vibrate }).perform({ kind: "feedback.selection" }))
      .resolves.toEqual({ status: "performed" })
    expect(vibrate).toHaveBeenCalledWith(8)

    await expect(webPlatform({ vibrate: () => false }).perform({ kind: "feedback.selection" }))
      .resolves.toMatchObject({ status: "failed" })
    await expect(webPlatform().perform({ kind: "feedback.selection" }))
      .resolves.toMatchObject({ status: "unsupported" })
  })

  it("does not request notification permission during construction", async () => {
    const requestNotificationPermission = vi.fn(async () => "granted" as const)
    const platform = webPlatform({ notificationPermission: () => "prompt", requestNotificationPermission })

    expect(requestNotificationPermission).not.toHaveBeenCalled()
    await expect(platform.perform({ kind: "notifications.request-permission", userGesture: false }))
      .resolves.toEqual({ status: "permission-required", permission: "prompt" })
    expect(requestNotificationPermission).not.toHaveBeenCalled()

    await expect(platform.perform({ kind: "notifications.request-permission", userGesture: true }))
      .resolves.toEqual({ status: "performed", value: { permission: "granted" } })
    expect(requestNotificationPermission).toHaveBeenCalledTimes(1)
  })

  it("keeps clipboard copy behind the same result contract", async () => {
    const writeClipboard = vi.fn(async () => {})
    await expect(webPlatform({ writeClipboard }).perform({ kind: "clipboard.copy", text: "hello" }))
      .resolves.toEqual({ status: "performed", value: { method: "clipboard" } })
    expect(writeClipboard).toHaveBeenCalledWith("hello")
  })
})
