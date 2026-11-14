import type { GatewayProfile } from "./gateway-transport"
import { LEGACY_STORAGE_KEYS } from "@hundredfold/legacy-names"

const STORAGE_KEY = "hundredfold.native.gateway-profiles.v1"
const LEGACY_ACTIVE_ORIGIN_KEY = LEGACY_STORAGE_KEYS.activeOrigin

export interface NativeGatewayProfile extends GatewayProfile {
  name: string
  deviceId: string
}

interface PersistedProfiles {
  version: 1
  activeId?: string
  profiles: NativeGatewayProfile[]
}

export function canonicalNativeGatewayOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid native gateway origin")
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Native gateway profiles require a bare origin")
  }
  return url.origin
}

export function nativeGatewayProfileId(origin: string): string {
  return `native:${origin}`
}

export function loadNativeGatewayProfiles(storage: Storage): PersistedProfiles {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const value = JSON.parse(raw) as Partial<PersistedProfiles>
      if (value.version === 1 && Array.isArray(value.profiles)) {
        const profiles = value.profiles.filter(isNativeGatewayProfile)
        const activeId = profiles.some((profile) => profile.id === value.activeId)
          ? value.activeId
          : undefined
        return { version: 1, activeId, profiles }
      }
    }
    const legacyOrigin = storage.getItem(LEGACY_ACTIVE_ORIGIN_KEY)
    if (legacyOrigin) return migrateLegacyOrigin(legacyOrigin)
  } catch {
    // Invalid persisted state is treated as empty; pairing can repair it.
  }
  return { version: 1, profiles: [] }
}

export function persistNativeGatewayProfiles(
  storage: Storage,
  value: Omit<PersistedProfiles, "version">,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...value } satisfies PersistedProfiles))
  storage.removeItem(LEGACY_ACTIVE_ORIGIN_KEY)
}

function isNativeGatewayProfile(entry: NativeGatewayProfile): entry is NativeGatewayProfile {
  return typeof entry?.id === "string"
    && typeof entry.origin === "string"
    && typeof entry.name === "string"
    && typeof entry.deviceId === "string"
}

function migrateLegacyOrigin(rawOrigin: string): PersistedProfiles {
  const origin = canonicalNativeGatewayOrigin(rawOrigin)
  const profile = {
    id: nativeGatewayProfileId(origin),
    origin,
    name: new URL(origin).host,
    deviceId: "",
  }
  return { version: 1, activeId: profile.id, profiles: [profile] }
}
