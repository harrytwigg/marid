# Platform foundation QA

- Date: 2026-08-23
- Branch: merged; name not recorded here
- Product SHA exercised: `f882cf21` — the whole journey was re-run at that head, after the `main` reconciliation, the `failedProfileId` fix, and the restored build-lane proofs
- Reconciled onto: `main` at `2402dabd` — the commit this branch is actually merged onto; `git rev-list --count HEAD..main` is 0 and `git diff --name-only main...HEAD` lists only `docs/qa/` paths. `main` had independently landed the same two fixes (`7628ebf2` for `failedProfileId`/retry, `bdb9b6c8` for the startup and credential proofs) plus a size-cap split of the profile module (`66a829b1`), so this branch dropped its own copies and carries only this QA evidence on top of `main`. The earlier reconciliation point was `aaa5f48e`; across the whole range `aaa5f48e..2402dabd` the only drift on a platform-foundation surface is `packages/shell` CI test infrastructure — `packages/shell/package.json`, `packages/shell/scripts/test-native.mjs`, and `packages/shell/tauri.config.test.ts`. The three commits after `76be9932` retire `POST /api/files/transfer`, the `remotes` config key, and the Discord cross-gateway proxy, and touch no platform-foundation surface at all. No product file this journey exercised changed in that range
- Product-code drift from the exercised head: the reconciled tree is **not** identical to `f882cf21`. `packages/shell/src-tauri/src/credentials.rs` and `packages/web/src/platform/__tests__/contracts.test.ts` are byte-identical, and the pairing screen's `unreachable` derivation is byte-identical (only its comment changed), but three behavioural deltas sit in `packages/web/src/lib/native-gateway-profiles.ts`, each visible in `git diff f882cf21..HEAD -- packages/web/src/lib/native-gateway-profiles.ts`:
  1. `verifyActive()`'s catch now also writes `failedProfileId: id`, so an unreachable active gateway names itself as the failure on record
  2. `remove()` now also writes `status: !failed && activeReachable ? "ready" : status`, so deleting the profile a failure named returns the screen to `ready` instead of leaving a stale `unreachable`
  3. `retry()` now also writes `failedProfileId: undefined`, so a successful re-check clears the failure it just disproved

  Alongside those three, `remove()`'s `error` clause was rewritten from `cleared ? undefined : error` to `failed ? error : undefined` — the same condition expressed around `failed`, and equivalent once delta 1 makes every `error` write carry a `failedProfileId`. The `failedProfileId` and `retry()` doc comments were reworded to match. The `GuardedSocket` class also moved from `guarded-gateway-socket.ts` to `native-gateway-socket.ts`, and `main` carries profile-manager tests `f882cf21` did not
- Why rows 10a/10b/10c still hold under those deltas: `retry()` still resolves its target from `activeId` and never from `failedProfileId`, the pairing screen still derives `unreachable` from `activeReachable` alone, and `remove()` still clears the failure only when it names the id it deleted — so every path the captures exercised is unchanged, and the three deltas only make `failedProfileId` mean one thing at every write
- Sandboxes: fresh disposable `qa-workspace-a` / `qa-workspace-b` homes on loopback ports 7814 and 7815. Each home's `config.yaml` `port:` was read and confirmed before its daemon was started; both were seeded at 7777 by `setup` and rewritten first. An ambient `JINN_PORT=7777` in the runner environment overrode the sandbox config on the first start attempt and the gateway's port-owner guard refused it — the daemons run with that variable scrubbed. Both sandboxes were registered only in a throwaway `JINN_INSTANCES_REGISTRY`, never the host registry
- Production home/port: not used

`Verified` means the listed evidence was exercised. `Unverified` is an explicit
gap, not an inferred pass. Temporary pairing codes, credentials, browser traces,
and sandbox data are not retained.

## Journey ledger

