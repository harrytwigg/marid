import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth";

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The red box FileView uses for "not found" and read errors. */
export function FileErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius-md,12px)] py-[var(--space-4)] px-[var(--space-4)] text-[length:var(--text-body)] text-[var(--system-red)]"
      style={{
        background: "color-mix(in srgb, var(--system-red) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The image at `url`, fetched the way every other gateway read is (authFetch)
 * and handed to <img> as a blob URL. A bare <img src> would be a no-cors image
 * request, which the gateway does not accept as the operator on an instance
 * without auth, and which would not carry a bearer token either.
 */
function useImageObjectUrl(url: string | undefined): { src?: string; failed: boolean } {
  const [state, setState] = useState<{ src?: string; failed: boolean }>({ failed: false });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ failed: false });
    authFetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        objectUrl = URL.createObjectURL(await res.blob());
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setState({ src: objectUrl, failed: false });
      })
      .catch(() => { if (!cancelled) setState({ failed: true }); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return state;
}

/**
 * A binary file: the image itself when the gateway says it can serve it raw
 * (`previewable`, PNG/JPEG/GIF/WebP only), otherwise a one-line description.
 */
export function BinaryFilePreview({ path, mime, size, rawUrl }: { path: string; mime?: string; size?: number; rawUrl?: string }) {
  const image = useImageObjectUrl(rawUrl);
  if (rawUrl && image.src) {
    return (
      <img
        src={image.src}
        alt={path.split("/").pop() ?? path}
        className="max-w-full h-auto rounded-[var(--radius-md,12px)] border border-[var(--separator)]"
      />
    );
  }
  if (rawUrl && !image.failed) {
    return <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">Loading image…</p>;
  }
  const details = [mime, typeof size === "number" ? formatSize(size) : ""].filter(Boolean).join(", ");
  return (
    <div className="text-[length:var(--text-body)] text-[var(--text-secondary)]">
      <p>Binary file{details ? ` (${details})` : ""}: cannot preview.</p>
    </div>
  );
}
