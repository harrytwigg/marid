import { describe, expect, it } from 'vitest'
import {
  buildSessionForest,
  flattenSessionForest,
  subtreeSessions,
  type SessionTreeNode,
} from '../session-tree'
import type { Session } from '../session-signals'

// Minutes after a fixed epoch, so "newer" is explicit in every fixture.
function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 29, 12, minute)).toISOString()
}

function s(id: string, parentSessionId: string | null, minute: number, extra: Partial<Session> = {}): Session {
  return { id, title: id, source: 'web', parentSessionId, lastActivity: at(minute), ...extra }
}

/** `id(child,child…)` — compact shape of a forest for assertions. */
function shape(nodes: readonly SessionTreeNode[]): string[] {
  return nodes.map((node) =>
    node.children.length ? `${node.session.id}(${shape(node.children).join(',')})` : node.session.id,
  )
}

describe('buildSessionForest', () => {
  it('nests children under their parent at every depth (COO → developer → QA)', () => {
    const forest = buildSessionForest([
      s('qa', 'dev', 3),
      s('coo', null, 1),
      s('dev', 'coo', 2),
      s('solo', null, 0),
    ])
    expect(shape(forest)).toEqual(['coo(dev(qa))', 'solo'])
    expect(forest[0].rootKind).toBe('root')
    expect(forest[0].descendantCount).toBe(2)
    expect(forest[0].children[0].descendantCount).toBe(1)
  })

  it('orders roots and siblings by the newest activity anywhere in their subtree', () => {
    const forest = buildSessionForest([
      s('a', null, 10),
      s('b', null, 5),
      s('b-child', 'b', 20),
      s('a-old', 'a', 1),
      s('a-new', 'a', 11),
    ])
    expect(shape(forest)).toEqual(['b(b-child)', 'a(a-new,a-old)'])
    expect(forest[0].activity).toBe(at(20))
  })

  it('treats an empty or blank parentSessionId as no parent', () => {
    const forest = buildSessionForest([s('a', '', 1), s('b', '   ', 2), s('c', null, 3)])
    expect(shape(forest)).toEqual(['c', 'b', 'a'])
    expect(forest.every((node) => node.rootKind === 'root')).toBe(true)
  })

  it('shows a child whose parent is not loaded as an orphaned root', () => {
    const forest = buildSessionForest([s('child', 'archived-parent', 2), s('grandchild', 'child', 3)])
    expect(shape(forest)).toEqual(['child(grandchild)'])
    expect(forest[0].rootKind).toBe('orphan')
  })

  it('nests across employee groups: grouping is not part of the tree', () => {
    const forest = buildSessionForest([
      s('coo', null, 1, { employee: undefined }),
      s('dev', 'coo', 2, { employee: 'builder', source: 'workflow' }),
      s('qa', 'dev', 3, { employee: 'reviewer' }),
    ])
    expect(shape(forest)).toEqual(['coo(dev(qa))'])
  })

  it('re-nests an orphan once its parent is loaded (a later load-more page)', () => {
    const firstPage = [s('child', 'parent', 2)]
    expect(buildSessionForest(firstPage)[0].rootKind).toBe('orphan')
    const withParent = buildSessionForest([...firstPage, s('parent', null, 1)])
    expect(shape(withParent)).toEqual(['parent(child)'])
    expect(withParent[0].rootKind).toBe('root')
  })

  it('breaks a two-node cycle at its newest member without losing either', () => {
    const forest = buildSessionForest([s('a', 'b', 1), s('b', 'a', 2)])
    expect(shape(forest)).toEqual(['b(a)'])
    expect(forest[0].rootKind).toBe('cycle')
  })

  it('breaks a self-parented session into a cycle root', () => {
    const forest = buildSessionForest([s('self', 'self', 1)])
    expect(shape(forest)).toEqual(['self'])
    expect(forest[0].rootKind).toBe('cycle')
    expect(forest[0].descendantCount).toBe(0)
  })

  it('keeps a session hanging below a cycle nested, even when it is the newest', () => {
    // a → b → c → a is the loop; tail hangs off c and is the newest of all.
    const forest = buildSessionForest([
      s('a', 'c', 1),
      s('b', 'a', 3),
      s('c', 'b', 2),
      s('tail', 'c', 9),
    ])
    expect(forest).toHaveLength(1)
    // b is the newest cycle member, so the loop breaks there.
    expect(forest[0].session.id).toBe('b')
    expect(forest[0].rootKind).toBe('cycle')
    expect(shape(forest)).toEqual(['b(c(tail,a))'])
    expect(forest[0].descendantCount).toBe(3)
  })

  it('handles separate cycles independently', () => {
    const forest = buildSessionForest([s('a', 'b', 1), s('b', 'a', 2), s('x', 'y', 4), s('y', 'x', 3)])
    expect(shape(forest)).toEqual(['x(y)', 'b(a)'])
    expect(forest.map((node) => node.rootKind)).toEqual(['cycle', 'cycle'])
  })

  it('builds a very deep chain without recursion', () => {
    const depth = 20_000
    const sessions = Array.from({ length: depth }, (_, i) => s(`n${i}`, i === 0 ? null : `n${i - 1}`, 0))
    const forest = buildSessionForest(sessions)
    expect(forest).toHaveLength(1)
    expect(forest[0].descendantCount).toBe(depth - 1)
    const rows = flattenSessionForest(forest, new Set())
    expect(rows).toHaveLength(depth)
    expect(rows[depth - 1].depth).toBe(depth - 1)
  })

  it('builds a very long cycle without recursion', () => {
    const size = 20_000
    const sessions = Array.from({ length: size }, (_, i) => s(`n${i}`, `n${(i + 1) % size}`, i % 60))
    const forest = buildSessionForest(sessions)
    expect(forest).toHaveLength(1)
    expect(forest[0].rootKind).toBe('cycle')
    expect(forest[0].descendantCount).toBe(size - 1)
  })

  it('keeps the first occurrence of a duplicated id', () => {
    const forest = buildSessionForest([s('a', null, 1, { title: 'first' }), s('a', null, 2, { title: 'second' })])
    expect(forest).toHaveLength(1)
    expect(forest[0].session.title).toBe('first')
  })
})

