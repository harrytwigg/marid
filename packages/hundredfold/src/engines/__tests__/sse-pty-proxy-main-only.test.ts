import { describe, it, expect } from "vitest";
import { SsePtyProxy, MAIN_AGENT_SENTINEL } from "../sse-pty-proxy.js";

// Locks the tee gate. We tee ONLY the main agent's turns to the UI, identified by a
// gateway-controlled sentinel that the gateway injects into the main agent's appended
// system prompt. Everything else is suppressed: no-tools auxiliary calls (haiku
// topic/title detection, quota checks — whose title-gen {"title":...} must not leak
// into the transcript) and Task sub-agents (which carry tools but get Claude Code's
// own system prompt, so no sentinel). We deliberately do NOT fingerprint the request
// body: the main agent's own requests don't share a stable signature, so any such
// heuristic dropped real turns and broke streaming. The sentinel is the one signal
// the gateway fully owns.

type Classification = { isAgent: boolean; teeToUi: boolean };

/** classifyRequest is private; reach it directly for a focused unit test. This
 *  is the same method production handle() calls, url included. */
function classify(proxy: SsePtyProxy, url: string, body: string): Classification {
  return (proxy as unknown as { classifyRequest(u: string | undefined, b: Buffer): Classification })
    .classifyRequest(url, Buffer.from(body));
}

function tee(proxy: SsePtyProxy, body: unknown): boolean {
  return classify(proxy, "/v1/messages", JSON.stringify(body)).teeToUi;
}

const TOOLS = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];
const newProxy = () => new SsePtyProxy("test", () => {});
const SYS = `You are the COO.\n\n${MAIN_AGENT_SENTINEL}`;

describe("SsePtyProxy.classifyRequest", () => {
  it("tees a tool-bearing request whose system carries the sentinel (main agent)", () => {
    const proxy = newProxy();
    // system as a plain string
    expect(tee(proxy, { system: SYS, messages: [], tools: TOOLS })).toBe(true);
    // system as a content-block array (Claude Code's usual shape)
    expect(tee(proxy, {
      system: [{ type: "text", text: "preamble" }, { type: "text", text: SYS }],
      messages: [],
      tools: TOOLS,
    })).toBe(true);
  });

  it("suppresses a tool-bearing request without the sentinel (Task sub-agent)", () => {
    const proxy = newProxy();
    expect(tee(proxy, { system: "You are a sub-agent.", messages: [], tools: TOOLS })).toBe(false);
    expect(tee(proxy, { system: [{ type: "text", text: "no marker here" }], messages: [], tools: TOOLS })).toBe(false);
  });

  it("suppresses no-tools auxiliary calls even with the sentinel (title/topic gen, quota)", () => {
    const proxy = newProxy();
    expect(tee(proxy, { system: SYS, messages: [] })).toBe(false);       // tools absent
    expect(tee(proxy, { system: SYS, messages: [], tools: [] })).toBe(false); // tools empty
  });

  it("suppresses non-JSON bodies (e.g. count_tokens)", () => {
    const proxy = newProxy();
    expect(classify(proxy, "/v1/messages", "not json").teeToUi).toBe(false);
  });

  it("suppresses every URL but /v1/messages, however main-agent the body looks", () => {
    const proxy = newProxy();
    const mainAgentBody = JSON.stringify({ system: SYS, messages: [], tools: TOOLS });

    expect(classify(proxy, "/v1/messages/count_tokens", mainAgentBody)).toEqual({ isAgent: false, teeToUi: false });
    expect(classify(proxy, "/v1/complete", mainAgentBody)).toEqual({ isAgent: false, teeToUi: false });
    // A query string is not part of the path, so it must not disqualify the route.
    expect(classify(proxy, "/v1/messages?beta=true", mainAgentBody)).toEqual({ isAgent: true, teeToUi: true });
  });
});
