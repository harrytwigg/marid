import { parseDocument, Scalar, YAMLMap, isScalar } from "yaml"
import { NAMES, nameAliases, type Names } from "../shared/codename.js"

/** The `config.yaml` key the version marker lives under: the codename, in whichever spelling the file already uses. */
export function versionMarkerKey(doc: { has(key: string): boolean }, names: Names = NAMES): string {
  const aliases = nameAliases((n) => n.codename, names)
  return aliases.find((key) => doc.has(key)) ?? aliases[0]
}

export type StampResult = { ok: true; text: string } | { ok: false; reason: string }

type Document = ReturnType<typeof parseDocument>
type Commented = { comment?: string | null; commentBefore?: string | null }

const firstLine = (message: string) => message.split("\n")[0].trim()

/** The marker sits in a file the operator owns and comments freely, so anything they
 *  wrote around the node being replaced has to survive the edit. */
function carryComments(from: unknown, to: Scalar | YAMLMap): void {
  const source = from as Commented | null | undefined
  if (source?.comment != null) to.comment = source.comment
  if (source?.commentBefore != null) to.commentBefore = source.commentBefore
}

/** A bare `jinn:` parses as a null scalar, and setIn would then refuse the path. */
function ensureJinnMapping(doc: Document, key: string): void {
  const jinnNode = doc.get(key, true)
  if (!isScalar(jinnNode) || jinnNode.value != null) return
  const map = new YAMLMap()
  carryComments(jinnNode, map)
  doc.set(key, map)
}

function versionNode(previous: unknown, version: string): Scalar {
  const node = new Scalar(version)
  node.type = Scalar.QUOTE_DOUBLE
  if (isScalar(previous)) carryComments(previous, node)
  return node
}

export function stampVersionInYaml(raw: string, version: string): StampResult {
  const doc = parseDocument(raw)
  if (doc.errors.length) return { ok: false, reason: `config.yaml isn't valid YAML (${firstLine(doc.errors[0].message)})` }
  const key = versionMarkerKey(doc)
  const previous = doc.getIn([key, "version"], true)
  ensureJinnMapping(doc, key)
  try { doc.setIn([key, "version"], versionNode(previous, version)) } catch (error) {
    return { ok: false, reason: `config.yaml's "${key}" isn't a mapping (${firstLine((error as Error).message)})` }
  }
  let text: string
  try { text = doc.toString() } catch (error) {
    return { ok: false, reason: `couldn't serialize the version update safely (${firstLine((error as Error).message)})` }
  }
  const check = parseDocument(text)
  if (check.errors.length || check.getIn([key, "version"]) !== version) return { ok: false, reason: "version marker didn't round-trip" }
  return { ok: true, text }
}
