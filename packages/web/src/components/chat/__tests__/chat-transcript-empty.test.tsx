import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TranscriptEmptyState } from '../chat-transcript-empty'

describe('TranscriptEmptyState', () => {
  it('scrolls, and centres through an inner column that grows past the overlay', () => {
    // jsdom has no layout, so this pins the structure that makes a tall child scrollable from its first row:
    // a centring flex box that is shorter than its content overflows above its top edge, where no scroll reaches.
    render(<TranscriptEmptyState><button type="button">Pick me</button></TranscriptEmptyState>)
    const column = screen.getByRole('button', { name: 'Pick me' }).parentElement as HTMLElement
    const overlay = column.parentElement as HTMLElement
    expect(overlay.className).toContain('overflow-y-auto')
    expect(overlay.className).not.toContain('justify-center')
    expect(column.className).toContain('min-h-full')
    expect(column.className).toContain('justify-center')
  })

  it('shows the default prompt without children', () => {
    render(<TranscriptEmptyState />)
    expect(screen.getByText('Start a conversation')).toBeTruthy()
  })
})
