import { migrateLegacyBrowserState } from "./legacy-storage"

// A side-effect module, imported first by the app's entry: modules evaluate in import order, so the
// keys an earlier build wrote are already under their current names when anything reads storage.
migrateLegacyBrowserState()
