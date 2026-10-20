import type { EngineRunOpts } from "../shared/types.js";

/**
 * What a remote chat is told about where it is. The context built for every employee
 * names the gateway's own home as the working directory, and on another machine that
 * path is not there: a model that believes it creates it, and writes its files there.
 */
export function remoteLocationNote(remoteCwd: string): string {
  return `**Where you run:** this session runs on a different machine from the gateway, and your working directory is \`${remoteCwd}\`. `
    + "The gateway's instance home, and any path under it named above, does not exist on this machine: keep your files under your working directory.";
}

/** The message the CLI is sent: Freebuff has no system-prompt flag, so a new chat's context goes in front of the first message. */
export function composeFreebuffMessage(
  opts: Pick<EngineRunOpts, "prompt" | "systemPrompt" | "resumeSessionId" | "platformContextRefresh" | "attachments">,
  remoteCwd?: string,
): string {
  const body = opts.attachments?.length
    ? `${opts.prompt}\n\nAttached files:\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`
    : opts.prompt;
  const context = opts.resumeSessionId ? opts.platformContextRefresh : opts.systemPrompt;
  if (!context) return body;
  return `${context}${remoteCwd ? `\n\n${remoteLocationNote(remoteCwd)}` : ""}\n\n---\n\n${body}`;
}
