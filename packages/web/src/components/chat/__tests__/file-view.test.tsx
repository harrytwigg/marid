import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/conversations";
import { FileLinkSessionContext } from "../file-link-session-context";
import { FileView } from "../file-view";
import { ChatMessages } from "../chat-messages";
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport";

vi.mock("@/routes/providers", () => ({
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("@/components/markdown-view", () => ({
  MarkdownView: ({ content }: { content: string }) => <div>{content}</div>,
  SyntaxHighlighter: ({ children }: { children: string }) => <pre>{children}</pre>,
  oneDark: {},
  oneLight: {},
}));

const fetchMock = vi.fn<typeof fetch>();
const GATEWAY_ORIGIN = "https://qa-a.example:7779";
let restoreTransport: (() => void) | null = null;

function responseFor(request: string): Response {
  const rawPath = new URL(request, "http://gateway.test").searchParams.get("path") ?? "";
  const body = new URL(request).pathname === "/api/knowledge/read"
    ? {
        path: rawPath,
        title: "Knowledge file",
        content: "knowledge body",
        truncated: false,
        totalChars: 14,
      }
    : {
        path: rawPath,
        resolvedPath: `/managed/${rawPath}`,
        mime: "text/plain",
        size: 12,
        content: "managed body",
        binary: false,
        tooLarge: false,
      };
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => responseFor(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
    origin: GATEWAY_ORIGIN,
    request: (input, init) => fetch(input, init),
    navigate: vi.fn(),
  }));
});

afterEach(() => {
  restoreTransport?.();
  restoreTransport = null;
  vi.unstubAllGlobals();
});

const supportedPaths = [
  ["knowledge/product-checklist.md", "/api/knowledge/read?path=knowledge%2Fproduct-checklist.md"],
  ["docs/company-doctrine.md", "/api/knowledge/read?path=docs%2Fcompany-doctrine.md"],
  ["files/reports/result.txt", "/api/files/read?path=files/reports/result.txt"],
  ["uploads/2026-07/report.txt", "/api/files/read?path=uploads/2026-07/report.txt"],
] as const;

const specialChatPaths = [
  ["files/nested dir/report.txt", "/api/files/read?path=files/nested%20dir/report.txt"],
  ["files/100%.txt", "/api/files/read?path=files/100%25.txt"],
  ["files/topic#1.txt", "/api/files/read?path=files/topic%231.txt"],
  ["files/query?.txt", "/api/files/read?path=files/query%3F.txt"],
  ["files/café.txt", "/api/files/read?path=files/caf%C3%A9.txt"],
  ["files/文档.txt", "/api/files/read?path=files/%E6%96%87%E6%A1%A3.txt"],
] as const;

const literalPercentChatPaths = [
  ["files/report%2F2026.txt", "/api/files/read?path=files/report%252F2026.txt"],
  ["files/report%5C2026.txt", "/api/files/read?path=files/report%255C2026.txt"],
  ["files/report%002026.txt", "/api/files/read?path=files/report%25002026.txt"],
  ["files/%2e", "/api/files/read?path=files/%252e"],
] as const;

function ChatFileHarness({ path, sessionId = "session-1" }: { path: string; sessionId?: string | null }) {
  const messages: Message[] = [{
    id: `message-${path}`,
    role: "assistant",
    content: `Open \`${path}\``,
    timestamp: 1,
  }];

  return (
    <FileLinkSessionContext.Provider value={sessionId}>
      <ChatMessages messages={messages} loading={false} />
    </FileLinkSessionContext.Provider>
  );
}

/** A chat file link is a plain new-tab link: the click is never intercepted
 *  in-page, and the tab it opens is the standalone /file route. */
function openInNewTab(link: HTMLElement) {
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(fireEvent.click(link)).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  const url = new URL(link.getAttribute("href") ?? "", "http://ui.test");
  expect(url.pathname).toBe("/file");
  render(<FileView path={url.searchParams.get("path") ?? ""} sessionId={url.searchParams.get("session")} />);
}