| # | Journey assertion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Boot A, pair, HttpOnly cookies, `/api/sessions` 200 | Verified | Paired a clean isolated Chrome profile against A with a one-time CLI code; the cookie jar reports `httpOnly: true` on both `jinn_auth_*` and `jinn_device_*`, `document.cookie` is empty, and `/api/sessions` returned 200 |
| 2 | Open `/todos` and a Todo in the same browser | Verified | Opened `/todos`, switched to the Everything board and clicked generic `QAA-1`, landing on `/todos/QAA-1` with the dashboard chrome unchanged |
| 3 | Browser workspace switch A→B isolates A authentication | Verified | The switcher menu listed both workspaces and choosing QA Beta navigated the browser to B's `switchUrl` `http://127.0.0.1:7815/`; B rendered its own Pair This Browser screen and returned 401 for `/api/sessions` while A still returned 200 |
| 4 | PWA hard-refresh `/todos` and `/settings`; API remains same-origin | Verified | After a reload both routes reported an active controlling service worker scoped to A's origin and a same-origin `/api/status` 200 |
| 5 | Chat, Todos, Settings, switcher screenshots at both sizes/themes | Verified | Twenty regenerated PNGs under `docs/qa/platform-foundation-evidence/`: sixteen browser captures plus four bundled-native gateway-screen captures; every file measures exactly 1440×900 or 390×844 and shows only generic sandbox data |
| 6 | Bundled Tauri loads local assets; menu/icon/geometry work | Verified | A fresh unsigned `Jinn.app` opened its embedded Connect Jinn screen before any profile existed, kept the Jinn/Edit/View/Window menu bar and `icon.icns`, and was driven between 1440×900 and 390×844 repeatedly; `tauri.conf.json` sets `frontendDist` and the window opens `WebviewUrl::App("index.html")` |
| 7 | Pair A and B independently | Verified | Pairing A then adding B through the app's Add gateway dialog stored two Keychain accounts that are exactly `sha256("http://127.0.0.1:7814")` and `sha256("http://127.0.0.1:7815")`; after pairing, B showed as Online while QA Alpha stayed Current |
| 8 | A→B changes HTTP, WS, cache, auth, identity; route remains `/todos` | Verified | Switching A→B in the bundled app left the Todos Home route in place and moved all traffic: B's access log grew while A's grew by zero bytes, and the switcher then named QA Beta the current workspace. Switching back reversed both. Generation isolation for cache and sockets is covered by the focused manager suite |
| 9 | Delayed A REST and WS after switch are discarded | Verified | Focused manager test delivers an A REST resolution and an A WebSocket frame after committing B: the REST promise rejects as `StaleGatewayGenerationError`, the frame callback never runs, and B stays active |
| 10 | B→A, remove B, restore A, honest unreachable state (10a/10b/10c) | Verified | B→A moved every request back to A and left B's log untouched. Removing QA Beta deleted only its exact-origin Keychain account and left A's intact. **10a** — with A stopped, Cmd+R rendered the app's own screen: "Cannot reach QA Alpha", both paired gateways with Retry/Use/Remove, the origin and pair-code fields, and "Gateway is unreachable" — never the browser Pair This Browser screen. **10b** — with A unreachable, a `Use` on QA Beta failed and the heading still read "Cannot reach QA Alpha"; with both gateways restarted, `Retry` on QA Alpha's row grew A's access log by 69 bytes and B's by zero, and the app recovered into A on its previous route. **10c** — removing QA Beta right after its selection failed cleared the stale failure, and the next `Retry` reached A and recovered into it with no `Unknown native gateway profile` throw |
| 11 | `jinn://org` and `jinn://settings` stay in-app; HTTPS opens outside | Verified | Both deep links were opened against the unsigned bundle and rendered the in-app Organization and Settings routes in the app window; the Rust navigation suite pins HTTPS to the external opener |
| 12 | Unsupported, denied, and failed remain distinct | Verified | Platform contract suite, which now also boots `@/main` for real to prove no permission prompt is raised on the startup path |
| 13 | Remote/LAN pages cannot invoke native; web bundle has no Tauri or Capacitor dependencies | Verified | Rust caller/origin suites, the product-boundary test, zero `@capacitor/*` lockfile entries, and a scan of all 367 emitted chunks in the gateway-served bundle finding no `__TAURI__`, `@tauri-apps/api` or `Capacitor`; only the shell bundle carries the lazily split `tauri-*.js` adapter |
| 14 | Full gates, unsigned macOS build, mobile initialization | Verified with named gaps | Full gate green; Apple/Android projects generated; details below |

## Mobile and packaging evidence

| Target | Evidence | Result |
| --- | --- | --- |
| macOS | unsigned bundled application build and launch | Verified: `cargo tauri build --bundles app` produced `Jinn.app` and the launched window rendered its own Connect Jinn gateway screen from the bundled local assets with the Jinn/Edit/View/Window menu bar intact. Developer ID signing, notarization, packaging beyond the ad-hoc `.app`, and distribution are unverified |
| iOS | `cargo check --target aarch64-apple-ios-sim` on the rustup `stable-aarch64-apple-darwin` toolchain | Verified Rust compilation (exit 0). Xcode app packaging, simulator launch, physical device behavior, signing team, and distribution signing are unverified |
| Android | `cargo check --target aarch64-linux-android` against NDK 27.3.13750724 | Verified Rust compilation (exit 0). Gradle APK/AAB packaging, emulator/device launch, keystore signing, and Play distribution are unverified |

## Gate record

Every gate is read from its own exit code, never from a piped tail. After the
final edit of each slice the full set was re-run with `TURBO_FORCE=true` so no
result came from the turbo cache.

| Slice | typecheck | lint | test | build | ratchet --check | footguns |
| --- | --- | --- | --- | --- | --- | --- |
| S19 reconcile with `main` | 0 | 0 | 0 | 0 | 0 | 0 |
| S20 one meaning for `failedProfileId` (dropped; landed on `main` as `7628ebf2`) | 0 | 0 | 0 | 0 | 0 | 0 |
| S21 restored build-lane proofs (dropped; landed on `main` as `bdb9b6c8`) | 0 | 0 | 0 | 0 | 0 | 0 |
| S22 gates and native targets | 0 | 0 | 0 | 0 | 0 | 0 |
| S23 journey and evidence | 0 | 0 | 0 | 0 | 0 | 0 |
| S24 reconcile onto `main` `aaa5f48e`, QA evidence only | 0 | 0 | 0 | 0 | 0 | 0 |
| S25 reconcile onto `main` `2402dabd`, drift named honestly | 0 | 1 | 0 | 0 | 0 | 0 |

