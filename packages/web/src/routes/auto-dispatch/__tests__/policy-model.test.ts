import { describe, expect, it } from "vitest"
import type { IdleCapacityPolicy } from "@/lib/api-idle-capacity"
import { numberFieldValue, policyToConfigDocument, problemsByField, setPolicyField } from "../policy-model"

const tier = (max: number) => ({
  enabled: true,
  fiveHour: { maxUsedPercent: max, lookaheadMinutes: 120 },
  sevenDay: { maxUsedPercent: 75, lookaheadMinutes: 1440 },
  maxDispatchesPerWindow: 2,
  maxActiveSessions: 1,
})

const policy: IdleCapacityPolicy = {
  enabled: false,
  intervalMinutes: 10,
  timezone: "Europe/London",
  quietHours: { start: "01:00", end: "06:00" },
  operatorActivity: { idleMinutes: 30, usageDeltaPercent: 2 },
  tiers: { overnight: tier(85), daytime: tier(50), interactive: tier(20) },
  requireLabel: null,
}

describe("policyToConfigDocument", () => {
  it("writes the whole block under gateway.idleCapacity with every key explicit", () => {
    const doc = policyToConfigDocument(policy)
    expect(Object.keys(doc)).toEqual(["gateway"])
    expect(doc.gateway.idleCapacity).toEqual(policy)
    expect(doc.gateway.idleCapacity).not.toBe(policy)
  })

  it("sends an empty opt-in label as null, which is how the merge removes the key", () => {
    expect(policyToConfigDocument({ ...policy, requireLabel: "  " }).gateway.idleCapacity.requireLabel).toBeNull()
    expect(policyToConfigDocument({ ...policy, requireLabel: " idle-ok " }).gateway.idleCapacity.requireLabel).toBe("idle-ok")
  })
})

describe("setPolicyField", () => {
  it("replaces one nested field without touching the rest or the original", () => {
    const next = setPolicyField(policy, "tiers.daytime.fiveHour.maxUsedPercent", 40)
    expect(next.tiers.daytime.fiveHour.maxUsedPercent).toBe(40)
    expect(next.tiers.daytime.fiveHour.lookaheadMinutes).toBe(120)
    expect(next.tiers.overnight).toEqual(policy.tiers.overnight)
    expect(policy.tiers.daytime.fiveHour.maxUsedPercent).toBe(50)
    expect(setPolicyField(policy, "quietHours.end", "05:30").quietHours).toEqual({ start: "01:00", end: "05:30" })
    expect(setPolicyField(policy, "enabled", true).enabled).toBe(true)
  })
})

describe("problemsByField", () => {
  it("maps each of the gateway's problems onto the key path it names", () => {
    const message =
      "Invalid config: gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent must be a number between 0 and 100 (got 120); " +
      "gateway.idleCapacity.timezone is not a time zone this runtime knows (got \"Mars/Olympus\")"
    expect(problemsByField(message)).toEqual({
      "tiers.daytime.fiveHour.maxUsedPercent": "must be a number between 0 and 100 (got 120)",
      timezone: "is not a time zone this runtime knows (got \"Mars/Olympus\")",
    })
  })

  it("keeps a problem that names no field, so it is shown rather than lost", () => {
    expect(problemsByField("Invalid config: gateway.idleCapacity must be a mapping")).toEqual({ "": "gateway.idleCapacity must be a mapping" })
    expect(problemsByField("config.yaml could not be read")).toEqual({ "": "config.yaml could not be read" })
  })

  it("does not split on a semicolon inside a message", () => {
    expect(problemsByField("Invalid config: gateway.idleCapacity.requireLabel must be a label name; with a letter (got \"--\")"))
      .toEqual({ requireLabel: "must be a label name; with a letter (got \"--\")" })
  })
})

describe("numberFieldValue", () => {
  it("is undefined for blank or non-numeric text, so nothing is written", () => {
    expect(numberFieldValue("")).toBeUndefined()
    expect(numberFieldValue("  ")).toBeUndefined()
    expect(numberFieldValue("abc")).toBeUndefined()
    expect(numberFieldValue("85")).toBe(85)
    expect(numberFieldValue(" 2.5 ")).toBe(2.5)
  })
})
