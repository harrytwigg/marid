import { describe, expect, it } from 'vitest'
import { subagentTabId, parseSubagentTabId, isSubagentTabId, subagentTabTitle } from '../subagent-tab'
import { isChatTabId, isDocTabId, paneTabKind, parseDocTabId } from '../tab-kind'
import { appendSession, closeSession, createSplitLayout, groupOfSession, openDocTab, workingSetFromLayout } from '../split-layout'
import { paneTabItems } from '../pane-tab-ops'

const ref = { sessionId: 'a', agentId: 'a0123456789abcdef', description: 'Audit the storefront & files', agentType: 'general-purpose' }
const tab = subagentTabId(ref)

describe('a sub-agent tab id', () => {
  it('round-trips its session, agent and labels, whatever characters they hold', () => {
    expect(parseSubagentTabId(tab)).toEqual(ref)
    const bare = { sessionId: 'a', agentId: 'x1', description: null, agentType: null }
    expect(parseSubagentTabId(subagentTabId(bare))).toEqual(bare)
  })

  it('is its own kind of document tab, and no session id is ever one', () => {
    expect(isSubagentTabId(tab)).toBe(true)
    expect(isSubagentTabId('a')).toBe(false)
    expect(paneTabKind(tab)).toBe('subagent')
    expect(isDocTabId(tab)).toBe(true)
    expect(isChatTabId(tab)).toBe(false)
    expect(parseDocTabId(tab)).toEqual({ kind: 'subagent', subagent: ref })
  })

  it('is refused without its session or agent', () => {
    expect(parseSubagentTabId('subagent:agent=x')).toBeNull()
    expect(parseSubagentTabId('subagent:session=a')).toBeNull()
    expect(parseSubagentTabId('a')).toBeNull()
  })

  it('is called by its description, else Sub-agent', () => {
    expect(subagentTabTitle(ref)).toBe('Audit the storefront & files')
    expect(subagentTabTitle({ description: null })).toBe('Sub-agent')
  })
})

describe('a sub-agent tab in the layout', () => {
  const layout = () => appendSession(createSplitLayout(['a'], 'a'), 'b')

  it('opens beside the chat that launched it, shown, without changing the working set', () => {
    const before = layout()
    const after = openDocTab(before, 'a', tab)
    expect(groupOfSession(after, 'a')!.tabs).toEqual(['a', tab])
    expect(groupOfSession(after, 'a')!.activeTab).toBe(tab)
    // The working set, and so the URL, still name only chats.
    expect(workingSetFromLayout(after).sessionIds).toEqual(workingSetFromLayout(before).sessionIds)
  })

  it('opens once however many times it is asked for', () => {
    const once = openDocTab(layout(), 'a', tab)
    expect(groupOfSession(openDocTab(once, 'a', tab), 'a')!.tabs).toEqual(['a', tab])
  })

  it('shows in the strip with the sub-agent kind and its description', () => {
    const group = groupOfSession(openDocTab(layout(), 'a', tab), 'a')!
    expect(paneTabItems(group, () => undefined).find((item) => item.id === tab)).toEqual({ id: tab, kind: 'subagent', title: 'Audit the storefront & files' })
  })

  it('closes back to the chat it sat beside', () => {
    const closed = closeSession(openDocTab(layout(), 'a', tab), tab)
    expect(groupOfSession(closed, 'a')!.tabs).toEqual(['a'])
  })
})
