import type { ReactNode } from "react"
import { RouterProvider } from "react-aria-components"
import { useHref, useNavigate, type NavigateOptions } from "react-router-dom"

declare module "react-aria-components" {
  interface RouterConfig {
    routerOptions: NavigateOptions
  }
}

/**
 * Hands React Router's `navigate` to React Aria, so a HeroUI link, tab or menu
 * item that carries an `href` changes the route in place instead of reloading
 * the page. HeroUI needs no provider of its own; this is the one it relies on.
 * It belongs inside the router, above everything that renders such a control.
 */
export function AriaRouter({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      {children}
    </RouterProvider>
  )
}
