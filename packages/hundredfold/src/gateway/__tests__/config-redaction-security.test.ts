import { describe, expect, it } from "vitest";
import { isSensitiveConfigKey, sanitizeConfigForApi } from "../api.js";

describe("GET /api/config redaction", () => {
  it("recognizes common secret-bearing key names", () => {
    expect(isSensitiveConfigKey("token")).toBe(true);
    expect(isSensitiveConfigKey("botToken")).toBe(true);
    expect(isSensitiveConfigKey("api_key")).toBe(true);
    expect(isSensitiveConfigKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveConfigKey("clientSecret")).toBe(true);
    expect(isSensitiveConfigKey("private-key")).toBe(true);
    expect(isSensitiveConfigKey("model")).toBe(false);
  });

  it("recursively redacts connector, engine, MCP, and list-item secrets", () => {
    const sanitized = sanitizeConfigForApi({
      gateway: { port: 7777 },
      engines: {
        claude: { model: "opus", apiKey: "sk-claude" },
      },
      connectors: {
        slack: { botToken: "xoxb-secret", signingSecret: "signing-secret" },
      },
      mcp: {
        servers: {
          search: { env: { BRAVE_API_KEY: "brave-secret", SAFE_VALUE: "kept" } },
        },
      },
      webhooks: [{ id: "dev", token: "webhook-secret", url: "https://example.invalid/hook" }],
    });

    expect(sanitized.engines.claude.apiKey).toBe("***");
    expect(sanitized.connectors.slack.botToken).toBe("***");
    expect(sanitized.connectors.slack.signingSecret).toBe("***");
    expect(sanitized.mcp.servers.search.env.BRAVE_API_KEY).toBe("***");
    expect(sanitized.mcp.servers.search.env.SAFE_VALUE).toBe("kept");
    expect(sanitized.webhooks[0].token).toBe("***");
    expect(sanitized.webhooks[0].url).toBe("https://example.invalid/hook");
  });

  it("never sends the realtime provider key to the UI", () => {
    expect(isSensitiveConfigKey("apiKey")).toBe(true);

    const sanitized = sanitizeConfigForApi({
      realtime: { provider: "openai", model: "gpt-realtime", apiKey: "sk-realtime", voice: "marin" },
    });

    expect(sanitized.realtime.apiKey).toBe("***");
    expect(JSON.stringify(sanitized)).not.toContain("sk-realtime");
    // The rest of the block is not secret and the UI needs to render it.
    expect(sanitized.realtime.provider).toBe("openai");
    expect(sanitized.realtime.model).toBe("gpt-realtime");
    expect(sanitized.realtime.voice).toBe("marin");
  });

  it("redacts an ${ENV_VAR} realtime key reference too", () => {
    const sanitized = sanitizeConfigForApi({ realtime: { apiKey: "${OPENAI_API_KEY}" } });

    expect(sanitized.realtime.apiKey).toBe("***");
  });

  it("preserves the numeric stale-chat token threshold", () => {
    const sanitized = sanitizeConfigForApi({
      sessions: { staleChat: { tokenThreshold: 1_500 } },
    });

    expect(sanitized.sessions.staleChat.tokenThreshold).toBe(1_500);
  });
});
