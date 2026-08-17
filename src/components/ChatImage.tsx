import { useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./icons";

// Bild-Anzeige in einer Chat-Bubble:
//  - Standardmäßig kompaktes Thumbnail, das in die Bubble passt.
//  - Klick öffnet ein Vollbild-Overlay (Modal), das mit Escape oder
//    Klick auf den Hintergrund wieder schließt.
//
// Kein Preloading, kein Lazy-Import – die eigentlichen Kosten sind
// die Bild-Downloads aus dem Supabase-Storage-CDN.

export function ChatImage({
  url,
  alt,
}: {
  url: string;
  alt?: string;
}) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Bild vergrößern"
        className="mb-2 block max-w-full overflow-hidden rounded-lg border border-border/60 focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <img
          src={url}
          alt={alt ?? "Angehängtes Bild"}
          loading="lazy"
          className="max-h-64 max-w-full object-cover"
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <button
            type="button"
            onClick={close}
            aria-label="Vollbild schließen"
            className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-bg-elevated/80 text-text shadow-lg transition-colors hover:bg-bg-elevated"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
          <img
            src={url}
            alt={alt ?? "Angehängtes Bild"}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      ) : null}
    </>
  );
}
