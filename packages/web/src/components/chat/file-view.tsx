import { useEffect, useMemo, useState } from "react";
import { MarkdownView, SyntaxHighlighter, oneDark, oneLight } from "../markdown-view";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { useTheme } from "@/routes/providers";
import { buildFileReadRequest } from "@/lib/file-read-request";
import { authFetch } from "@/lib/auth";
import { EXT_TO_LANG, MARKDOWN_EXTS, getExt } from "@/lib/file-language";
import { BinaryFilePreview, FileErrorNotice, formatSize } from "./file-view-notices";
/** What the scoped knowledge and managed-file readers return. */
interface FileReadResponse {
  content?: string;
  mime?: string;
  size?: number;
  path: string;
  resolvedPath?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** Session reads only: the build host the file was read on, and whether the
   *  image can be fetched raw for an inline preview. */
  host?: string;
  previewable?: boolean;
  /** Knowledge reads only: this is a capped slice, and how big a slice of what. */
  truncated?: boolean;
  totalChars?: number;
  returnedChars?: number;
}

/**
 * Shared file viewer. Fetches knowledge/docs or managed files through their
 * separate scoped read endpoints and renders markdown or syntax-highlighted
 * code. Used both standalone (the /file route) and embedded inside an in-app
 * tab.
 *
 * - `embedded === true`: no header chrome, fills its parent and scrolls
 *   internally, shows a subtle "open in new browser tab" affordance.
 * - `embedded` falsy: slim sticky header with the path, page-level scroll,
 *   sets document.title to the basename.
 */
