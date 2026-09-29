import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { IdleCapacityPolicy, IdleCapacityPolicyDocument } from "@/lib/api-idle-capacity"
import type { Config } from "@/routes/settings/config-shape"
import { useConfigCommit, type ConfigSaveState } from "@/routes/settings/use-config-commit"
import { policyToConfigDocument, problemsByField, setPolicyField, type PolicyField } from "./policy-model"
import { usePolicyDocument } from "./use-auto-dispatch"

/**
 * The policy form's state and write path. It writes through the same
 * `PUT /api/config` hook the Settings page uses; what differs is the seed and
 * the gate. The policy and the revision it is saved against arrive in one
 * response from `/api/idle-capacity/policy`, and nothing is written until that
 * revision is held — a PUT with no revision skips the staleness check by
 * design. The revision is adopted on load and on Reload only, never after a
 * save: adopting one drops any edit queued behind the save in flight.
 */

export interface PolicyEditor {
  policy: IdleCapacityPolicy | null
  /** Changes on every seed, so the form remounts with fresh drafts on Reload. */
  seedKey: string | null
  error: string | null
  saveState: ConfigSaveState
  conflict: { message: string; remedy?: string } | null
  /** The gateway's refusal by field path (`""` for one naming no field). */
  problems: Record<string, string>
  /** True until the revision is held or while a conflict stands. */
  locked: boolean
  commitField: (field: PolicyField, value: unknown) => void
  reload: () => void
}

/** Seed the form from the document whenever a new read of it lands. */
function useSeed(document: ReturnType<typeof usePolicyDocument>, onSeed: (doc: IdleCapacityPolicyDocument) => void) {
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    const doc = document.document
    if (!doc || seeded.current === doc.revision) return
    seeded.current = doc.revision
    onSeed(doc)
  }, [document.document, onSeed])
  return useCallback(() => {
    seeded.current = null
    void document.reload()
  }, [document])
}

export function usePolicyEditor(onSaved: () => void): PolicyEditor {
  const document = usePolicyDocument()
  const [policy, setPolicy] = useState<IdleCapacityPolicy | null>(null)
  const [conflict, setConflict] = useState<{ message: string; remedy?: string } | null>(null)
  // A boolean rather than the revision string: a fresh instance with no
  // config.yaml yet has the empty revision, and that is a real value.
  const revisionHeld = useRef(false)
  const [seedKey, setSeedKey] = useState<string | null>(null)

  const { saveState, commit, adoptRevision } = useConfigCommit({
    blocker: () => (revisionHeld.current ? null : "Not saved — the config revision has not loaded yet"),
    onSaved,
    onConflict: setConflict,
  })

  const reload = useSeed(document, useCallback((doc: IdleCapacityPolicyDocument) => {
    setPolicy(doc.policy)
    adoptRevision(doc.revision)
    revisionHeld.current = true
    setSeedKey(`${doc.revision}:${Date.now()}`)
    setConflict(null)
  }, [adoptRevision]))

  const commitField = useCallback((field: PolicyField, value: unknown) => {
    setPolicy((current) => {
      if (!current) return current
      const next = setPolicyField(current, field, value)
      commit(policyToConfigDocument(next) as Config)
      return next
    })
  }, [commit])

  const problems = useMemo(
    () => (saveState.phase === "failed" && !conflict ? problemsByField(saveState.message.replace(/^Failed to save:\s*/, "")) : {}),
    [saveState, conflict],
  )

  return {
    policy, seedKey, error: document.error, saveState, conflict, problems,
    locked: !revisionHeld.current || conflict !== null,
    commitField, reload,
  }
}
