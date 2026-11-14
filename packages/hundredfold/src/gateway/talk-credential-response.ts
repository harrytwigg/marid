import type { RealtimeNoiseReduction, RealtimeTool } from "../shared/voice.js";
import type { TalkControlManifest } from "../talk/control/types.js";
import type { TalkSession } from "../talk/session/types.js";
import { talkSessionStatus } from "./talk-session-status.js";

interface MintedCredential {
  value: string;
  expiresAt: number;
  vadType: "server_vad" | "semantic_vad";
  noiseReduction: RealtimeNoiseReduction;
}

/** One public shape for both opening and rotating a provider credential. */
export function talkCredentialResponse(
  session: TalkSession,
  manifest: TalkControlManifest,
  token: MintedCredential,
  tools: RealtimeTool[],
) {
  return {
    ...talkSessionStatus(session, manifest),
    token: token.value,
    expiresAt: token.expiresAt,
    vadType: token.vadType,
    noiseReduction: token.noiseReduction,
    tools,
  };
}
