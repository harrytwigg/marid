import { CODENAME } from "@hundredfold/codename"

/**
 * The codename, as the browser sees it: the same word the gateway builds its names from
 * (`@hundredfold/codename` is the gateway's own one-line constant). A browser holds state under the
 * codename it was last used with, and the gateway it talks to may be an older build, so every
 * name here has a legacy spelling to read as well as the current one to write.
 */

export { CODENAME }

/** The name every browser that used an earlier build holds its state under. Never changes. */
export const LEGACY_CODENAME = "jinn" // rename:keep

/** Whether this build's name differs from the legacy one, so legacy spellings exist. */
export function isRenamed(codename: string = CODENAME): boolean {
  return codename !== LEGACY_CODENAME
}

/** `X-Hundredfold-Config-Revision` for the suffix `config-revision`: a request header this build sends. */
export function requestHeaderName(suffix: string, codename: string = CODENAME): string {
  return ["X", codename.charAt(0).toUpperCase() + codename.slice(1), ...suffix.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1))].join("-")
}

/** Every spelling of a response header a page may find, the current one first. */
export function responseHeaderNames(suffix: string, codename: string = CODENAME): string[] {
  const current = requestHeaderName(suffix, codename)
  const legacy = requestHeaderName(suffix, LEGACY_CODENAME)
  return current === legacy ? [current] : [current, legacy]
}

/** The first of a response's headers that carries a value, under either spelling. */
export function readResponseHeader(headers: Pick<Headers, "get">, suffix: string, codename: string = CODENAME): string | null {
  for (const name of responseHeaderNames(suffix, codename)) {
    const value = headers.get(name)
    if (value !== null) return value
  }
  return null
}

/** The URL-fragment keys the CLI launches the browser with (`hundredfold-bootstrap`, `hundredfold-pair`), current first. */
export function hashKeyNames(suffix: string, codename: string = CODENAME): string[] {
  const current = `${codename}-${suffix}`
  const legacy = `${LEGACY_CODENAME}-${suffix}`
  return current === legacy ? [current] : [current, legacy]
}

/** The npm scope the public plugin SDK is published under. It is the organisation's, not the codename's. */
export const PLUGIN_SDK_SCOPE = "hundredfold"

/** The specifiers a plugin may import the SDK by: the current package name and the legacy one third parties wrote. */
export function pluginSdkSpecifiers(scope: string = PLUGIN_SDK_SCOPE): string[] {
  const current = `@${scope}/plugin-sdk`
  const legacy = `@${LEGACY_CODENAME}/plugin-sdk`
  return current === legacy ? [current] : [current, legacy]
}
