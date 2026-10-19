import { beforeAll } from "vitest"
import { preloadMenuPopup } from "@/components/ui/menu-root"

/* The menus load their React Aria half the first time one opens, which a test
 * would have to await at every open. Import this from a test file that opens a
 * menu and it is loaded once up front, so a menu opens synchronously. A file
 * that checks the load itself (menu-root.test.tsx) leaves it out. */
beforeAll(async () => {
  await preloadMenuPopup()
})
