import { TODO_ID_MENTION_SOURCE } from "@/lib/todo-id"

/* Turning `ISS-741` in a Todo body into a mention is a text-level rewrite, so it
 * happens on the tree react-markdown builds rather than in a component override:
 * only text nodes are split, and only outside the three places where the id is
 * already spoken for — inline code, a fenced block, and an existing link.
 * The hast types live in a package the web app does not depend on, so the two
 * node shapes this walk touches are declared here instead. */

interface HastText {
  type: "text"
  value: string
}

interface HastElement {
  type: "element"
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }

/** The element the split emits. MarkdownView maps it to the shared mention. */
export const TODO_MENTION_TAG = "todo-mention"

const ALREADY_SPOKEN_FOR = new Set(["code", "pre", "a"])

/** rehype plugin: rewrite every bare Todo id in prose into a mention element. */
export function rehypeTodoMentions() {
  return (tree: HastNode): void => {
    splitChildren(tree)
  }
}

function splitChildren(node: HastNode): void {
  if (node.type === "element" && ALREADY_SPOKEN_FOR.has((node as HastElement).tagName)) return
  const children = (node as { children?: HastNode[] }).children
  if (!children) return

  const rewritten: HastNode[] = []
  for (const child of children) {
    if (child.type === "text") {
      rewritten.push(...splitText((child as HastText).value))
    } else {
      splitChildren(child)
      rewritten.push(child)
    }
  }
  ;(node as { children: HastNode[] }).children = rewritten
}

function splitText(value: string): HastNode[] {
  // Own `lastIndex` per call: the walk is recursive and shares no regex state.
  const mentions = new RegExp(TODO_ID_MENTION_SOURCE, "g")
  const parts: HastNode[] = []
  let last = 0

  for (let match = mentions.exec(value); match; match = mentions.exec(value)) {
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) })
    parts.push({
      type: "element",
      tagName: TODO_MENTION_TAG,
      properties: { id: match[0] },
      children: [],
    })
    last = match.index + match[0].length
  }

  if (parts.length === 0) return [{ type: "text", value }]
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) })
  return parts
}
