import { useEffect, useState } from 'react'
import { isTabLayoutWidth } from '@/lib/tab-layout-width'

export interface ChatViewport {
  width: number
  height: number
  mobile: boolean
}

function readViewport(): ChatViewport {
  const width = typeof window === 'undefined' ? 1440 : window.innerWidth
  const height = typeof window === 'undefined' ? 900 : window.innerHeight
  return { width, height, mobile: !isTabLayoutWidth(width) }
}

export function useChatViewport(): ChatViewport {
  const [viewport, setViewport] = useState(readViewport)

  useEffect(() => {
    const update = () => setViewport(readViewport())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return viewport
}
