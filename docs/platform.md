# Platform capabilities

Hundredfold's product code asks for typed platform intents. It does not read browser or
native globals directly. The contract lives in
`packages/web/src/platform/contracts.ts`; adapters live under
`packages/web/src/platform/adapters/`.

## Result semantics

These outcomes are deliberately different:

- `unsupported`: no adapter implements the intent in this runtime.
- `permission-required`: the capability exists but needs a user gesture or
  permission prompt.
- `denied`: the user or operating system refused permission.
- `cancelled`: the user abandoned an otherwise supported operation.
- `failed`: an implemented operation encountered an error.

Unsupported intents resolve normally and never throw. Adapter exceptions are
normalized to `failed`.

## Capability matrix

`Conditional` means the web API must exist and, where applicable, the document
must be a secure context. The web adapter is first in the chain in every
container, so a conditional intent follows the same rule under Tauri as in the
browser; `unverified` marks a native webview where we have not confirmed the API
is present. `Shell only` means the native window implements the behavior
internally and no product intent reaches it.

| Intent family | Browser | Installed PWA | Tauri macOS | Tauri iOS | Tauri Android |
| --- | --- | --- | --- | --- | --- |
| feedback | Conditional vibration | Conditional vibration | Conditional; unverified | Conditional; unverified | Conditional; unverified |
| notifications | Conditional + permission | Conditional + permission | Conditional + permission; unverified | Conditional + permission; unverified | Conditional + permission; unverified |
| badges | Conditional | Conditional | Conditional; unverified | Conditional; unverified | Conditional; unverified |
| sharing | Conditional Web Share | Conditional Web Share | Conditional Web Share; unverified | Conditional Web Share; unverified | Conditional Web Share; unverified |
| lifecycle | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| navigation | External URL supported | External URL supported | Supported; shell opens it outside the webview | Supported; shell routing unverified | Supported; shell routing unverified |
| viewport | Keyboard inset conditional; orientation unsupported | Same | Same; unverified | Same; unverified | Same; unverified |
| clipboard | Conditional secure-context API | Conditional secure-context API | Conditional; unverified | Conditional; unverified | Conditional; unverified |
| files | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| install | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| window | Unsupported | Unsupported | Shell only: geometry and menu | Unsupported | Unsupported |
| device | Unsupported | Unsupported | Product intent unsupported; gateway auth uses Keychain internally | Product intent unsupported; Keychain path cross-compiles | Unsupported; no Android credential backend is compiled in |

The table describes shipped code, not desired parity. Update it in the same
change that implements and verifies a capability.

## Adding an intent

1. Add the intent and, if observable, event to `contracts.ts`. Keep the result
   taxonomy; do not encode denial or failure as unsupported.
2. Add a contract test proving fallback behavior and the expected result state.
3. Implement the narrowest adapter that owns the platform API. Browser APIs go
   in `adapters/web.ts`; native behavior goes behind the lazy Tauri adapter.
4. Expose a product-level wrapper near the owning feature. Product modules may
   call `getPlatform()`, but must not read native globals or capability APIs
   directly.
5. Update the capability matrix and add platform-specific verification. Device
   or signing gaps stay `unverified`; compilation is not device proof.
6. Build the production web output and run `pnpm --filter @hundredfold/web perf:budget`
   so forbidden native dependencies cannot enter emitted assets.

The product-boundary test enforces step 4. Runtime detection remains centralized
in `platform/runtime.ts`, and the lazy adapter keeps native-only code off the
browser's initial path.