export function FileView({
  path,
  sessionId,
  embedded,
  onBack,
}: {
  path: string;
  /** The chat session that linked the path; lets non-root paths be read on its host. */
  sessionId?: string | null;
  embedded?: boolean;
  /** Mobile-only "back to chat" handler. When set, the embedded view shows a
   *  back button (hidden on desktop, which has the tab bar instead). */
  onBack?: () => void;
}) {
  const { theme } = useTheme();

  const [data, setData] = useState<FileReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useMemo(() => buildFileReadRequest(path, sessionId), [path, sessionId]);
  // The request preflight already exercises the same URI encoding. Only offer
  // a pop-out after it succeeds, so malformed Unicode cannot crash rendering.
  const popOutUrl = request.ok ? `/file?path=${encodeURIComponent(path)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}` : null;

  // Resolve whether to use a dark or light highlighter theme. ThemeProvider
  // sets data-theme on <html>; "light" is the only light variant.
  const isDark = useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr) return attr !== "light";
    }
    return theme !== "light";
  }, [theme]);

  useEffect(() => {
    if (!request.ok) {
      setLoading(false);
      setError(request.error);
      setNotFound(false);
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setData(null);

    authFetch(request.url)
      .then(async (res) => {
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return null;
        }
        if (!res.ok) {
          let msg = `Failed to load file (${res.status})`;
          try {
            const body = await res.json();
            if (body?.error) msg = String(body.error);
          } catch {
            /* not JSON */
          }
          throw new Error(msg);
        }
        return (await res.json()) as FileReadResponse;
      })
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [request]);

  // Set the document title to the file name for the standalone tab only.
  useEffect(() => {
    if (embedded) return;
    if (path) {
      const name = path.split(/[\\/]/).pop() ?? path;
      document.title = name;
    }
  }, [path, embedded]);

  const ext = getExt(path);
  const isMarkdown = MARKDOWN_EXTS.has(ext) || data?.mime === "text/markdown";
  const lang = EXT_TO_LANG[ext] ?? "text";
  const codeTheme = isDark ? oneDark : oneLight;

  const body = (
    <>
      {loading && (
        <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
          Loading…
        </p>
      )}

      {!loading && notFound && <FileErrorNotice>File not found: {path}</FileErrorNotice>}

      {!loading && error && !notFound && <FileErrorNotice>{error}</FileErrorNotice>}

      {!loading && data && data.tooLarge && (
        <div className="text-[length:var(--text-body)] text-[var(--text-secondary)]">
          File too large to preview
          {typeof data.size === "number" ? ` (${formatSize(data.size)})` : ""}.
        </div>
      )}

      {!loading && data && !data.tooLarge && data.binary && (
        <BinaryFilePreview
          path={path}
          mime={data.mime}
          size={data.size}
          rawUrl={data.previewable && request.ok ? request.rawUrl : undefined}
        />
      )}

      {!loading &&
        data &&
        !data.tooLarge &&
        !data.binary &&
        data.content !== undefined &&
        (isMarkdown ? (
          <MarkdownView content={data.content} isDark={isDark} />
        ) : (
          <SyntaxHighlighter
            language={lang}
            style={codeTheme}
            customStyle={{
              margin: 0,
              maxWidth: "100%",
              borderRadius: "var(--radius-md, 12px)",
              fontSize: "var(--text-footnote)",
              fontFamily: "var(--font-mono)",
              border: "1px solid var(--separator)",
            }}
            codeTagProps={{ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }}
            showLineNumbers
            wrapLongLines
          >
            {data.content}
          </SyntaxHighlighter>
        ))}

      {!loading && data && data.truncated && (
        <div className="pt-[var(--space-3)] text-[length:var(--text-body)] text-[var(--text-secondary)]">
          Showing the first {data.returnedChars?.toLocaleString()} of {data.totalChars?.toLocaleString()} characters.
        </div>
      )}
    </>
  );

  // Embedded: headerless, fills parent, scrolls internally. The "h-full
  // overflow-y-auto min-h-0" trio is the scroll fix — the parent gives this a
  // bounded flex height and long files now scroll inside the tab instead of
  // being clipped.
  if (embedded) {
    return (
      <div
        className="relative h-full min-h-0 overflow-y-auto overflow-x-hidden"
        style={{ background: "var(--bg)", color: "var(--text-primary)" }}
      >
        {/* Sticky control row: stays pinned at the top of the scroll viewport so
            the buttons remain reachable while scrolling. The row itself is
            transparent and click-through (content scrolls behind it); each
            control is a subtle frosted pill so it reads clearly over markdown
            or code. Back on the left (shown whenever onBack is provided — all
            sizes), pop-out on the right. */}
        <div className="pointer-events-none sticky top-0 z-10 flex items-center justify-between px-3 py-2">
          {onBack ? (
            <button
              onClick={onBack}
              title="Back to chat"
              aria-label="Back to chat"
              className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-thick)] text-[var(--text-tertiary)] backdrop-blur-md transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span />
          )}
          {popOutUrl ? (
            <a
              href={popOutUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new browser tab"
              className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-thick)] text-[var(--text-tertiary)] backdrop-blur-md transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
            >
              <ExternalLink size={16} />
            </a>
          ) : (
            <span />
          )}
        </div>
        {/* Content starts just below the sticky row (which reserves its own
            height); on scroll it slides up behind the floating chips. min-w-0
            lets children (code blocks) cap their own width instead of pushing
            the pane wider. */}
        <div className="px-[var(--space-6)] pb-[var(--space-6)] pt-[var(--space-2)] max-w-[960px] mx-auto min-w-0">
          {body}
        </div>
      </div>
    );
  }

  // Standalone: slim sticky header + its OWN scroll container. The app shell is
  // height-constrained / overflow-hidden, so a plain min-h-screen page can't
  // grow and long files get clipped. h-[100dvh] overflow-y-auto makes this view
  // scroll on its own (dvh so mobile browser chrome doesn't cut off the bottom);
  // the sticky header stays pinned at the top of the scroll container.
  return (
    <div
      className="h-[100dvh] w-full overflow-y-auto overflow-x-hidden"
      style={{ background: "var(--bg)", color: "var(--text-primary)" }}
    >
      {/* Header — in normal flow (scrolls away with content, not pinned). */}
      <header
        className="px-[var(--space-6)] py-[var(--space-4)]"
        style={{
          background: "var(--material-thick)",
          borderBottom: "1px solid var(--separator)",
          backdropFilter: "blur(20px)",
        }}
      >
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
          File
        </p>
        <h1
          className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)] break-all"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {path || "(no path)"}
        </h1>
        {data && data.mime && typeof data.size === "number" && (
          <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[var(--space-1)]">
            {data.mime} · {formatSize(data.size)}{data.host ? ` · on ${data.host}` : ""}
          </p>
        )}
      </header>

      {/* Body */}
      <main className="px-[var(--space-6)] py-[var(--space-6)] max-w-[960px] mx-auto min-w-0">
        {body}
      </main>
    </div>
  );
}
