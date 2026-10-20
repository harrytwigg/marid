import path from "node:path";
import type { RemoteTarget } from "../shared/types.js";
import { sshDestination } from "../shared/remote-target.js";
import {
  chatFileRelPath,
  type FreebuffChatListing,
  type FreebuffChatMeta,
  type FreebuffChatRef,
  type FreebuffChatSource,
} from "./freebuff-chat.js";
import { readRemoteSessionFile } from "./remote-file-read.js";
import { SSH_CONNECTION_FAILED, sshRun } from "./remote-stage.js";

/**
 * The remote halves of the Freebuff engine: what its PTY does not tell the
 * gateway, asked of the host the employee runs on over the same key-only ssh
 * control channel the other remote engines use. Nothing here needs anything of
 * the gateway's on that host.
 */

/** Where Freebuff keeps its config on a host, as the remote shell sees it. */
const CONFIG_DIR_SH = '"$HOME/.config/manicode"';

/** Lists every chat directory with its meta on one line: `project<TAB>chatId<TAB>{meta}`. */
export const REMOTE_CHAT_LIST_SCRIPT = `
d=${CONFIG_DIR_SH}/projects
[ -d "$d" ] || exit 0
for c in "$d"/*/chats/*/; do
  [ -d "$c" ] || continue
  chat=$(basename "$c")
  proj=$(basename "$(dirname "$(dirname "$c")")")
  printf '%s\\t%s\\t' "$proj" "$chat"
  if [ -f "$c/chat-meta.json" ]; then tr -d '\\n\\r' < "$c/chat-meta.json"; fi
  printf '\\n'
done
`;

/** A chat's meta as the listing carries it; one cut off mid-write is "not there yet". */
function parseMeta(json: string): FreebuffChatMeta | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FreebuffChatMeta) : undefined;
  } catch {
    return undefined;
  }
}

/** The listing the script prints, parsed. A line that is not that shape is skipped. */
export function parseRemoteChatListing(stdout: string): FreebuffChatListing[] {
  const out: FreebuffChatListing[] = [];
  for (const line of stdout.split("\n")) {
    const [project, chatId, ...rest] = line.split("\t");
    if (!project || !chatId) continue;
    const meta = parseMeta(rest.join("\t").trim());
    out.push({ project, chatId, ...(meta ? { meta } : {}) });
  }
  return out;
}

/** The biggest chat file a turn will pull over ssh: they hold the whole run state and grow with every turn. */
const MAX_CHAT_FILE_BYTES = 512 * 1024 * 1024;

export function remoteChatSource(target: RemoteTarget & { remoteHost: string }, sessionId: string): FreebuffChatSource {
  const destination = sshDestination(target);
  return {
    async list() {
      const res = await sshRun(destination, ["sh -s"], { stdin: REMOTE_CHAT_LIST_SCRIPT });
      if (res.code !== 0) {
        throw new Error(`could not list Freebuff chats on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
      }
      return parseRemoteChatListing(res.stdout);
    },
    async readMessages(chat: FreebuffChatRef) {
      const read = await readRemoteSessionFile({
        target,
        sessionId,
        engine: "freebuff",
        requestedPath: path.posix.join("~/.config/manicode", chatFileRelPath(chat, "chat-messages.json")),
        op: "read",
        maxBytes: MAX_CHAT_FILE_BYTES,
      });
      if (!read.ok) {
        // A chat whose file is not written yet is "not there"; anything else is a fault to report.
        if (read.status === 404) return undefined;
        throw new Error(read.error);
      }
      try {
        return JSON.parse(read.buffer?.toString("utf-8") ?? "");
      } catch {
        return undefined;
      }
    },
  };
}

/** Whether Freebuff has credentials on the host. A missing file means the first message opens a browser login nobody can finish. */
export async function remoteSignedIn(destination: string): Promise<boolean | undefined> {
  const res = await sshRun(destination, [`test -s ${CONFIG_DIR_SH}/credentials.json`]);
  if (res.code === SSH_CONNECTION_FAILED || res.code === null) return undefined;
  return res.code === 0;
}
