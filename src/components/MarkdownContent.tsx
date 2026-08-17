import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Zentraler Markdown-Renderer für Assistant-Nachrichten in beiden
// Chat-Modi (MyBro + Smalltalk). GitHub-Flavored-Markdown-Plugin ergibt
// Tabellen, Task-Listen, Strikethrough und Autolinks. Alle Tags erhalten
// eigene Tailwind-Klassen, damit das Rendering im MyBro-Look (Messing-
// Akzent, dunkles Elevated-Grau) bleibt und in der 85 %-breiten Chat-
// Bubble (siehe Chat.tsx) sauber aussieht – inkl. horizontaler Scroll-
// Wrapper für breite Tabellen und Code-Blöcke.

const components: Components = {
  // Absätze mit dezentem Abstand, aber nicht am Rand der Bubble.
  p: ({ children }) => (
    <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
  ),

  // Überschriften: bleiben proportional zur kleinen Chat-Schrift.
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 first:mt-0 text-base font-semibold">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 first:mt-0 text-[15px] font-semibold">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 first:mt-0 text-sm font-semibold">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-2 first:mt-0 text-sm font-semibold">{children}</h4>
  ),

  // Listen: klarer Einzug, dezenter Abstand zwischen Items.
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0 marker:text-text-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0 marker:text-text-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  // Hervorhebungen.
  strong: ({ children }) => (
    <strong className="font-semibold text-text">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,

  // Links: Messing-Gold-Akzent, unterstrichen beim Hover, immer neuer Tab.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent break-words"
    >
      {children}
    </a>
  ),

  // Inline-Code vs. Code-Block: bei Codeblöcken kommt `<code>` in `<pre>`
  // vorbei; wir stylen `<code>` schlicht als Inline und `<pre>` als Block.
  code: ({ children, ...props }) => {
    const className = (props as { className?: string }).className;
    // Code innerhalb <pre> hat className wie `language-xyz` (oder nichts,
    // wenn keine Sprache angegeben ist). Fenced-Blöcke enthalten IMMER
    // Zeilenumbrüche, Inline nie – das ist unser sicherstes Signal.
    const isBlock =
      typeof children === "string" && children.includes("\n");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} block font-mono text-[13px]`}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-bg px-1 py-0.5 font-mono text-[0.85em] text-text">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg border border-border bg-bg px-3 py-2 text-[13px] leading-relaxed last:mb-0">
      {children}
    </pre>
  ),

  // Blockquote als linker Akzentbalken, geeignet für Zitate und Hinweise.
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-accent/60 pl-3 italic text-text-muted last:mb-0">
      {children}
    </blockquote>
  ),

  // Horizontale Linie: dezent.
  hr: () => <hr className="my-3 border-border" />,

  // Tabellen: horizontaler Scroll-Wrapper (damit breite Tabellen die
  // Bubble nicht sprengen), klare Rahmen, Zebra-Streifen auf `tbody tr`.
  table: ({ children }) => (
    <div className="mb-2 -mx-1 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-bg text-text">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="[&_tr:nth-child(even)]:bg-bg/50">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-border last:border-b-0">{children}</tr>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border border-border px-2 py-1.5 text-left font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={style}
      className="border border-border px-2 py-1.5 align-top"
    >
      {children}
    </td>
  ),
};

function MarkdownContentImpl({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Memoized: die Message-Content-Props sind stabil, sobald die Nachricht
// persistiert ist. Vermeidet unnötige Re-Renders im langen Chat-Verlauf.
export const MarkdownContent = memo(MarkdownContentImpl);
