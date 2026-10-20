import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScrollingEmptyState, TranscriptEmptyState } from '../chat-transcript-empty'

describe('ScrollingEmptyState', () => {
  it('scrolls, and centres through an inner column that grows past the frame', () => {
    // jsdom has no layout, so this pins the structure that makes a tall child scrollable from its first row:
    // a centring flex box that is shorter than its content overflows above its top edge, where no scroll reaches.
    render(<ScrollingEmptyState><button type="button">Pick me</button></ScrollingEmptyState>)
    const column = screen.getByRole('button', { name: 'Pick me' }).parentElement as HTMLElement
    const frame = column.parentElement as HTMLElement
    expect(frame.className).toContain('overflow-y-auto')
    expect(frame.className).toContain('h-full')
    expect(frame.className).not.toContain('justify-center')
    expect(column.className).toContain('min-h-full')
    expect(column.className).toContain('justify-center')
  })
})

describe('TranscriptEmptyState', () => {
  it('hands a child that fills the overlay (the "Open chat" picker) the overlay itself', () => {
    // The session picker is `h-full` with its own scrolling virtualised list. It needs the overlay's definite
    // height: no scroll or padding wrapper may sit between them, or its list grows to its full content height.
    render(<TranscriptEmptyState><section aria-label="Choose a chat" /></TranscriptEmptyState>)
    const overlay = screen.getByLabelText('Choose a chat').parentElement as HTMLElement
    expect(overlay.className).toContain('absolute')
    expect(overlay.className).toContain('inset-0')
    expect(overlay.className).not.toContain('overflow')
    expect(overlay.className).not.toMatch(/\bp[tb]-/)
  })

  it('shows the default prompt without children', () => {
    render(<TranscriptEmptyState />)
    expect(screen.getByText('Start a conversation')).toBeTruthy()
  })
})
