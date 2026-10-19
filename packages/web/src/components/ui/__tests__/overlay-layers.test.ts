import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { REACT_ARIA_OVERLAY_Z_INDEX } from "../overlay-layers"

const SRC = path.resolve(__dirname, "../../..")
const TABLE = readFileSync(path.resolve(__dirname, "../overlay-layers.ts"), "utf8")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : []
  })
}

/** Every z-index the source asks for: Tailwind `z-[N]` and `z-N`, an inline `zIndex`, and CSS `z-index`. */
function layersInUse(): Map<number, string[]> {
  const found = new Map<number, string[]>()
  const pattern = /(?<![\w-])z-\[(\d+)\]|(?<![\w-])z-(\d+)(?![\w-])|zIndex:\s*(\d+)|z-index:\s*(\d+)/g
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const layer = Number(match[1] ?? match[2] ?? match[3] ?? match[4])
      found.set(layer, [...(found.get(layer) ?? []), path.relative(SRC, file)])
    }
  }
  return found
}

describe("overlay layers", () => {
  it("keeps every first-party layer below React Aria's, so a tooltip or popover is never covered", () => {
    const highest = Math.max(...layersInUse().keys())

    expect(highest).toBeLessThan(REACT_ARIA_OVERLAY_Z_INDEX)
  })

  it("lists every layer from 60 up in the stacking table", () => {
    const missing = [...layersInUse()]
      .filter(([layer]) => layer >= 60)
      .filter(([layer]) => !new RegExp(`^ \\*\\s+${layer}\\s+\\|`, "m").test(TABLE))
      .map(([layer, files]) => `${layer} (${[...new Set(files)].join(", ")})`)

    expect(missing).toEqual([])
  })

  it("states React Aria's layer in the table the way React Aria sets it", () => {
    expect(TABLE).toMatch(new RegExp(`^ \\*\\s+${REACT_ARIA_OVERLAY_Z_INDEX}\\s+\\|`, "m"))
  })
})
