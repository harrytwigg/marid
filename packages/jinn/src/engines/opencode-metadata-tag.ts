import { NAMES, nameAliases } from "../shared/codename.js";

/**
 * Every text part the gateway posts to an opencode server carries a metadata tag under the codename
 * (`{ jinn: "prompt" }`), and opencode keeps it with the stored message. A conversation that began
 * under an earlier codename still holds the earlier key, so a reader tries each, and a writer
 * uses the current one.
 */

/** The tag object for `kind`, under the current codename. */
export function metadataTag<K extends string>(kind: K): { readonly [name: string]: K } {
  return { [NAMES.codename]: kind };
}

/** The tag a part's metadata carries, under either codename; undefined when it carries none. */
export function readMetadataTag(metadata: Record<string, unknown> | undefined): unknown {
  for (const key of nameAliases((n) => n.codename)) {
    if (metadata?.[key] !== undefined) return metadata[key];
  }
  return undefined;
}
