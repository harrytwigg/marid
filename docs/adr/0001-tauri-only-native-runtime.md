# ADR 0001: Tauri is the only native runtime

- Status: accepted
- Date: 2026-08-18
- Decision owners: platform team

## Context

Hundredfold previously carried separate desktop and iOS shell packages. That split
duplicated runtime detection, build systems, application metadata, and security
assumptions. The iOS shell also loaded a gateway page remotely, which made the
gateway origin both UI host and data authority.

## Decision

`packages/shell` is the only native application package. It uses Tauri 2 for
macOS, iOS, and Android. The shared Rust application entry point is
`src-tauri/src/lib.rs`; desktop calls it from `main.rs`, while mobile frameworks
load its `mobile_entry_point` library target. Generated Apple and Android
projects are committed under `src-tauri/gen/`.

The former native runtime, adapter, dependencies, and package are deleted. New
native platform work extends this shell instead of adding another container.

## Consequences

- One bundled frontend and one native security boundary serve every target.
- Desktop-only menu, window-state, display, and probe code is compiled only on
  desktop.
- iOS and Android projects can be initialized and reviewed without claiming
  device execution, signing, or store readiness.
- Android secure credential persistence remains a release blocker. The keyring
  build enables the Apple backend only, so on Android the crate falls back to an
  in-process store: pairing reports success and the credential dies with the
  process. A real platform backend has to land before Android ships.