describe('flattenSessionForest', () => {
  const forest = () =>
    buildSessionForest([
      s('coo', null, 5),
      s('dev', 'coo', 4),
      s('qa', 'dev', 3),
      s('other', null, 1),
    ])

  it('emits rows depth-first with their depth', () => {
    const rows = flattenSessionForest(forest(), new Set())
    expect(rows.map((row) => `${row.node.session.id}@${row.depth}`)).toEqual(['coo@0', 'dev@1', 'qa@2', 'other@0'])
    expect(rows.every((row) => !row.collapsed)).toBe(true)
  })

  it('hides everything under a collapsed node and flags it', () => {
    const rows = flattenSessionForest(forest(), new Set(['dev']))
    expect(rows.map((row) => row.node.session.id)).toEqual(['coo', 'dev', 'other'])
    expect(rows[1].collapsed).toBe(true)
    expect(rows[1].node.descendantCount).toBe(1)
  })

  it('ignores a collapsed id on a leaf', () => {
    const rows = flattenSessionForest(forest(), new Set(['other']))
    expect(rows.find((row) => row.node.session.id === 'other')?.collapsed).toBe(false)
  })
})

describe('subtreeSessions', () => {
  it('returns the node and every descendant', () => {
    const [root] = buildSessionForest([s('coo', null, 3), s('dev', 'coo', 2), s('qa', 'dev', 1)])
    expect(subtreeSessions(root).map((session) => session.id).sort()).toEqual(['coo', 'dev', 'qa'])
  })
})
