import type { CSSProperties } from "react";

// -----------------------------------------------------------------------------
// Provider-Badge – kleines rundes Symbol neben KI-Antwortblasen, das zeigt,
// welcher Anbieter tatsächlich geantwortet hat. Bewusst KEINE echten Logos
// von OpenAI oder Anthropic (geschützte Marken): stattdessen ein schlichter
// Buchstabe („A" / „O") in einer für die App eindeutigen Farbe.
//
// - Anthropic → Messing-Gold-Akzent (#C9A227, entspricht text-accent)
// - OpenAI    → ruhiges Teal (#0EA5A4), klar unterscheidbar
//
// Der Tooltip zeigt den ausgeschriebenen Anbieter + Modellname; im Fallback-
// Fall wird das explizit vermerkt.
// -----------------------------------------------------------------------------

type ProviderKey = "anthropic" | "openai";

export type ProviderBadgeProps = {
  provider: string | null | undefined;
  model?: string | null;
  // Wurde die Antwort nur wegen eines Fallbacks (Anthropic → OpenAI) von
  // diesem Anbieter erzeugt? Wird im Tooltip ausgewiesen. Optional.
  fallback?: boolean;
  // Klein neben der Sprechblase, in der Regel oben-rechts. Größe stimmt
  // absichtlich mit der Zeilenhöhe des Metadaten-Labels überein.
  size?: number;
  className?: string;
};

const KNOWN: Record<ProviderKey, { bg: string; letter: string; name: string }> = {
  anthropic: {
    bg: "#C9A227",
    letter: "A",
    name: "Anthropic",
  },
  openai: {
    bg: "#0EA5A4",
    letter: "O",
    name: "OpenAI",
  },
};

// Sehr grobe, wartbare Modell-Beschriftung. Der Zweck ist ausschließlich
// die Anzeige im Tooltip – wir müssen keine perfekten Marketingnamen
// abbilden, nur eine klare Identifikation ermöglichen.
function humanizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const raw = model.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // Bilder
  if (lower === "gpt-image-1") return "GPT Image 1";

  // Anthropic – Namensschema: claude-{family}-{version}[-tag][-date]
  if (lower.startsWith("claude-")) {
    const parts = raw.split("-");
    // "claude" abschneiden, ISO-Datums-Suffixe (yyyymmdd) entfernen.
    const meaningful = parts
      .slice(1)
      .filter((p) => !/^\d{6,8}$/.test(p));
    if (meaningful.length === 0) return raw;
    const formatted = meaningful
      .map((p) =>
        p.length <= 2 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1),
      )
      .join(" ");
    return `Claude ${formatted}`;
  }

  // OpenAI – „gpt-…", „o4-…" etc.
  if (lower.startsWith("gpt-")) {
    return `GPT ${raw.slice(4)}`.trim();
  }

  return raw;
}

function normalizeProvider(value: string | null | undefined): ProviderKey | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "openai" || v === "chatgpt" || v === "gpt") return "openai";
  return null;
}

export function ProviderBadge({
  provider,
  model,
  fallback,
  size = 18,
  className,
}: ProviderBadgeProps) {
  const key = normalizeProvider(provider);
  if (!key) return null;
  const meta = KNOWN[key];
  const modelLabel = humanizeModel(model);
  const tooltip = [
    meta.name,
    modelLabel ? `– ${modelLabel}` : null,
    fallback ? "(Fallback)" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: meta.bg,
    // Buchstabengröße bewusst deutlich kleiner als die Badge selbst,
    // damit ein sauberer Kreis-Rand sichtbar bleibt.
    fontSize: Math.round(size * 0.6),
    lineHeight: 1,
  };

  return (
    <span
      role="img"
      aria-label={tooltip}
      title={tooltip}
      className={[
        "inline-flex shrink-0 select-none items-center justify-center rounded-full",
        "font-semibold text-white shadow-sm ring-1 ring-black/10",
        className ?? "",
      ]
        .join(" ")
        .trim()}
      style={style}
    >
      {meta.letter}
    </span>
  );
}
