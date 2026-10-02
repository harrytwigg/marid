import { describe, expect, it } from "vitest";
import { extractJson, parseDecisions } from "../decisions.js";
import { lockedDownEmployee } from "../walk.js";
import type { Employee } from "../../shared/types.js";

const answer = { todos: [], dispatch: { start: [], reason: "nothing ready" }, summary: "quiet" };

describe("reading the walk's answer", () => {
  it("does not mistake the close of an earlier fence for the answer's opening", () => {
    const reply = [
      "I checked the gate with:",
      "```bash",
      "gh pr view 18 --json state",
      "```",
      "Then decided. Note the braces {like these} in prose.",
      "```json",
      JSON.stringify(answer),
      "```",
    ].join("\n");
    expect(JSON.parse(extractJson(reply)!)).toEqual(answer);
    expect(parseDecisions(reply)).toMatchObject({ ok: true, decisions: { summary: "quiet" } });
  });

  it("takes the last block that parses, and an unlabelled one when there is no json block", () => {
    const first = { ...answer, summary: "first" };
    const last = { ...answer, summary: "last" };
    expect(JSON.parse(extractJson(`\`\`\`json\n${JSON.stringify(first)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(last)}\n\`\`\``)!).summary).toBe("last");
    expect(JSON.parse(extractJson(`\`\`\`\n${JSON.stringify(last)}\n\`\`\``)!).summary).toBe("last");
    expect(JSON.parse(extractJson(`Answer: ${JSON.stringify(last)}`)!).summary).toBe("last");
  });

  it("fails rather than guessing when nothing parses", () => {
    expect(parseDecisions("```json\n{not json\n```")).toMatchObject({ ok: false });
    expect(parseDecisions("no answer at all")).toEqual({ ok: false, error: "the reply carried no JSON object" });
    expect(parseDecisions(JSON.stringify({ todos: [] }))).toMatchObject({ ok: false, error: expect.stringContaining("dispatch.reason") });
  });
});

describe("the walk's turn has no tools", () => {
  it("runs as the employee on Claude, on the gateway, with no MCP, no built-in tools and none of its own flags", () => {
    const employee = {
      name: "assistant", engine: "opencode", model: "x", cliFlags: ["--agent", "build"], mcp: true,
      remoteHost: "box", remoteUser: "u", remoteCwd: "/w",
    } as unknown as Employee;
    expect(lockedDownEmployee(employee, "sonnet")).toEqual({
      name: "assistant", engine: "claude", model: "sonnet", mcp: false, jinnMcp: false,
      cliFlags: ["--no-chrome", "--tools", "", "--strict-mcp-config"],
    });
    const onClaude = { name: "assistant", engine: "claude", model: "opus", cliFlags: ["--chrome"] } as unknown as Employee;
    expect(lockedDownEmployee(onClaude, "sonnet")).toMatchObject({ engine: "claude", model: "opus", cliFlags: ["--no-chrome", "--tools", "", "--strict-mcp-config"] });
  });
});
