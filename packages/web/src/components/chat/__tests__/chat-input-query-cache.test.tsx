import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/query-keys"

const getOrg = vi.fn()
const getSkills = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getOrg: (...args: unknown[]) => getOrg(...args),
    getSkills: (...args: unknown[]) => getSkills(...args),
  },
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: () => ({
    state: "idle",
    error: null,
    analyser: null,
    languages: ["en"],
    selectedLanguage: "en",
    downloadProgress: null,
    cycleLanguage: vi.fn(),
    handleMicClick: vi.fn(),
    stopRecording: vi.fn(),
    dismissError: vi.fn(),
    startDownload: vi.fn(),
    dismissDownload: vi.fn(),
  }),
}))

vi.mock("@/components/stt/whisper-download-modal", () => ({
  WhisperDownloadModal: () => null,
}))

import { ChatInput } from "../chat-input"

function renderWithCachedQueries(inputProps: { isActive?: boolean; focusTrigger?: number; selectorSlot?: React.ReactNode } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
      },
    },
  })
  client.setQueryData(queryKeys.org.all, {
    employees: [
      {
        name: "a-lead",
        displayName: "A Lead",
        department: "Operations",
        rank: "lead",
        engine: "claude",
      },
    ],
  })
  client.setQueryData(queryKeys.skills.all, [
    { name: "custom", description: "Custom skill" },
    { name: "sync", description: "Sync employee context" },
  ])

  return render(
    <QueryClientProvider client={client}>
      <ChatInput
        disabled={false}
        loading={false}
        onSend={vi.fn()}
        onNewSession={vi.fn()}
        onStatusRequest={vi.fn()}
        events={[]}
        {...inputProps}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  getOrg.mockReset()
  getSkills.mockReset()
  getOrg.mockRejectedValue(new Error("raw org fetch should not run"))
  getSkills.mockRejectedValue(new Error("raw skills fetch should not run"))
})

describe("ChatInput query-backed menus", () => {
  it("keeps the model chip at its intrinsic width, shrinking only when Send would overflow", () => {
    renderWithCachedQueries({ selectorSlot: <span data-testid="model-chip">GPT-5.6 Sol</span> })

    const wrapper = screen.getByTestId("model-chip").parentElement!
    const classes = wrapper.className.split(/\s+/)
    // Sized by its content (never grows into the status area's leftover space)...
    expect(classes).not.toContain("flex-1")
    expect(classes).not.toContain("grow")
    // ...but allowed below that, so a cap wider than the row's free space cannot push Send off.
    expect(classes).toEqual(expect.arrayContaining(["min-w-0", "shrink", "overflow-hidden"]))
    expect(classes).not.toContain("shrink-0")
  })

  it("populates @mentions and slash commands from the shared query cache", async () => {
    renderWithCachedQueries()

    const input = screen.getByPlaceholderText("Type a message...")
    fireEvent.change(input, { target: { value: "@a" } })
    expect(await screen.findByText("@a-lead")).toBeTruthy()

    fireEvent.change(input, { target: { value: "/cu" } })
    expect(await screen.findByText("/custom")).toBeTruthy()

    expect(getOrg).not.toHaveBeenCalled()
    expect(getSkills).not.toHaveBeenCalled()
  })

  it("does not refocus a previously handled composer when its pane becomes active again", async () => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus")
    const view = renderWithCachedQueries({ isActive: true, focusTrigger: 1 })

    await waitFor(() => expect(focus).toHaveBeenCalledOnce())
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ChatInput
          disabled={false}
          loading={false}
          onSend={vi.fn()}
          onNewSession={vi.fn()}
          onStatusRequest={vi.fn()}
          events={[]}
          isActive={false}
          focusTrigger={1}
        />
      </QueryClientProvider>,
    )
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ChatInput
          disabled={false}
          loading={false}
          onSend={vi.fn()}
          onNewSession={vi.fn()}
          onStatusRequest={vi.fn()}
          events={[]}
          isActive
          focusTrigger={1}
        />
      </QueryClientProvider>,
    )

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(focus).toHaveBeenCalledOnce()
  })
})
