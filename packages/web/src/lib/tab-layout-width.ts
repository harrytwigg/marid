import { useEffect, useState } from 'react'

/** The narrowest window the chat page lays out tabs in: below it the page is its mobile layout, which has no tab strip. The one
 *  rule for "this width can hold a tab", read by the chat viewport and by whatever offers a tab to be opened. */
export const TAB_LAYOUT_MIN_WIDTH = 1024

export function isTabLayoutWidth(width: number): boolean {
  return width >= TAB_LAYOUT_MIN_WIDTH
}

/** Whether the window can hold a tab right now (follows resizes). No `window` (SSR) reads as wide. */
export function useCanHoldTab(): boolean {
  const read = () => typeof window === 'undefined' || isTabLayoutWidth(window.innerWidth)
  const [can, setCan] = useState(read)
  useEffect(() => {
    const update = () => setCan(read())
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return can
}
