/**
 * Muse Code's reasoning-effort vocabulary.
 *
 * `turn/start.reasoningEffort` takes these tiers. `none` is the protocol's "no
 * reasoning", which the Meta provider rejects, so it is never offered to an
 * employee and never sent. A model's own `variants` (from `model/list`) narrow
 * the list further where a catalog is known.
 */
export const MUSECODE_EFFORT_VOCABULARY = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** The tiers offered to an employee by default. */
export const MUSECODE_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
