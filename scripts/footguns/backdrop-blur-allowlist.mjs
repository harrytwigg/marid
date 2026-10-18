// Where a raw backdrop filter may still live. The glass token file owns the
// material: a surface blurs through .glass-float, .glass-float-bar or the
// composer rules there, so the radius, the pointer fallback and reduced
// transparency are decided once. Everything below predates that and has not been
// moved yet; each entry says what it is, so the pass that migrates it knows it
// is due. Delete the entry when the file stops using a raw filter (the test
// fails on a stale one).
export const GLASS_TOKEN_FILE = "packages/web/src/routes/glass-identity.css"

const MENU = "menu or popover over the page; moves to the overlay primitives"
const TOAST = "toast over the page; moves to the overlay primitives"
const DIALOG = "dialog or sheet with a scrim; moves to the overlay primitives"

/** @type {ReadonlyMap<string, string>} */
export const BACKDROP_BLUR_ALLOWLIST = new Map([
  ["packages/web/src/components/activity/log-browser.tsx", "sticky filter bar in the activity screen; moves with that screen's pass"],
  ["packages/web/src/components/chat/cli-keybar.tsx", "popover over the terminal key bar; moves to the overlay primitives"],
  ["packages/web/src/components/chat/file-view.tsx", "controls floating over a file viewer; moves with the chat screen's pass"],
  ["packages/web/src/components/chat/shortcut-overlay.tsx", "floating shortcut card; moves to the overlay primitives"],
  ["packages/web/src/components/chat/thread-peek.tsx", DIALOG],
  ["packages/web/src/components/global-search.tsx", DIALOG],
  ["packages/web/src/components/live-stream-widget.tsx", "floating widget pinned over every page; moves with the overlay primitives"],
  ["packages/web/src/components/onboarding-wizard.tsx", DIALOG],
  ["packages/web/src/components/org/employee-node.tsx", "org map node card; moves with the org screen's pass"],
  ["packages/web/src/components/talk/media-preview-chrome.tsx", "controls floating over a media preview; moves with the voice screen's pass"],
  ["packages/web/src/components/talk/media-preview.tsx", DIALOG],
  ["packages/web/src/components/talk/situation-sheet.tsx", DIALOG],
  ["packages/web/src/components/talk/undo-strip.tsx", TOAST],
  ["packages/web/src/components/todo-glance.tsx", "hover card; moves to the overlay primitives"],
  ["packages/web/src/components/ui/emoji-picker.tsx", MENU],
  ["packages/web/src/components/ui/file-drop-overlay.tsx", "full-pane drop overlay; moves to the overlay primitives"],
  ["packages/web/src/components/ui/image-lightbox.tsx", DIALOG],
  ["packages/web/src/components/ui/popover.tsx", MENU],
  ["packages/web/src/components/ui/select.tsx", MENU],
  ["packages/web/src/components/ui/tooltip.tsx", "tooltip; moves to the overlay primitives"],
  ["packages/web/src/components/ui/video-player.tsx", "controls over a video; moves to the overlay primitives"],
  ["packages/web/src/plugins/sdk/plugin-notices.tsx", TOAST],
  ["packages/web/src/routes/chat/chat-header-menu.tsx", MENU],
  ["packages/web/src/routes/logs/page.tsx", "floating bar on the logs screen; moves with that screen's pass"],
  ["packages/web/src/routes/redesign/page.tsx", "self-contained design experiment with its own stylesheet"],
  ["packages/web/src/routes/todos/board/board-page.tsx", TOAST],
  ["packages/web/src/routes/todos/needs-you-view.tsx", "toast on the Todos screen; moves to the overlay primitives"],
  ["packages/web/src/routes/todos/pickers/picker-shell.tsx", MENU],
  ["packages/web/src/routes/todos/task-page/attachment-preview.tsx", "controls over an attachment preview; moves with the Todo page's pass"],
  ["packages/web/src/routes/todos/task-page/attachments.tsx", "button over an attachment thumbnail; moves with the Todo page's pass"],
  ["packages/web/src/routes/todos/task-page/task-page.tsx", TOAST],
])
