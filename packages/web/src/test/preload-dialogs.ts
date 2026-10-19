import { beforeAll } from "vitest"
import { preloadDialogPopup } from "@/components/ui/dialog"

/* The dialogs load their React Aria half the first time one opens, which a test would have to await at every
 * open. Import this from a test file that opens a dialog and it is loaded once up front, so a dialog opens
 * synchronously. A file that checks the load itself leaves it out. */
beforeAll(async () => {
  await preloadDialogPopup()
})
