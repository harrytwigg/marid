import { detectOpencodeInternalFallbackFindings, INTERNAL_FALLBACK_WARNING, type FallbackFinding } from "../engines/opencode-internal-fallback.js";
import { classifyFallbackPath, internalFallbackFixLines, type HostFix } from "../engines/opencode-internal-fallback-fix.js";
import type { DoctorFinding } from "./doctor.js";

/**
 * `doctor`'s report on an opencode internal fallback: where it is on the
 * gateway's host, and on each remote host a running gateway has reached, with
 * the exact files to change. Read-only.
 */

export interface OpencodeFallbackReading {
  /** On the gateway's own host. */
  local: FallbackFinding[];
  /** On remote hosts, as the running gateway's `/api/engines` reports them. */
  remote: Array<{ host: string; sources: string[] }>;
  /** Why the remote hosts could not be read, when a gateway was expected to say. */
  remoteNote?: string;
}

/** Remote hosts' reports, from the gateway running for this home (none when it is not running). */
async function remoteReports(): Promise<Pick<OpencodeFallbackReading, "remote" | "remoteNote">> {
  try {
    const { getStatus, resolveLocalGatewayConnection } = await import("../gateway/lifecycle.js");
    const { gatewayBaseUrl } = await import("../gateway/gateway-info.js");
    const { JINN_HOME } = await import("../shared/paths.js");
    if (!getStatus().running) return { remote: [], remoteNote: "the gateway is not running, so remote hosts were not checked (it learns of them when it reaches them)" };
    const res = await fetch(`${gatewayBaseUrl(resolveLocalGatewayConnection(JINN_HOME))}/api/engines`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { remote: [], remoteNote: `the running gateway did not answer /api/engines (HTTP ${res.status}), so remote hosts were not checked` };
    const body = await res.json() as { engines?: { opencode?: { internalFallback?: { remote?: Array<{ host: string; sources: string[] }> } } } };
    return { remote: body.engines?.opencode?.internalFallback?.remote ?? [] };
  } catch (err) {
    return { remote: [], remoteNote: `the running gateway could not be asked about remote hosts (${err instanceof Error ? err.message : String(err)}), so only this host was checked` };
  }
}

/** Read this host, and the remote hosts the running gateway knows about. */
export async function collectOpencodeFallback(): Promise<OpencodeFallbackReading> {
  return { local: detectOpencodeInternalFallbackFindings({ projectDirs: [process.cwd()] }), ...(await remoteReports()) };
}

/** The doctor findings: ok, or a problem with the fix for each host. */
export function opencodeFallbackFindings(reading: OpencodeFallbackReading): DoctorFinding[] {
  const hosts: HostFix[] = [
    ...(reading.local.length ? [{ findings: reading.local }] : []),
    ...reading.remote.filter((r) => r.sources.length).map((r) => ({ host: r.host, findings: r.sources.map(classifyFallbackPath) })),
  ];
  const note: DoctorFinding[] = reading.remoteNote ? [{ level: "info", message: reading.remoteNote }] : [];
  if (hosts.length === 0) return [{ level: "ok", message: "opencode has no internal model fallback configured." }, ...note];
  return [
    { level: "problem", message: INTERNAL_FALLBACK_WARNING },
    ...internalFallbackFixLines(hosts).map((message) => ({ level: "info" as const, message: `  ${message}` })),
    ...note,
  ];
}
