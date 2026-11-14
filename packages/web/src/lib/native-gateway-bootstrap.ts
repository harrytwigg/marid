import { installGatewayTransport } from "./gateway-transport"
import {
  createNativeGatewayProfiles,
  type NativeGatewayProfiles,
  type NativeGatewayProfilesSnapshot,
} from "./native-gateway-profiles"
import { queryClient } from "./query-client"
import { nativeBridge } from "@/platform/native-bridge"

const PROFILE_BOUND_KEYS = [
  "hundredfold-chat-tabs",
  "hundredfold-read-sessions",
  "hundredfold-sidebar-collapsed",
  "hundredfold-sidebar-expanded",
  "hundredfold-notes-last-location",
] as const
const PROFILE_BOUND_PREFIXES = ["hundredfold-intermediate-", "hundredfold-view-mode-", "hundredfold-note-draft-"] as const

let manager: NativeGatewayProfiles | undefined

function resetProfileBoundStorage(storage: Storage): void {
  for (const key of PROFILE_BOUND_KEYS) storage.removeItem(key)
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null)
  for (const key of keys) {
    if (PROFILE_BOUND_PREFIXES.some((prefix) => key.startsWith(prefix))) storage.removeItem(key)
  }
}

function createManager(): NativeGatewayProfiles | undefined {
  const bridge = nativeBridge()
  if (!bridge || typeof localStorage === "undefined") return undefined
  return createNativeGatewayProfiles({
    bridge,
    storage: localStorage,
    beforeCommit: async () => {
      await queryClient.cancelQueries()
      queryClient.clear()
      resetProfileBoundStorage(localStorage)
    },
  })
}

export function nativeGatewayProfiles(): NativeGatewayProfiles | undefined {
  manager ??= createManager()
  return manager
}

export function installSavedNativeGateway(): string | undefined {
  const profiles = nativeGatewayProfiles()
  const active = profiles?.snapshot().profiles.find((profile) => profile.id === profiles.snapshot().activeId)
  if (!profiles || !active) return undefined
  installGatewayTransport(profiles.transport)
  return active.origin
}

export function nativeGatewaySnapshot(): NativeGatewayProfilesSnapshot | undefined {
  return nativeGatewayProfiles()?.snapshot()
}

export async function pairNativeGatewayProfile(origin: string, code: string, activate = false) {
  const profiles = nativeGatewayProfiles()
  if (!profiles) throw new Error("The native gateway bridge is unavailable")
  // Activation emits synchronously. Install the stable managed transport first
  // so the provider remount cannot observe tauri://localhost in the gap.
  installGatewayTransport(profiles.transport)
  const profile = await profiles.pair(origin, code, { activate })
  return profile
}

export async function pairAndInstallNativeGateway(origin: string, code: string): Promise<string> {
  return (await pairNativeGatewayProfile(origin, code, true)).origin
}
