export interface ChatGridPlacementInput {
  sessionIds: readonly string[]
  primaryPaneKey: string
  primarySessionId: string | null
  pickerPaneKey?: string | null
  mobile?: boolean
  /** The layout holds panes and no chat, and the route names none: the panes stand alone, and the
   *  route's own composer is not drawn beside them (a new chat is a pane of the layout there). */
  chatless?: boolean
}

export function deriveChatGridIds({
  sessionIds,
  primaryPaneKey,
  primarySessionId,
  pickerPaneKey,
  mobile,
  chatless,
}: ChatGridPlacementInput): string[] {
  const sessionGridIds = primarySessionId
    ? sessionIds.map((sessionId) => sessionId === primarySessionId ? primaryPaneKey : sessionId)
    : chatless
      ? [...sessionIds]
      : sessionIds.length === 1
        ? [primaryPaneKey]
        : [...sessionIds, primaryPaneKey]

  if (mobile && pickerPaneKey) return [pickerPaneKey]
  return pickerPaneKey ? [...sessionGridIds, pickerPaneKey] : sessionGridIds
}

export interface GridPoint {
  x: number
  y: number
}

export interface GridRectangle {
  left: number
  top: number
  width: number
  height: number
}

export type GridDropRegion = 'left' | 'right' | 'top' | 'bottom' | 'end'

export interface GridPlacement {
  targetIndex: number
  region: GridDropRegion
  previewRect: GridRectangle
}

interface Bounds extends GridRectangle {
  right: number
  bottom: number
}

function boundsFor(rect: GridRectangle): Bounds {
  const width = Math.max(0, rect.width)
  const height = Math.max(0, rect.height)
  return {
    left: rect.left,
    top: rect.top,
    width,
    height,
    right: rect.left + width,
    bottom: rect.top + height,
  }
}

function contains(point: GridPoint, rect: Bounds): boolean {
  return point.x >= rect.left
    && point.x < rect.right
    && point.y >= rect.top
    && point.y < rect.bottom
}

type PaneRegion = Exclude<GridDropRegion, 'end'>

function horizontalRegion(x: number): Extract<PaneRegion, 'left' | 'right'> | null {
  if (x < 0.25) return 'left'
  if (x >= 0.75) return 'right'
  return null
}

function verticalRegion(y: number): Extract<PaneRegion, 'top' | 'bottom'> | null {
  if (y < 0.25) return 'top'
  if (y >= 0.75) return 'bottom'
  return null
}

function regionForPoint(point: GridPoint, pane: Bounds): PaneRegion {
  const x = (point.x - pane.left) / pane.width
  const y = (point.y - pane.top) / pane.height
  const horizontal = horizontalRegion(x)
  const vertical = verticalRegion(y)

  if (horizontal && vertical) {
    const horizontalDistance = horizontal === 'left' ? x : 1 - x
    const verticalDistance = vertical === 'top' ? y : 1 - y
    return horizontalDistance <= verticalDistance ? horizontal : vertical
  }
  if (horizontal) return horizontal
  if (vertical) return vertical
  return x < 0.5 ? 'left' : 'right'
}

function previewForRegion(pane: Bounds, region: PaneRegion): GridRectangle {
  if (region === 'left') {
    return { left: pane.left, top: pane.top, width: pane.width / 2, height: pane.height }
  }
  if (region === 'right') {
    return { left: pane.left + pane.width / 2, top: pane.top, width: pane.width / 2, height: pane.height }
  }
  if (region === 'top') {
    return { left: pane.left, top: pane.top, width: pane.width, height: pane.height / 2 }
  }
  return { left: pane.left, top: pane.top + pane.height / 2, width: pane.width, height: pane.height / 2 }
}

export function placementForPointer(
  point: GridPoint,
  paneRects: readonly GridRectangle[],
  gridRect: GridRectangle,
): GridPlacement | null {
  const grid = boundsFor(gridRect)
  if (!contains(point, grid)) return null
  if (paneRects.length === 0) {
    return { targetIndex: 0, region: 'end', previewRect: gridRect }
  }

  for (const [index, paneRect] of paneRects.entries()) {
    const pane = boundsFor(paneRect)
    if (!contains(point, pane)) continue
    const region = regionForPoint(point, pane)
    return {
      targetIndex: region === 'left' || region === 'top' ? index : index + 1,
      region,
      previewRect: previewForRegion(pane, region),
    }
  }

  const lastPane = boundsFor(paneRects.at(-1)!)
  return {
    targetIndex: paneRects.length,
    region: 'end',
    previewRect: previewForRegion(lastPane, 'right'),
  }
}
