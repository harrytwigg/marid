import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { loadPlugin } from "../plugins/discovery.js";
import { isPluginEnabled } from "../plugins/enablement.js";
import { readPluginEvents, subscribePluginEvents, type PluginEventPage } from "../plugins/event-log.js";
import { PLUGIN_ID_PATTERN } from "../plugins/manifest.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { trackHeartbeat } from "./ws-heartbeat.js";

/**
 * The socket half of `/api/plugins/<id>/events`: a replay from the client's
 * cursor, then live appends.
 *
 * There is no authentication in this file, and there must never be. The path is
 * under `/api/`, so `authRequiredForRequest` (auth.ts) returns true for it and
 * the gateway's one upgrade gate (server.ts) has already authenticated the
 * caller, and refused a browser on any origin but the gateway's own, before
 * anything here runs — exactly as it does for `/ws`. A second, bespoke check
 * here would be a second policy to keep in step with the first.
 */

const EVENTS_PATH = /^\/api\/plugins\/([^/]+)\/events$/;

/** The plugin id this upgrade path names, or null when it is not ours. */
export function matchPluginEventsPath(pathname: string): string | null {
  const match = EVENTS_PATH.exec(pathname);
  if (!match || !PLUGIN_ID_PATTERN.test(match[1])) return null;
  return match[1];
}

/** `?since=` as a cursor, or undefined when it is absent or not one — the same
 *  reading as the polling route's, so a client can move between them. */
function sinceFrom(url: string | undefined): number | undefined {
  const query = url?.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const raw = new URLSearchParams(query).get("since");
  if (raw === null) return undefined;
  const since = Number(raw);
  return Number.isSafeInteger(since) && since >= 0 ? since : undefined;
}

function attachPluginEventsSocket(ws: WebSocket, id: string, since: number | undefined): void {
  const send = (page: PluginEventPage) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(page));
    } catch {
      // The socket closed between the readyState check and the send. Nothing to
      // do about it here, and nothing that should reach the emitting plugin.
    }
  };

  // Replay and subscribe in one synchronous step. Nothing can append between
  // them, so the client sees every event exactly once and in order without the
  // socket having to deduplicate against the replay.
  send(readPluginEvents(id, since));
  const unsubscribe = subscribePluginEvents(id, (record) => {
    send({ events: [record], cursor: record.cursor, dropped: false });
  });

  ws.on("close", unsubscribe);
  ws.on("error", unsubscribe);
}

export interface PluginEventsChannel {
  /** Its own server, kept out of the `/ws` broadcast set: these sockets carry one
   *  plugin's events and nothing else. The gateway that made it owns closing it. */
  wss: WebSocketServer;
  /**
   * Upgrade one events socket, after the gateway's auth gate has passed.
   *
   * The enable gate is the one the rest of the plugin API uses, and it answers a
   * disabled plugin and an unknown id identically: the socket is destroyed,
   * which is what an unmatched upgrade path already gets.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, id: string): void;
}

/** One gateway's events channel. Owned per gateway rather than per module so an
 *  in-process restart does not inherit a closed server from the last one. */
export function createPluginEventsChannel(getConfig: () => Pick<JinnConfig, "plugins">): PluginEventsChannel {
  const wss = new WebSocketServer({ noServer: true });
  return {
    wss,
    handleUpgrade(req, socket, head, id) {
      void (async () => {
        const plugin = isPluginEnabled(id, getConfig()) ? await loadPlugin(id) : null;
        if (plugin?.status !== "loaded") {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          trackHeartbeat(ws);
          attachPluginEventsSocket(ws, id, sinceFrom(req.url));
        });
      })().catch((err) => {
        logger.error(`Plugin events upgrade failed: ${err instanceof Error ? err.message : err}`);
        socket.destroy();
      });
    },
  };
}
