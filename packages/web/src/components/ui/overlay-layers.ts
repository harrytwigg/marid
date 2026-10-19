/**
 * Where everything that floats above the page sits. Read this before giving a
 * new overlay a z-index; `overlay-layers.test.ts` fails when a layer from 60 up
 * is used in `src` and missing from the table.
 *
 *   z-index | what                                               | made by
 *   --------|----------------------------------------------------|----------------
 *   100000  | tooltip, popover, hover card, select lists,        | React Aria, set
 *           | dropdown and context menus (and their submenus), | inline, portalled
 *           | and the dismiss underlay of a modal popover or    | to the end of body
 *           | select                                             |
 *   200     | the chat header's menu (inside the header's own    | route class
 *           | stacking context, so it only has to beat siblings) |
 *   130     | the Todo page's toast                              | route class
 *   120     | the Todo pickers, a phone sheet over other sheets  | route class
 *   110     | the talk orb's overlay                             | talk-orb.tsx
 *   100     | media preview, thread peek, phone sheets           | route classes
 *   90      | the talk situation sheet                           | situation-sheet.tsx
 *   80      | the talk undo strip                                | undo-strip.tsx
 *   70      | notices (the app's and plugins')                   | notices.tsx
 *   60      | the Whisper download modal                         | whisper-download-modal.tsx
 *   50      | modal dialogs, sheets and the lightbox, with their | dialog-popup.tsx
 *           | scrim (React Aria's modal: the search overlay is   |
 *           | one), fixed widgets, the board's toasts            |
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
 *   - A modal stays at 50, below the layers that must show over a dialog (a toast, the orb), and every
 *     React Aria overlay opened inside it portals to the body at 100000 and so sits above it; a second modal
 *     opened over a first (a picker sheet over the new-Todo dialog) sits above it by DOM order, or by its own
 *     class where another sheet is in the way (120).
 *   - A fixed layer that must show above a dialog and below the orb sits
 *     between 51 and 109.
 */
export const REACT_ARIA_OVERLAY_Z_INDEX = 100000
