import { useEffect } from "react"
import { useSettings } from "@/routes/settings-provider"
import { customBrandGlyph } from "@/lib/brand"

const ICON_LINKS = "link[rel='icon']"

function restoreDeclared(link: HTMLLinkElement) {
  if (link.dataset.defaultType) link.type = link.dataset.defaultType
  else link.removeAttribute("type")
  if (link.dataset.defaultHref) link.setAttribute("href", link.dataset.defaultHref)
}

/** Points every tab icon at `href`, or back at what index.html declared. */
function setFavicon(href: string | null) {
  let links = Array.from(document.querySelectorAll<HTMLLinkElement>(ICON_LINKS))
  if (href && links.length === 0) {
    const link = document.createElement("link")
    link.rel = "icon"
    document.head.appendChild(link)
    links = [link]
  }
  for (const link of links) {
    link.dataset.defaultHref ??= link.getAttribute("href") ?? ""
    link.dataset.defaultType ??= link.getAttribute("type") ?? ""
    if (!href) {
      restoreDeclared(link)
      continue
    }
    link.type = "image/png"
    link.href = href
  }
}

function glyphDataUrl(glyph: string): string | null {
  const canvas = document.createElement("canvas")
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.font = "52px serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(glyph, 32, 36)
  return canvas.toDataURL("image/png")
}

/** The tab icon: index.html's mark by default, the operator's glyph drawn on a
 *  canvas when they set one. The default path draws nothing. */
export function BrandFavicon() {
  const { settings } = useSettings()
  const glyph = customBrandGlyph(settings)

  useEffect(() => {
    setFavicon(glyph ? glyphDataUrl(glyph) : null)
  }, [glyph])

  return null
}
