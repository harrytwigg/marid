// The removed-ui-library rule, in its own module so check-footguns.mjs does not grow.

/** A quoted package specifier (an import, a require, a dynamic import, a dependency key) naming a removed library. */
export const REMOVED_UI_LIBRARY_PATTERN = /["'`](?:radix-ui|@radix-ui\/[\w.-]+|lucide-react|cmdk)(?:\/[^"'`]*)?["'`]/

export const REMOVED_UI_LIBRARY = {
  name: "removed-ui-library",
  message:
    "an import of radix-ui, @radix-ui/*, lucide-react or cmdk in the web app — each was replaced (HeroUI and React Aria behind src/components/ui, Phosphor behind @/components/ui/icon, a native Slot and ScrollArea) and each one that comes back pulls a second primitive stack into the bundle",
  fix: "Import the component from src/components/ui (dialog, dropdown-menu, select, popover, tooltip, slot, scroll-area…) and the icon from \"@/components/ui/icon\". A name that adapter lacks is added to the adapter, or to scripts/icon-map.mjs for an icon, not imported from the library.",
  scans: (relPath) => relPath.startsWith("packages/web/") && /\.(?:tsx?|jsx?|mjs|cjs|json)$/.test(relPath),
  find: (text) => {
    const found = []
    text.split("\n").forEach((line, index) => {
      if (REMOVED_UI_LIBRARY_PATTERN.test(line)) found.push(index + 1)
    })
    return found
  },
}
