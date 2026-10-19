// Preloaded into every Node process of the throwaway instance (NODE_OPTIONS=--require):
// the gateway, the fake providers it spawns, the hook relay. Only loopback may be reached.
// A connection to any other host is refused and appended to FAKE_PROVIDER_NET_LOG, which
// the scenario driver asserts is empty: the fake providers stand in for the upstream
// service, and nothing in the instance may spend real usage or quota behind their back.
const fs = require("node:fs");
const net = require("node:net");

const LOG = process.env.FAKE_PROVIDER_NET_LOG;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;

function record(target) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, argv1: process.argv[1] ?? null, target })}\n`);
  } catch {
    // The refusal below is what counts; a log that cannot be written must not mask it.
  }
}

/** The host a net.connect call names: undefined for a unix socket path. */
function targetOf(args) {
  // net hands itself an already-normalised [options, callback] list from some paths.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) return undefined;
    return `${first.host ?? "localhost"}:${first.port ?? ""}`;
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return undefined;
  return `${typeof args[1] === "string" ? args[1] : "localhost"}:${first}`;
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args);
  if (target !== undefined && !LOOPBACK.test(target.replace(/:\d*$/, ""))) {
    record(target);
    const error = Object.assign(new Error(`fake-provider network guard: ${target} is not loopback`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return connect.apply(this, args);
};