`lint` exits 1 at S25, and the failure is `main`'s, not this branch's: `scripts/upgrade-lab/assertions.mjs:15` reports `Function 'assertStockBundleApplied' has a complexity of 14. Maximum allowed is 10`. That file arrived in `76be9932`, this branch's own base, and `git diff main HEAD` shows this branch changes nothing outside `docs/qa/`, so every input `lint` reads is byte-identical to `main`'s. Fixing it here would also break the branch's docs-only diff. It is reported, not fixed.

`cargo test --manifest-path packages/shell/src-tauri/Cargo.toml` reports 17
passing tests, one more than the previous round: the restored
`the_keyring_account_is_derived_from_the_exact_origin_and_port` case.

The S20 and S21 fixes were red-checked when they were written, and the same
assertions still guard the reconciled tree because `main` carries the same code.
Reverting
`retry()` to prefer `failedProfileId` reds the active-gateway retry test;
restoring the `remove()` behavior reds the post-removal retry test; restoring the
`failedProfileId === activeId` comparison in the screen reds the heading test.
Adding a permission prompt to `main.tsx` reds the startup contract, and
collapsing `account()` to one shared constant reds both credential tests. Every
mutation was reverted and the suites returned green.

## Visual evidence manifest

`chat`, `todos`, `settings`, and `switcher`, each at `desktop` (1440×900) and
`mobile` (390×844) with `light` and `dark` variants — sixteen browser captures
taken against sandbox A. Four `native-profile` captures record the unsigned
bundled app's own gateway screen with its last-active gateway unreachable, at the
same two sizes and both themes.

All twenty files were regenerated this round and each measures exactly 1440×900
or 390×844. They contain only generic sandbox identities (`QA Alpha`, `QA Beta`,
`QAA-1`, `Assistant`, `Todo Dispatcher`) and no filesystem paths.

## Teardown

Both sandbox gateways were stopped, their disposable homes deleted, ports 7814
and 7815 confirmed free, the two QA Keychain accounts removed, the bundled app
instance started by this run quit, and the pre-existing `run.jinn.shell`
application state restored from the backup taken before the run.

## Landed-surface re-confirmation — 2026-08-24

- Re-confirmation base: `main` at
  `58908f607b2661e935996c3b5c69494fad483f33`
- Previously shipped platform-foundation head:
  `0e5981ca`
- Landed-surface proof: `git diff 0e5981ca..58908f60 --` across
  `packages/web/src/platform`, the native gateway transport/profile modules,
  `packages/shell`, `docs/adr`, and `docs/platform.md` is empty
- S1 gates: typecheck, test, build, ratchet, footguns, and shell Cargo test
  exited 0. Lint exited 1 only at
  `scripts/upgrade-lab/assertions.mjs:15` (complexity 14 > 10); the same
  failure reproduced at `0e5981ca` and remains owned by an open follow-up Todo
- S2 journey result: the browser pairing/same-origin path and live native rows
  1–7, 9, 12, and 14 passed against fresh 7778/7779 sandboxes and a freshly
  built, ad-hoc signed macOS bundle. Rows 8, 11, and 13 passed their controlled
  transport/platform/Rust harnesses but were not all injected through the
  release WebView. Row 10 failed live: selecting stopped B left A current and
  described B only inside the switcher instead of activating B and rendering
  the B-named retry screen. The regression is tracked as a follow-up Todo
- Fresh evidence: the row ledger and screenshots are in
  `docs/qa/platform-foundation-evidence/reconfirm-2026-08-24/`. The four-way screenshot
  matrix is complete for the browser A/Todos state and the live row-10 failure,
  but not for every earlier human-visible row; the evidence README says so
  explicitly and does not restate the 2026-08-23 captures as freshly driven
- S2 gates: typecheck, test, build, ratchet, and footguns exited 0. Lint exited
  1 on that same line only. The focused platform run passed 7 files / 42
  tests, shell Cargo passed 17 tests, and the production JavaScript marker scan
  found zero Tauri/Capacitor implementation matches
- Unchanged gaps: Developer ID signing, notarization, iOS/Android app packaging,
  simulator/device behavior, physical devices, and store distribution remain
  unverified. No conclusion about those lanes is inferred from the macOS
  ad-hoc bundle

This re-confirmation does **not** supersede the earlier ship verdict: it records
that the landed product surface is byte-identical while also preserving the new
live row-10 discrepancy as a follow-up Todo. The platform foundation can be reviewed as the
landed feature; that follow-up owns the newly observed stopped-profile selection
behavior.
