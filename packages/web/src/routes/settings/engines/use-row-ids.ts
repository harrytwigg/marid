import { useRef } from "react"

/**
 * A stable identity for each row of a chain. A row's key cannot be its position
 * (a move would hand the focused button to another link) or its link (the link
 * changes as it is edited, and the select being used would remount), so the ids
 * travel with the rows: `moved` and `removed` are told what the editor did, and a
 * longer list than the ids hold (a row added, a chain that arrived whole) is
 * padded with new ones.
 */
export function useRowIds(count: number) {
  const next = useRef(0)
  const ids = useRef<string[]>([])
  while (ids.current.length < count) ids.current.push(`row-${next.current++}`)
  if (ids.current.length > count) ids.current.length = count
  return {
    ids: ids.current,
    moved: (from: number, to: number) => {
      const [id] = ids.current.splice(from, 1)
      ids.current.splice(to, 0, id)
    },
    removed: (index: number) => {
      ids.current.splice(index, 1)
    },
  }
}
