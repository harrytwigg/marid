export interface StreamedBlockForPersistence {
  id?: string;
  role?: string;
  content: string;
  toolCall?: string;
  media?: unknown[];
  blocks?: Array<{ type: string; payload?: { kind?: unknown } }>;
}

export function shouldPreserveStreamedBlocks(args: {
  quietPreempted: boolean;
  streamedBlocks: StreamedBlockForPersistence[];
}): boolean {
  return !args.quietPreempted && args.streamedBlocks.length > 0;
}

export function completedStreamedBlockIds(args: {
  quietPreempted: boolean;
  rateLimited: boolean;
  result: string | null | undefined;
  error: string | null | undefined;
  streamedBlocks: StreamedBlockForPersistence[];
}): Set<string> {
  const hasTerminalResponse = Boolean(args.result?.trim() || args.error?.trim());
  if (!hasTerminalResponse || args.rateLimited || !shouldPreserveStreamedBlocks(args)) {
    // A turn cut off (by a stop or a newer message), refused by a usage limit,
    // or ending without an answer keeps none of its prose. A tool call that
    // already ran is a fact about the session whatever happened to the turn:
    // dropping it would make the transcript read as if it never happened.
    return new Set(args.streamedBlocks.flatMap((message) =>
      message.id && isCompletedToolRow(message) ? [message.id] : []));
  }

  const exactResult = args.result?.trim() ?? "";
  return new Set(args.streamedBlocks.flatMap((message) => {
    if (!message.id) return [];
    const durableBlock = message.blocks?.some((block) =>
      block.type === "delegation" || block.type === "dispatch" || block.payload?.kind === "native-agents",
    );
    const plainInterimProse =
      (message.role === undefined || message.role === "assistant")
      && !message.blocks?.length
      && Boolean(message.content.trim())
      && (!exactResult || message.content.trim() !== exactResult);
    const preserve =
      message.role === "user"
      || message.role === "notification"
      || Boolean(message.media?.length)
      || Boolean(message.toolCall)
      || durableBlock
      || plainInterimProse;
    return preserve ? [message.id] : [];
  }));
}

/** A tool row whose result arrived: the writer settles it to "Used <tool>". */
function isCompletedToolRow(message: StreamedBlockForPersistence): boolean {
  return Boolean(message.toolCall) && message.content.startsWith("Used ");
}
