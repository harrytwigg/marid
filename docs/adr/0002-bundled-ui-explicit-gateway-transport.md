# ADR 0002: Bundle the UI and make gateway transport explicit

- Status: accepted
- Date: 2026-08-18
- Decision owners: platform team

## Context

Loading a gateway URL directly inside a native webview couples application
assets, authentication, service-worker state, and navigation to one server. It
also makes it difficult to prove that an untrusted LAN or remote page cannot
reach privileged native APIs.

## Decision

The native main window always loads `WebviewUrl::App("index.html")`. The same
production web build used by the gateway is copied into the shell before native
packaging. JavaScript reaches gateways only through `GatewayTransport` and a
four-command native bridge: `pair`, `request`, `stream`, and `forget`.

The bridge accepts root-relative paths and an explicit canonical target origin.
Rust owns cookies and WebSocket authentication. Plain HTTP is restricted to
loopback — a literal loopback address or the name `localhost`; every other
gateway requires HTTPS. Commands verify the
calling window and bundled document. Capabilities contain no remote grants.

External HTTP(S) navigation opens outside the application. `hundredfold://` links are
translated to bundled in-app routes.

## Consequences

- Gateway restarts do not replace the application document or its assets.
- Service-worker and API requests stay same-origin from the web application's
  perspective; native requests never expose credentials to JavaScript.
- A hostile remote page cannot gain native IPC by being loaded in another
  window.
- The production bundle gate scans the emitted JavaScript in the bundle's asset
  directory for forbidden native framework dependency markers. The generated
  service worker sits outside that directory and is not covered.
