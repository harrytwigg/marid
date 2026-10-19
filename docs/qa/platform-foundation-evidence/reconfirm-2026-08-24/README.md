# Platform foundation live re-confirmation evidence — 2026-08-24

Head: `58908f607b2661e935996c3b5c69494fad483f33`

This run used fresh, isolated gateways `Pla-118-a` on 7778 and `Pla-118-b` on
7779, an isolated browser profile, and a freshly built and ad-hoc signed
`Jinn.app`. It did not connect to 7777 or 7788 and did not use the installed
Jinn home.

## Journey result

| Row | Result | Evidence |
| --- | --- | --- |
| 1 | Pass | Browser A paired with a one-time code; `/api/sessions` returned 200, `document.cookie` was empty, and no pairing screen remained. |
| 2 | Pass | The in-app Todos link navigated with the SPA to `/todos/b/home`; A's origin and HttpOnly session remained intact. Browser screenshots below. |
| 3 | Pass | The release bundle opened bundled assets at the native `Connect Jinn` screen with no saved profile. A complete ad-hoc signature was required before Keychain storage could be exercised. |
| 4 | Pass | A paired, became ready, displayed `Pla-118-a`, and rendered A's settings/data. |
| 5 | Pass | B paired as a second profile while A stayed current; exact-origin Keychain accounts existed independently for ports 7778 and 7779. |
| 6 | Pass | A→B preserved the Settings route and changed the rendered company identity to `Pla-118-b`. |
| 7 | Pass | B→A restored `Pla-118-a` on the same route. |
| 8 | Controlled harness pass; not live UI | The exact delayed REST/WebSocket quarantine cases passed in `native-gateway-profiles.test.ts`; this run did not inject frames into the release WebView. |
| 9 | Pass | Removing B removed its profile and exact-origin Keychain entry while A remained ready and usable. |
| 10 | **Fail** | After re-adding and stopping B, selecting it left A marked current and showed B only as `Gateway is unreachable` in the menu. It did not render the required B-active `Cannot reach Pla-118-b` retry screen. Tracked as PLA-241. |
| 11 | Controlled harness pass; not live declared-fallback UI | Unsupported, permission-required, and denied results remained distinct across the 42-test focused web run. |
| 12 | Pass | Fresh browser and native cold starts showed no permission prompt before a gesture; the no-startup-prompt contract also passed. |
| 13 | Controlled native harness pass | All 17 Rust tests passed, including non-loopback HTTP refusal, native caller confinement, and external-navigation routing. No external URL was opened during this run. |
| 14 | Pass | The emitted production JavaScript had zero Tauri/Capacitor implementation-marker matches. |

The focused web harness passed 7 files / 42 tests. The shell harness passed all
17 Rust tests. Signing identity, notarization, physical-device behavior, and
store distribution remain unverified.

## Screenshot matrix

Browser A/Todos is captured at the requested desktop/mobile dimensions in both
themes:

- `browser-a-todos-desktop-light.png`
- `browser-a-todos-desktop-dark.png`
- `browser-a-todos-mobile-light.png`
- `browser-a-todos-mobile-dark.png`

The live row-10 failure is captured at the requested dimensions in both themes:

- `native-b-unreachable-desktop-light.png`
- `native-b-unreachable-desktop-dark.png`
- `native-b-unreachable-mobile-light.png`
- `native-b-unreachable-mobile-dark.png`

Auxiliary native captures record A ready, the A+B profile menu, B active, A
restored, and B removed. The requested four-way screenshot matrix was not
completed for every human-visible row because row 10 failed and terminated the
journey; earlier rows are not represented as a fresh complete matrix.