describe("FileView requests opened from chat", () => {
  it.each(supportedPaths)("routes %s to its scoped read endpoint", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in a new tab`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}`);
    openInNewTab(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_ORIGIN}${expectedUrl}`,
      expect.objectContaining({ credentials: "include" }),
    ));
  });

  it.each(specialChatPaths)("linkifies and opens special chat path %s", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in a new tab`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}`);
    openInNewTab(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_ORIGIN}${expectedUrl}`,
      expect.objectContaining({ credentials: "include" }),
    ));
  });

  it.each(literalPercentChatPaths)("round-trips literal percent-like chat path %s", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in a new tab`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}`);
    openInNewTab(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_ORIGIN}${expectedUrl}`,
      expect.objectContaining({ credentials: "include" }),
    ));
  });

  it.each([
    ["/srv/work/evidence/report.md", "/api/sessions/session-1/files/read?path=%2Fsrv%2Fwork%2Fevidence%2Freport.md"],
    ["~/notes/plan.md", "/api/sessions/session-1/files/read?path=~%2Fnotes%2Fplan.md"],
    ["src/app/main.ts", "/api/sessions/session-1/files/read?path=src%2Fapp%2Fmain.ts"],
  ] as const)("opens session path %s on the session's host in a new tab", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in a new tab`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}&session=session-1`);
    openInNewTab(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_ORIGIN}${expectedUrl}`,
      expect.objectContaining({ credentials: "include" }),
    ));
  });

  it("leaves a non-root path unlinked when no session is known", () => {
    render(<ChatFileHarness path="/srv/work/evidence/report.md" sessionId={null} />);

    expect(screen.getByText(/\/srv\/work\/evidence\/report\.md/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("previews a session image inline from the raw route and names its host", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ path: "/srv/work/shot.png", host: "build-box", mime: "image/png", size: 2048, binary: true, tooLarge: false, previewable: true }),
    } as Response);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["png"]) } as Response);
    const createObjectURL = vi.fn(() => "blob:shot");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));

    render(<FileView path="/srv/work/shot.png" sessionId="session-1" />);

    // The image goes through authFetch (credentials included), not a bare <img src>.
    const image = await screen.findByRole("img", { name: "shot.png" });
    expect(image.getAttribute("src")).toBe("blob:shot");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${GATEWAY_ORIGIN}/api/sessions/session-1/files/raw?path=%2Fsrv%2Fwork%2Fshot.png`,
      expect.objectContaining({ credentials: "include" }),
    );
    expect(screen.getByText(/on build-box/)).toBeTruthy();
  });

  it("describes a binary session file the gateway will not serve raw", async () => {
    const svg = { path: "/srv/work/a.svg", mime: "image/svg+xml", size: 10, binary: true, tooLarge: false, previewable: false };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => svg } as Response);

    render(<FileView path="/srv/work/a.svg" sessionId="session-1" embedded />);

    expect(await screen.findByText(/Binary file/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps a lone-surrogate supported-root path as inline code", () => {
    const path = `files/bad${String.fromCharCode(0xd800)}.txt`;

    expect(() => render(<ChatFileHarness path={path} />)).not.toThrow();
    expect(screen.getByText(path, { selector: "code" })).toBeTruthy();
    expect(screen.queryByTitle(`Open ${path} in a new tab`)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "files/../outside.txt",
    "files/./report.txt",
    "files//report.txt",
    "files/nested\\report.txt",
    "files/has\0nul.txt",
    "files/has\u0001control.txt",
  ])("keeps unsafe supported-root chat path %s as inline code", (path) => {
    render(<ChatFileHarness path={path} />);

    expect(screen.getByText(path, { selector: "code" })).toBeTruthy();
    expect(screen.queryByTitle(`Open ${path} in a new tab`)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["secrets/api-keys.json", /Unsupported file root/],
    ["../outside.txt", /traversal/],
    ["files/../outside.txt", /traversal/],
    ["files//outside.txt", /normalized/],
    ["files%2Foutside.txt", /Unsupported file root/],
    ["/etc/passwd", /relative/],
    ["C:\\Windows\\system.ini", /relative|forward slash/],
    ["files\\outside.txt", /forward slash/],
    ["files/has\0nul.txt", /control bytes/],
    ["files/has\u0001control.txt", /control bytes/],
  ] as const)("rejects unsafe viewer path %s before fetching", async (path, errorPattern) => {
    render(<FileView path={path} embedded />);

    expect(await screen.findByText(errorPattern)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a knowledge response without managed-file-only metadata", async () => {
    render(<FileView path="knowledge/product-checklist.md" />);

    expect(await screen.findByText("knowledge body")).toBeTruthy();
    expect(screen.queryByText(/NaN B|undefined/)).toBeNull();
  });

  it("shows invalid Unicode safely without fetching or a broken pop-out link", async () => {
    const path = `files/bad${String.fromCharCode(0xd800)}.txt`;
    render(<FileView path={path} embedded />);

    expect(await screen.findByText(/invalid Unicode/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Open in new browser tab")).toBeNull();
  });

  it("does not label the JSON read route as a binary download", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        path: "files/archive.zip",
        resolvedPath: "/managed/files/archive.zip",
        mime: "application/zip",
        size: 1024,
        binary: true,
        tooLarge: false,
      }),
    } as Response);

    render(<FileView path="files/archive.zip" embedded />);

    expect(await screen.findByText(/Binary file/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download file" })).toBeNull();
  });
});
