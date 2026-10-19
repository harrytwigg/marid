import { describe, expect, it, vi } from "vitest"
import {
  INTENT_FAMILIES,
  createPlatform,
  type PlatformAdapter,
  type Runtime,
} from "../contracts"
import { createFallbackAdapter } from "../adapters/fallback"
import { createLazyTauriAdapter } from "../adapters/lazy-tauri"
import { createTestAdapter } from "../adapters/test"

// main.tsx mounts on import. The startup test wants its module body and
// mount() to run for real, without dragging a full React render in.
const mount = vi.hoisted(() => ({ rendered: false }))
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => { mount.rendered = true }, unmount: () => {} }),
}))

const runtime: Runtime = {
  container: "browser",
  os: "unknown",
  engine: "unknown",
  secureContext: true,
  appVersion: "test",
  userAgent: "platform-contract-test",
}

describe("platform adapter contract", () => {
  it("names every intent family", () => {
    expect(INTENT_FAMILIES).toEqual([
      "feedback",
      "notifications",
      "badges",
      "sharing",
      "lifecycle",
      "navigation",
      "viewport",
      "clipboard",
      "files",
      "install",
      "window",
      "device",
    ])
  })

  it("returns unsupported without throwing for every fallback family", async () => {
    const platform = createPlatform({ runtime, adapters: [createFallbackAdapter()] })
    const intents = [
      { kind: "feedback.selection" },
      { kind: "notifications.present", title: "Ready" },
      { kind: "badges.set", count: 3 },
      { kind: "sharing.share", text: "hello" },
      { kind: "navigation.open-external", url: "https://example.com" },
      { kind: "viewport.set-orientation", orientation: "portrait" },
      { kind: "clipboard.copy", text: "hello" },
      { kind: "files.pick", accepts: [] },
      { kind: "install.request" },
      { kind: "window.set-state", state: "maximized" },
      { kind: "device.biometrics", reason: "Unlock" },
    ] as const

    for (const intent of intents) {
      await expect(platform.perform(intent)).resolves.toMatchObject({ status: "unsupported" })
    }
    await expect(platform.capability("lifecycle.resume")).resolves.toMatchObject({ supported: false })
  })

  it("keeps permission-required, denied, cancelled, and failed distinct", async () => {
    const test = createTestAdapter({
      results: {
        "notifications.request-permission": { status: "permission-required", permission: "prompt" },
        "device.biometrics": { status: "denied", permission: "denied" },
        "sharing.share": { status: "cancelled" },
        "clipboard.copy": { status: "failed", error: { code: "clipboard-write", message: "busy" } },
      },
    })
    const platform = createPlatform({ runtime, adapters: [test] })

    await expect(platform.perform({ kind: "notifications.request-permission", userGesture: false })).resolves.toEqual({
      status: "permission-required",
      permission: "prompt",
    })
    await expect(platform.perform({ kind: "device.biometrics", reason: "Unlock" })).resolves.toEqual({
      status: "denied",
      permission: "denied",
    })
    await expect(platform.perform({ kind: "sharing.share", text: "hello" })).resolves.toEqual({ status: "cancelled" })
    await expect(platform.perform({ kind: "clipboard.copy", text: "hello" })).resolves.toMatchObject({ status: "failed" })
  })

  it("normalizes an adapter exception to failed instead of rejecting", async () => {
    const exploding: PlatformAdapter = {
      name: "exploding",
      capability: async () => ({ supported: true, permission: "not-applicable", configured: true, available: true }),
      perform: async () => { throw new Error("provider exploded") },
      observe: () => null,
    }
    const platform = createPlatform({ runtime, adapters: [exploding] })

    await expect(platform.perform({ kind: "device.biometrics", reason: "Unlock" })).resolves.toEqual({
      status: "failed",
      error: { code: "adapter-error", message: "provider exploded" },
    })
  })

  it("loads the Tauri adapter lazily", async () => {
    const load = vi.fn(async () => createFallbackAdapter("tauri"))
    const platform = createPlatform({ runtime: { ...runtime, container: "tauri" }, adapters: [createLazyTauriAdapter(load)] })

    expect(load).not.toHaveBeenCalled()
    await expect(platform.perform({ kind: "device.biometrics", reason: "Unlock" })).resolves.toMatchObject({
      status: "unsupported",
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("does not load the Tauri adapter outside the Tauri runtime", async () => {
    const load = vi.fn(async () => createFallbackAdapter("tauri"))
    const platform = createPlatform({ runtime, adapters: [createLazyTauriAdapter(load)] })

    await expect(platform.perform({ kind: "device.biometrics", reason: "Unlock" })).resolves.toMatchObject({
      status: "unsupported",
    })
    expect(load).not.toHaveBeenCalled()
  })

  it("issues no permission prompt while the app starts up", async () => {
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission)
    const present = vi.fn()
    const share = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("Notification", Object.assign(present, { permission: "default", requestPermission }))
    vi.stubGlobal("navigator", { userAgent: "startup-test", share, vibrate: vi.fn(), clipboard: { writeText } })
    document.body.innerHTML = '<div id="root"></div>'
    vi.resetModules()

    // Real startup: main.tsx runs its module body and mounts. A prompt raised
    // anywhere on that path — not only inside the platform — fails this.
    await import("@/main")
    await vi.waitFor(() => expect(mount.rendered).toBe(true))

    const { getPlatform } = await import("../platform")
    expect(getPlatform().runtime.container).toBe("browser")
    expect(requestPermission).not.toHaveBeenCalled()
    expect(present).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("emits deterministic test events and unsubscribes", () => {
    const test = createTestAdapter()
    const platform = createPlatform({ runtime, adapters: [test] })
    const listener = vi.fn()
    const unsubscribe = platform.observe("lifecycle.online", listener)

    test.emit({ kind: "lifecycle.online", online: false })
    unsubscribe()
    test.emit({ kind: "lifecycle.online", online: true })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ kind: "lifecycle.online", online: false })
  })
})
