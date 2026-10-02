import type { EnginesConfig } from "./engines/chain-model"

/**
 * config.yaml as this page edits it.
 *
 * Partial all the way down on purpose: the page PUTs the whole document back and
 * the gateway keeps every key the body omits, so a field this type does not name
 * still survives a save. The index signature is what makes that true rather than
 * merely hoped for.
 */
export interface Config {
  gateway?: { port?: number; host?: string }
  engines?: EnginesConfig
  sessions?: {
    interruptOnNewMessage?: boolean
    rateLimitStrategy?: "wait" | "fallback" | null
    fallbackEngine?: string | null
    staleChat?: {
      enabled?: boolean
      tokenThreshold?: number
      staleAfterMinutes?: number
    }
  }
  connectors?: {
    slack?: {
      appToken?: string
      botToken?: string
      shareSessionInChannel?: boolean
      allowFrom?: string | string[]
      ignoreOldMessagesOnBoot?: boolean
    }
    discord?: {
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
    }
    telegram?: {
      botToken?: string
      allowFrom?: number[]
      ignoreOldMessagesOnBoot?: boolean
    }
    whatsapp?: {
      authDir?: string
      allowFrom?: string[]
    }
    web?: Record<string, never>
    instances?: Array<{
      id: string
      type: "discord" | "slack" | "whatsapp" | "telegram"
      employee?: string
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
      appToken?: string
      authDir?: string
      ignoreOldMessagesOnBoot?: boolean
      [key: string]: unknown
    }>
  }
  logging?: {
    level?: string
    stdout?: boolean
    file?: boolean
  }
  models?: Record<string, {
    default?: string
    effortMechanism?: string
    hidden?: string[]
    models: Array<{
      id: string
      label?: string
      supportsEffort?: boolean
      effortLevels?: string[]
      contextWindow?: number
    }>
  }>
  cron?: {
    defaultDelivery?: { connector?: string; channel?: string }
  }
  /** `apiKey` arrives redacted; see voice-section.tsx for what that means here. */
  realtime?: {
    provider?: string
    model?: string
    apiKey?: string
    voice?: string
    /** A bare name, or the tuned mapping form the provider's own union allows. */
    turnDetection?: string | { type?: string; [key: string]: unknown }
    noiseReduction?: string
  }
  portal?: {
    companyName?: string
    companyPrefix?: string
    portalName?: string
    operatorName?: string
  }
  [key: string]: unknown
}

