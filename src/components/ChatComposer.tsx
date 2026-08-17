import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { CloseIcon, PaperclipIcon } from "./icons";
import { prepareImageForChat, type PreparedImage } from "../lib/chat/imageUtils";

// Gemeinsamer Composer für MyBro und Smalltalk. Kapselt:
//  - Textfeld
//     - Desktop: Enter = senden, Shift+Enter = neue Zeile
//     - Mobile (Touch + schmale Viewport): Enter = immer neue Zeile,
//       Senden nur über den Button. Verhindert versehentliches
//       Abschicken beim Antippen der Enter-Taste der Bildschirm-
//       Tastatur (die dort meist keine Shift-Modifier bietet).
//  - Anhang-Icon → verstecktes <input type="file"> mit
//    accept="image/*" und capture="environment" (Handy: Auswahl
//    Kamera/Galerie automatisch)
//  - Client-seitige Vorbereitung des Bilds (Resize + JPEG-Kompression
//    + Base64) noch bevor abgesendet wird – so bleibt die eigentliche
//    Send-Aktion schnell und der User sieht sofort die verkleinerte
//    Vorschau.
//  - Preview mit "x"-Entfernen-Button.
//
// Der übergeordnete Chat entscheidet, was mit dem Bild passiert –
// diese Komponente ist bewusst nicht an Supabase oder eine bestimmte
// API gekoppelt.

export type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (
    text: string,
    image: PreparedImage | null,
  ) => Promise<boolean> | boolean;
  disabled: boolean;
  ready: boolean;
  placeholder: string;
  submitLabel?: string;
  spinner?: React.ReactNode;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  ready,
  placeholder,
  submitLabel = "Senden",
  spinner,
}: ChatComposerProps) {
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imagePending, setImagePending] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobileComposer();

  const clearAttachment = useCallback(() => {
    setImage(null);
    setImageError(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [previewUrl]);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImagePending(true);
    setImageError(null);
    try {
      const prepared = await prepareImageForChat(file);
      // alten Blob-URL freigeben, bevor ein neuer entsteht
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setImage(prepared);
      setPreviewUrl(URL.createObjectURL(prepared.blob));
    } catch (err) {
      console.error(err);
      const msg =
        err instanceof Error
          ? err.message
          : "Bild konnte nicht verarbeitet werden.";
      setImageError(msg);
      setImage(null);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setImagePending(false);
    }
  }

  const busy = disabled || !ready || imagePending;
  const canSend = ready && !disabled && !imagePending && (value.trim().length > 0 || image !== null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSend) return;
    const result = await onSubmit(value, image);
    if (result === true) {
      onChange("");
      clearAttachment();
    }
  }

  return (
    <>
      {imageError ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {imageError}
        </div>
      ) : null}

      {previewUrl ? (
        <div className="mt-3 flex items-start gap-2">
          <div className="relative">
            <img
              src={previewUrl}
              alt="Anhang-Vorschau"
              className="max-h-32 max-w-[8rem] rounded-lg border border-border object-cover"
            />
            <button
              type="button"
              onClick={clearAttachment}
              aria-label="Anhang entfernen"
              className="absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-bg-elevated text-text shadow-sm transition-colors hover:bg-surface"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {image ? (
            <p className="text-xs text-text-muted">
              {image.width}×{image.height} · {(image.blob.size / 1024).toFixed(0)} KB
            </p>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="Bild anhängen"
          title="Bild anhängen"
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-border bg-bg-elevated text-text-muted transition-colors hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
        >
          {imagePending ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-text-muted/40 border-t-text" />
          ) : (
            <PaperclipIcon className="h-5 w-5" />
          )}
        </button>

        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Mobile: Enter fügt IMMER nur eine neue Zeile ein.
            // Abgesendet wird ausschließlich über den Senden-Button –
            // sonst würde die virtuelle Tastatur (die auf den meisten
            // Geräten keinen Shift-Modifier für die Enter-Taste bietet)
            // Nachrichten versehentlich verschicken, sobald der Nutzer
            // Absätze setzen will.
            if (isMobile) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit(e as unknown as FormEvent<HTMLFormElement>);
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="min-h-10 max-h-40 flex-1 resize-none rounded-lg border border-border bg-bg-elevated px-3 py-2 text-base leading-relaxed outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-wait disabled:opacity-70 md:text-sm"
          disabled={disabled || !ready}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="inline-flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {disabled ? spinner : null}
          <span>{submitLabel}</span>
        </button>
      </form>
    </>
  );
}

// Feature-Detection statt UA-Sniffing: als "mobil" gilt ein Gerät, das
// gleichzeitig einen groben Pointer hat (Touch als primäre Eingabe) UND
// eine schmale Viewport-Breite. Grenzwert 768 px entspricht Tailwinds
// `md`-Breakpoint – oberhalb davon (Tablet im Landscape, Desktop mit
// Touchscreen) soll das gewohnte Desktop-Verhalten wieder greifen.
function useIsMobileComposer(): boolean {
  const query = "(pointer: coarse) and (max-width: 767px)";
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // aktuellen Wert nochmal synchronisieren, falls zwischen Initial-
    // Render und Effect etwas gedreht wurde (Orientation-Change).
    setIsMobile(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return isMobile;
}
