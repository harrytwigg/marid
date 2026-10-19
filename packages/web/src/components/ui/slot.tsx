import * as React from "react"

/**
 * `asChild` for the ui adapters: a component that draws no element of its own and hands its props to its one child.
 * Props are merged the way Radix's `Slot` merged them, so a trigger that is wrapped around a caller's own button
 * keeps both sides' behaviour:
 *  - `className` is joined (slot first), `style` is merged (the child's declarations win);
 *  - a handler (`onX`) on both runs the child's first, then the slot's; on only one it is used as it is;
 *  - `ref`s are composed;
 *  - any other prop the child sets wins over the slot's.
 */

type Props = Record<string, unknown>

function setRef<T>(ref: React.Ref<T> | undefined, node: T | null): void | (() => void) {
  if (typeof ref === "function") return ref(node)
  if (ref) (ref as React.RefObject<T | null>).current = node
}

/** One ref callback that fills every ref given, and clears them as React unmounts it (React 19 cleanups). */
function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node) => {
    const cleanups = refs.map((ref) => setRef(ref, node))
    return () => {
      cleanups.forEach((cleanup, index) => (typeof cleanup === "function" ? cleanup() : setRef(refs[index], null)))
    }
  }
}

function mergeProps(slotProps: Props, childProps: Props): Props {
  const merged: Props = { ...childProps }
  for (const name of Object.keys(childProps)) {
    const slotValue = slotProps[name]
    const childValue = childProps[name]
    if (/^on[A-Z]/.test(name)) {
      if (typeof slotValue === "function" && typeof childValue === "function") {
        merged[name] = (...args: unknown[]) => {
          const result = childValue(...args)
          slotValue(...args)
          return result
        }
      } else if (slotValue) {
        merged[name] = slotValue
      }
    } else if (name === "style") {
      merged[name] = { ...(slotValue as object | undefined), ...(childValue as object | undefined) }
    } else if (name === "className") {
      merged[name] = [slotValue, childValue].filter(Boolean).join(" ")
    }
  }
  return { ...slotProps, ...merged }
}

export function Slot({ children, ref, ...slotProps }: React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement>; children?: React.ReactNode }) {
  if (React.isValidElement<Props & { ref?: React.Ref<HTMLElement> }>(children)) {
    const childRef = children.props.ref
    return React.cloneElement(children, { ...mergeProps(slotProps, children.props), ref: ref && childRef ? composeRefs(ref, childRef) : (ref ?? childRef) })
  }
  // Like Radix: one child that is not an element (text, nothing) draws nothing; several are a mistake.
  return React.Children.count(children) > 1 ? React.Children.only(null) : null
}
