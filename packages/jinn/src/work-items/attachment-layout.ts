/**
 * The content-addressed attachment layout and caps, as pure data — shared by the
 * gateway store (work-items/attachments.ts) and the MCP server, which must map a
 * listed attachment onto its own host's view of the instance home and enforce
 * the per-file cap before it uploads bytes. No db or fs imports here,
 * so the MCP process can load it without touching the registry.
 */

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_ITEM_MAX_BYTES = 200 * 1024 * 1024;

/** Instance-home subdirectory holding attachment bytes. */
export const ATTACHMENTS_SUBDIR = "attachments";

/** Where a hash's bytes live relative to the attachments dir: `<sha[0:2]>/<sha>`. */
export function attachmentRelativePath(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}
