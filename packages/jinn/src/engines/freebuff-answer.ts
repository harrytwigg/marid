import { logger } from "../shared/logger.js";
import { FreebuffFailure } from "./freebuff-failure.js";
import { sleep } from "./freebuff-driver.js";
import { scrapeAnswer } from "./freebuff-scrape.js";
import {
  chatKey,
  extractAnswer,
  firstPromptMatches,
  lastUserMessage,
  locateChat,
  sameStat,
  type FreebuffChatRef,
  type MessagesStat,
} from "./freebuff-chat.js";
import type { Live } from "./freebuff-live.js";

/** The chat file may lag the screen; wait this long for the answer to be in it. */
const ANSWER_WAIT_MS = 20_000;

/**
 * Reading a turn's answer out of Freebuff's chat file. `others` are the live
 * processes besides this one, whose chats are not this one's to claim.
 */
export class AnswerReader {
  constructor(private readonly others: (live: Live) => Iterable<Live>) {}

  /** The chat this process is in, found by what was sent into it the first time. */
  async chatOf(live: Live, sent: string): Promise<FreebuffChatRef | undefined> {
    const claimed = new Set<string>();
    for (const other of this.others(live)) if (other.chat?.project) claimed.add(chatKey(other.chat));
    const chat = await locateChat(live.chats, {
      known: live.chat,
      before: live.before,
      claimed,
      sent,
      onAmbiguous: () => logger.warn("FreebuffInteractiveEngine: several new chats opened with the same words; using the newest"),
    });
    if (chat) live.chat = chat;
    return chat;
  }

  /**
   * The reply to `sent`, if the chat file already holds it complete. It must be a
   * reply to THIS message: a chat file that has not caught up still ends in the
   * previous turn's completed answer, and a message sent twice ("continue") matches
   * itself. So the file must hold more messages than the chat had when this one went
   * in, as well as end in this message's text.
   */
  private async answerFrom(live: Live, chat: FreebuffChatRef, sent: string, before: number): Promise<string | undefined> {
    const messages = await live.chats.readMessages(chat);
    if (!Array.isArray(messages) || messages.length <= before) return undefined;
    const answer = extractAnswer(messages);
    return answer && firstPromptMatches(lastUserMessage(messages), sent) ? answer.text : undefined;
  }

  /** How many messages the chat holds right now (0 for a chat that does not exist yet), from its small meta file. */
  async messageCount(live: Live): Promise<number> {
    if (!live.chat) return 0;
    try {
      const listing = await live.chats.list();
      const mine = listing.find((c) => c.chatId === live.chat?.chatId && (!live.chat.project || c.project === live.chat.project));
      return mine?.meta?.messageCount ?? 0;
    } catch {
      return 0;
    }
  }

  /** Whether the chat already holds the reply (a turn short enough to come and go between looks). */
  async answered(live: Live, sent: string, before: number): Promise<boolean> {
    try {
      const chat = await this.chatOf(live, sent);
      return chat !== undefined && (await this.answerFrom(live, chat, sent, before)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * The answer, once the screen has said the turn is over. The chat file embeds the
   * run state and is about a megabyte a turn, so it is read only when its stat shows it
   * changed since the message went in (or since the last read): one stat per poll, a
   * bounded number of polls, and the screen's own text if the file never answers.
   */
  async read(
    live: Live,
    signal: AbortSignal,
    ask: { sent: string; before: number; baseline: MessagesStat | undefined },
    lines: string[],
  ): Promise<{ answer: string; usedScreen: boolean }> {
    const deadline = Date.now() + ANSWER_WAIT_MS;
    let seen = ask.baseline;
    let lastError: unknown;
    for (;;) {
      try {
        const polled = await this.poll(live, ask, seen);
        if (polled.answer !== undefined) return { answer: polled.answer, usedScreen: false };
        seen = polled.seen;
      } catch (err) {
        lastError = err;
      }
      if (Date.now() >= deadline) break;
      await sleep(500, signal);
    }
    if (lastError) logger.warn(`FreebuffInteractiveEngine: could not read the chat file: ${lastError instanceof Error ? lastError.message : lastError}`);
    const scraped = scrapeAnswer(lines);
    if (!scraped) throw new FreebuffFailure("Freebuff finished the turn but its answer could not be read from the chat file or the screen");
    return { answer: scraped, usedScreen: true };
  }

  /** One look: a stat, and a read only if the stat says the file is not what was last seen (or cannot be had). */
  private async poll(
    live: Live,
    ask: { sent: string; before: number },
    seen: MessagesStat | undefined,
  ): Promise<{ answer?: string; seen: MessagesStat | undefined }> {
    const chat = await this.chatOf(live, ask.sent);
    if (!chat) return { seen };
    const stat = await live.chats.statMessages(chat);
    if (stat !== undefined && sameStat(stat, seen)) return { seen };
    return { answer: await this.answerFrom(live, chat, ask.sent, ask.before), seen: stat };
  }
}
