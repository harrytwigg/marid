import { within } from '@testing-library/react'
import { SPLIT_LAYOUT_STORAGE_KEY } from '../layout/split-layout-storage'

export interface SeedGroup { tabs: string[]; activeTab?: string }

/** The pane tree a reload restores: one group per entry, `focused` (the first by default) holding focus. */
export function seedLayout(groups: SeedGroup[], { pinned = [], focused = 0 }: { pinned?: string[]; focused?: number } = {}) {
  const children = groups.map(({ tabs, activeTab }, index) => ({ type: 'group', id: `g${index + 1}`, tabs, activeTab: activeTab ?? tabs[0] }))
  const root = children.length === 1
    ? children[0]
    : { type: 'split', id: 's1', direction: 'row', children, sizes: children.map(() => 1 / children.length) }
  localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1, auto: false, focusedGroupId: `g${focused + 1}`, focusHistory: groups.flatMap((g) => g.tabs), nextId: 9, root, pinned,
  }))
}

export interface StoredGroup { type: 'group'; tabs: string[] }
export function storedGroups(): StoredGroup[] {
  const root = JSON.parse(localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? '{}').root as { type: string; children?: StoredGroup[] } | undefined
  if (!root) return []
  return root.type === 'group' ? [root as StoredGroup] : root.children ?? []
}

export const todosPanes = () => document.querySelectorAll('[data-doc-pane-kind="todos"]')
export const chatPanes = () => [...document.querySelectorAll('[data-chat-pane-session]:not([data-chat-pane-session="new"])')].map((node) => node.getAttribute('data-chat-pane-session'))
export const composerPanes = () => document.querySelectorAll('[data-chat-pane-session="new"]')
export const settled = () => new Promise((resolve) => setTimeout(resolve, 80))
export const railLink = (name: string) => within(document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!).getByRole('link', { name })

export function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

