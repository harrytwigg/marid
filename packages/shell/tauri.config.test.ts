import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const here = import.meta.dirname
const packageJson = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as {
  name: string
  scripts: Record<string, string>
}
const tauriConfig = JSON.parse(readFileSync(resolve(here, "src-tauri/tauri.conf.json"), "utf8")) as {
  identifier: string
  build: { frontendDist: string }
  app: { windows: Array<{ label: string; url?: string }>; security: { csp: string | null } }
  plugins: { "deep-link": { desktop: { schemes: string[] }; mobile: Array<{ scheme: string[] }> } }
}
const mainCapability = JSON.parse(
  readFileSync(resolve(here, "src-tauri/capabilities/main.json"), "utf8"),
) as { windows: string[]; permissions: string[]; remote?: unknown }
const probeCapability = JSON.parse(
  readFileSync(resolve(here, "src-tauri/capabilities/probe.json"), "utf8"),
) as { windows: string[]; permissions: string[]; remote?: unknown }

describe("bundled Tauri shell", () => {
  it("is the one cross-platform shell package and builds the web bundle first", () => {
    expect(packageJson.name).toBe("@hundredfold/shell")
    expect(existsSync(resolve(here, "../shell-ios"))).toBe(false)
    expect(packageJson.scripts["desktop:build"]).toMatch(/^pnpm --filter @hundredfold\/web build .*cargo tauri build/)
    expect(packageJson.scripts["desktop:build"]).not.toContain("HUNDREDFOLD_SHELL_SERVER_URL")
    // The native leg runs through a runner rather than inline `cargo test`: the crate
    // targets Apple platforms, so it must run on macOS and be skipped, loudly, elsewhere.
    expect(packageJson.scripts.test).toContain("scripts/test-native.mjs")
    const nativeRunner = readFileSync(resolve(here, "scripts/test-native.mjs"), "utf8")
    expect(nativeRunner).toContain("cargo")
    expect(nativeRunner).toContain("darwin")
  })

  it("loads local web assets in one main window under a strict CSP", () => {
    expect(tauriConfig.build.frontendDist).toBe("../dist/web")
    expect(tauriConfig.app.windows).toEqual([])
    const library = readFileSync(resolve(here, "src-tauri/src/lib.rs"), "utf8")
    expect(library).toContain('WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))')
    expect(library).toContain(".on_navigation(")
    expect(library).toContain(".on_new_window(")
    expect(tauriConfig.app.security.csp).toEqual(expect.any(String))
    expect(tauriConfig.app.security.csp).toContain("default-src 'self'")
    expect(tauriConfig.app.security.csp).toContain("connect-src ipc: http://ipc.localhost")
    expect(tauriConfig.app.security.csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/)
  })

  it("keeps initialized iOS and Android projects behind one mobile entry point", () => {
    const manifest = readFileSync(resolve(here, "src-tauri/Cargo.toml"), "utf8")
    const library = readFileSync(resolve(here, "src-tauri/src/lib.rs"), "utf8")
    expect(manifest).toContain('crate-type = ["staticlib", "cdylib", "rlib"]')
    expect(library).toContain("#[cfg_attr(mobile, tauri::mobile_entry_point)]")
    expect(existsSync(resolve(here, "src-tauri/gen/apple/project.yml"))).toBe(true)
    expect(existsSync(resolve(here, "src-tauri/gen/android/settings.gradle"))).toBe(true)
    expect(tauriConfig.identifier).toBe("run.jinn.shell")
    expect(tauriConfig.plugins["deep-link"].desktop.schemes).toEqual(["hundredfold", "jinn"]) // rename:keep: the old scheme stays registered
    expect(tauriConfig.plugins["deep-link"].mobile[0]?.scheme).toEqual(["hundredfold", "jinn"]) // rename:keep
  })

  it("keeps main and probe capabilities local, separate, and narrow", () => {
    expect(mainCapability.windows).toEqual(["main"])
    expect(mainCapability.remote).toBeUndefined()
    expect(mainCapability.permissions).toEqual(["core:default"])
    expect(probeCapability.windows).toEqual(["probe"])
    expect(probeCapability.remote).toBeUndefined()
    expect(probeCapability.permissions).toEqual(["core:default"])
  })

  it("contains no generated remote-window configuration path", () => {
    const sources = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/src/lib.rs"]
      .map((path) => readFileSync(resolve(here, path), "utf8"))
      .join("\n")
    expect(sources).not.toContain("HUNDREDFOLD_SHELL_SERVER_URL")
    expect(sources).not.toContain("tauri.conf.gen.json")
  })
})
