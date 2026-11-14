# @hundredfold/shell

The Tauri 2 shell for Hundredfold desktop and mobile targets. It bundles the production
web dashboard; it never navigates the main webview to a gateway URL.

## Security boundary

On Apple platforms, gateway credentials live in Keychain, scoped to the exact
canonical origin including its port. The keyring build enables the Apple backend
only, so Android has no OS-backed store at all and must never be represented as
secure storage support. The bundled dashboard can call four gateway commands
only: `pair`, `request`, `stream`, and `forget`. Those commands accept
root-relative gateway paths, reject credential-bearing headers and redirects,
and return no cookie or token to JavaScript.

Plain HTTP gateways are accepted only on loopback — a literal loopback address
or the name `localhost`. LAN, tailnet, and remote gateways require HTTPS. Each
of those four commands also verifies that it came from the local `main` window,
so any remote document fails closed; the desktop-only `report` command confines
itself to the probe window the same way. Tauri capabilities contain no `remote`
grants.

The strict CSP permits no remote origin: script and connect sources are the
bundled assets and Tauri IPC, alongside `data:`/`blob:` media and inline styles.
Gateway REST and WebSocket traffic runs in Rust, so gateway origins do not appear
in `connect-src`. External HTTP(S) links open in the system browser.

## Build

Prerequisites are pnpm, Rust, and Tauri CLI 2. Every command below stages the
production web output first, so run `pnpm --filter @hundredfold/web build` once before
`test` in a fresh clone.

```sh
pnpm --filter @hundredfold/shell test
pnpm --filter @hundredfold/shell desktop:build
pnpm --filter @hundredfold/shell ios:init
pnpm --filter @hundredfold/shell android:init
```

`desktop:build` first builds `@hundredfold/web`, atomically stages that output with the
refresh probe, then creates the native bundle. The macOS unsigned app is written
under `src-tauri/target/release/bundle/macos/`.

Signing, notarization, store distribution, and device deployment are release
concerns and are not implied by a successful local unsigned build.

The generated Apple and Android projects are committed under `src-tauri/gen/`.
Initialization does not prove device execution: Apple device builds still need
a development team, while Android requires a supported JDK/SDK/NDK toolchain
and a real credential-store backend before release.

## Retained desktop behavior

The native menu, icon, restored window geometry, `jinn://` deep links, and the
opt-in refresh-rate probe from the desktop spike remain. `jinn://org` and other
custom-scheme routes resolve inside bundled assets. Set `HUNDREDFOLD_SHELL_PROBE=1`
when launching the shell to open the local probe window.
