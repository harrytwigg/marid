/**
 * Where everything that floats above the page sits. Read this before giving a
 * new overlay a z-index; `overlay-layers.test.ts` fails when a layer from 60 up
 * is used in `src` and missing from the table.
 *
 *   z-index | what                                               | made by
 *   --------|----------------------------------------------------|----------------
 *   100000  | tooltip, popover, hover card, and the dismiss      | React Aria, set
 *           | underlay of a modal popover                        | inline, portalled
 *           |                                                    | to the end of body
 *   200     | the chat header's menu (inside the header's own    | route class
 *           | stacking context, so it only has to beat siblings) |
 *   130     | the Todo page's toast                              | route class
 *   120     | the Todo pickers, a phone sheet over other sheets  | route class
 *   110     | the talk orb's overlay                             | talk-orb.tsx
 *   100     | media preview, thread peek, phone sheets           | route classes
 *   90      | the talk situation sheet                           | situation-sheet.tsx
 *   80      | the talk undo strip                                | undo-strip.tsx
 *   70      | plugin notices                                     | plugin-notices.tsx
 *   60      | the Whisper download modal                         | whisper-download-modal.tsx
 *   50      | Radix overlays (the dialog and its scrim, which    | components/ui
 *           | the search overlay is, plus menus and selects),    |
 *           | fixed widgets, the board's toasts                  |
 *   10-40   | chrome: the nav rail (30), tab bar and fixed       | layout classes
 *           | save bars (40), sticky headers                     |
 *
 * What follows from it:
 *   - React Aria's layer is above every first-party layer by construction, so a
 *     tooltip or popover is never hidden by a sheet, the orb, the search overlay
 *     or a toast. Do not restyle it with a z-index of your own: React Aria sets
 *     it inline.
 *   - Opening one while another is open is safe: a popover is modal and a press
 *     outside closes it first; a tooltip and a hover card are non-modal, short
 *     lived, and close on Escape and blur.
 *   - Radix overlays stay at 50 until their slices (dialog, menu, select) move
 *     to React Aria, which then puts them in the 100000 layer too.
 *   - A fixed layer that must show above a dialog and below the orb sits
 *     between 51 and 109.
 */
export const REACT_ARIA_OVERLAY_Z_INDEX = 100000
