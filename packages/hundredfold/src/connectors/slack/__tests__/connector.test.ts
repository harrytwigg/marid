import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Target } from "../../../shared/types.js";

// Mock @slack/bolt before importing connector. Only `chat.postMessage` is reached
// by the constructor and the send/reply paths under test.
const mockPostMessage = vi.fn().mockResolvedValue({ ts: "1.1" });

vi.mock("@slack/bolt", () => ({
  App: vi.fn(function (this: any) {
    this.client = { chat: { postMessage: mockPostMessage } };
  }),
}));

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Import after mocks are set up
const { SlackConnector } = await import("../index.js");

const target: Target = { channel: "C1", thread: "9.9", messageTs: "9.9", replyContext: {} };

describe("SlackConnector delivery outcome", () => {
  let connector: InstanceType<typeof SlackConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({ ts: "1.1" });
    connector = new SlackConnector({ appToken: "xapp-test", botToken: "xoxb-test" });
  });

  it("rejects and reports unhealthy when sendMessage fails", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("channel_not_found"));
    await expect(connector.sendMessage(target, "hi")).rejects.toThrow("channel_not_found");
    const health = connector.getHealth();
    expect(health.status).toBe("error");
    expect(health.detail).toContain("channel_not_found");
  });

  it("clears the error once a later send succeeds", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("rate_limited"));
    await expect(connector.sendMessage(target, "hi")).rejects.toThrow();
    expect(connector.getHealth().status).toBe("error");

    await expect(connector.sendMessage(target, "hi again")).resolves.toBe("1.1");
    const health = connector.getHealth();
    expect(health.status).not.toBe("error");
    expect(health.detail).toBeUndefined();
  });

  it("rejects and reports unhealthy when replyMessage fails", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("thread_not_found"));
    await expect(connector.replyMessage(target, "hi")).rejects.toThrow("thread_not_found");
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", thread_ts: "9.9" }));
    expect(connector.getHealth().status).toBe("error");
  });

  it("treats empty text as a no-op, not a failure", async () => {
    await expect(connector.sendMessage(target, "   ")).resolves.toBeUndefined();
    await expect(connector.replyMessage(target, "")).resolves.toBeUndefined();
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(connector.getHealth().status).not.toBe("error");
  });
});
