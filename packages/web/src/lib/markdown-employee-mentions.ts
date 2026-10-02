import { scanMentions } from "@/lib/mentions"

/* Turning `@build-lead` in a comment into a chip is a rewrite of the tree
 * react-markdown builds, like the Todo-id one beside it: only text nodes are
 * split, and never inside code, a fenced block or a link. Only a name the
 * `isRoster` predicate accepts becomes a chip; anything else stays text, so the
 * page never highlights a mention that will not wake anyone. */

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

/** The element the split emits. MarkdownView maps it to the chip. */
export const EMPLOYEE_MENTION_TAG = "employee-mention"

const ALREADY_SPOKEN_FOR = new Set(["code", "pre", "a"])

/** rehype plugin: rewrite each `@name` in prose that names a roster employee.
 *  Used as `[rehypeEmployeeMentions, { isRoster }]`. */
export function rehypeEmployeeMentions({ isRoster }: { isRoster: (name: string) => boolean }) {
  return (tree: HastNode): void => {
    splitChildren(tree, isRoster)
  }
}

function splitChildren(node: HastNode, isRoster: (name: string) => boolean): void {
  if (node.type === "element" && ALREADY_SPOKEN_FOR.has((node as HastElement).tagName)) return
  const children = (node as { children?: HastNode[] }).children
  if (!children) return

  const rewritten: HastNode[] = []
  for (const child of children) {
    if (child.type === "text") {
      rewritten.push(...splitText((child as HastText).value, isRoster))
    } else {
      splitChildren(child, isRoster)
      rewritten.push(child)
    }
  }
  ;(node as { children: HastNode[] }).children = rewritten
}

function splitText(value: string, isRoster: (name: string) => boolean): HastNode[] {
  const parts: HastNode[] = []
  let last = 0
  for (const token of scanMentions(value)) {
    if (!isRoster(token.name)) continue
    if (token.start > last) parts.push({ type: "text", value: value.slice(last, token.start) })
    parts.push({ type: "element", tagName: EMPLOYEE_MENTION_TAG, properties: { name: token.name }, children: [] })
    last = token.end
  }
  if (parts.length === 0) return [{ type: "text", value }]
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) })
  return parts
}
