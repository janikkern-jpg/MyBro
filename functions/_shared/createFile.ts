// Zentrale Erzeugung der Nutzer-Downloads für das Smalltalk-Tool
// `create_file`. Läuft server-seitig, damit
//  - PDF/DOCX-Bibliotheken (pdf-lib, docx) nicht ins Client-Bundle
//    kommen (~1 MB gespart) und
//  - der Datei-Upload das Supabase-Access-Token des Users trägt, sodass
//    die RLS-Policy `chat_files_insert_own_folder` greift und der
//    Server den User nicht "impersonaten" muss.
//
// Rückgabe pro Aufruf: eine `CreatedFile`, die im Antwort-Envelope an
// den Client zurückwandert (Marker im Assistant-Content) und dort als
// Download-Karte gerendert wird.

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type CreateFileType = "csv" | "txt" | "pdf" | "docx" | "json";

export type CreatedFile = {
  filename: string;
  file_type: CreateFileType;
  url: string;
  path: string;
  size_bytes: number;
};

export type CreateFileArgs = {
  filename: string;
  content: string;
  file_type: CreateFileType;
};

const ALLOWED_TYPES: readonly CreateFileType[] = [
  "csv",
  "txt",
  "pdf",
  "docx",
  "json",
];

const MIME: Record<CreateFileType, string> = {
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Maximale Rohtext-Größe, die wir akzeptieren. Server-Timeouts (Netlify:
// 10 s Standard, CF Pages Functions: 30 s CPU) machen alles darüber
// unpraktisch – und "einfache funktionale Exporte" sind das explizite
// Scope-Limit. 1 MB Text ≈ Buch mit ~200 Seiten.
const MAX_CONTENT_BYTES = 1_000_000;

function sanitizeFilename(input: string, fileType: CreateFileType): string {
  // Ersetzt Path-Separatoren und Steuerzeichen, behält aber Umlaute
  // und Bindestriche. Endet immer auf der richtigen Endung.
  const base =
    (input || "").replace(/[\\/\u0000-\u001f]+/g, "_").trim() || "datei";
  const withoutExt = base.replace(/\.[a-z0-9]{1,10}$/i, "");
  const safe = withoutExt.slice(0, 120);
  return `${safe}.${fileType}`;
}

function randomHex(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function textEncoder(): TextEncoder {
  return new TextEncoder();
}

// --------------------------- PDF ------------------------------------

async function buildPdf(
  filename: string,
  content: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 56;
  const usableWidth = pageWidth - margin * 2;
  const titleSize = 16;
  const bodySize = 11;
  const lineHeight = 15;

  // Wir wickeln Zeilen manuell um, damit lange Fließtext-Antworten
  // nicht am rechten Rand rausschießen.
  function wrap(line: string, size: number, f = font): string[] {
    if (!line) return [""];
    const words = line.split(/\s+/);
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(test, size) <= usableWidth) {
        cur = test;
      } else {
        if (cur) out.push(cur);
        cur = w;
      }
    }
    if (cur) out.push(cur);
    return out.length > 0 ? out : [""];
  }

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  // Titel (aus Dateiname, ohne Endung).
  const title = filename.replace(/\.[a-z0-9]+$/i, "");
  page.drawText(title, {
    x: margin,
    y: y - titleSize,
    size: titleSize,
    font: bold,
    color: rgb(0.12, 0.12, 0.14),
  });
  y -= titleSize + 20;

  // Fließtext: pdf-lib kann nicht mit vielen Nicht-ASCII-Zeichen bei
  // Standard-Fonts umgehen. Wir ersetzen problematische Zeichen durch
  // ASCII-nahes Ersatzzeichen, damit z. B. Umlaute funktionieren.
  const safeContent = content
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");

  const paragraphs = safeContent.split(/\r?\n/);
  for (const para of paragraphs) {
    const lines = wrap(para, bodySize);
    for (const l of lines) {
      if (y < margin + lineHeight) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(l, {
        x: margin,
        y,
        size: bodySize,
        font,
        color: rgb(0.1, 0.1, 0.12),
      });
      y -= lineHeight;
    }
    y -= 4; // zusätzlicher Absatzabstand
  }

  return await pdf.save();
}

// --------------------------- DOCX -----------------------------------

async function buildDocx(
  filename: string,
  content: string,
): Promise<Uint8Array> {
  const title = filename.replace(/\.[a-z0-9]+$/i, "");
  const paragraphs = content.split(/\r?\n/);

  // Einfache Listen-Erkennung: Zeilen, die mit `- `, `* ` oder `1. ` etc.
  // beginnen, werden als Listeneinträge stilisiert. Das Markdown, das die
  // KI liefert, wird so grundsätzlich lesbar; komplexes Layout ist
  // bewusst nicht Scope.
  const docParas = paragraphs.map((raw) => {
    const line = raw.replace(/^\s+/, "");
    const listMatch = line.match(/^(?:[-*]\s+|\d+\.\s+)(.*)$/);
    if (listMatch) {
      return new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun(listMatch[1])],
      });
    }
    if (line.length === 0) {
      return new Paragraph({ children: [new TextRun("")] });
    }
    return new Paragraph({ children: [new TextRun(line)] });
  });

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: title, bold: true })],
          }),
          ...docParas,
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}

// --------------------------- Upload ---------------------------------

/**
 * Führt einen POST auf /storage/v1/object/{bucket}/{path} mit dem
 * Supabase-Access-Token des Users durch. Dadurch greift die RLS-Policy
 * `chat_files_insert_own_folder`, die exakt den Ordner `{user_id}/…`
 * erlaubt. Der Server braucht KEIN Service-Role-Secret.
 */
async function uploadToSupabase(opts: {
  supabaseUrl: string;
  accessToken: string;
  supabaseAnonKey: string;
  path: string;
  contentType: string;
  body: Uint8Array;
}): Promise<void> {
  const uploadUrl = `${opts.supabaseUrl.replace(
    /\/+$/,
    "",
  )}/storage/v1/object/chat-files/${opts.path}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": opts.contentType,
      // Supabase Storage prüft anon-key + Bearer-Token (JWT).
      apikey: opts.supabaseAnonKey,
      authorization: `Bearer ${opts.accessToken}`,
      "cache-control": "31536000",
      "x-upsert": "false",
    },
    body: opts.body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase-Storage-Upload fehlgeschlagen (${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

function publicUrlFor(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/chat-files/${path}`;
}

// --------------------------- Public API -----------------------------

export type CreateFileEnv = {
  userId: string;
  accessToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

/**
 * Validiert Tool-Argumente, erzeugt den Datei-Body, lädt ihn in
 * `chat-files/{user_id}/{uuid}.{ext}` und liefert die Datei-Metadaten
 * (inkl. Public-URL) für den Tool-Result-Block zurück.
 */
export async function createFileFromToolInput(
  args: unknown,
  env: CreateFileEnv,
): Promise<CreatedFile> {
  if (!args || typeof args !== "object") {
    throw new Error("Fehlende Tool-Argumente.");
  }
  const record = args as Record<string, unknown>;

  const rawType = typeof record.file_type === "string" ? record.file_type : "";
  const fileType = rawType.toLowerCase() as CreateFileType;
  if (!ALLOWED_TYPES.includes(fileType)) {
    throw new Error(
      `Ungültiger file_type "${rawType}". Erlaubt: ${ALLOWED_TYPES.join(", ")}.`,
    );
  }

  const contentStr =
    typeof record.content === "string" ? record.content : "";
  if (!contentStr) {
    throw new Error("Feld 'content' ist leer.");
  }
  if (contentStr.length > MAX_CONTENT_BYTES) {
    throw new Error(
      `Feld 'content' ist zu groß (${contentStr.length} Zeichen, max ${MAX_CONTENT_BYTES}).`,
    );
  }

  const filename = sanitizeFilename(
    typeof record.filename === "string" ? record.filename : "",
    fileType,
  );

  // Body je nach Typ erzeugen.
  let body: Uint8Array;
  switch (fileType) {
    case "csv":
    case "txt":
      body = textEncoder().encode(contentStr);
      break;
    case "json": {
      // Wenn der Content selbst schon valides JSON ist, hübschen wir ihn
      // auf; wenn nicht, packen wir ihn als String in ein Objekt.
      try {
        const parsed = JSON.parse(contentStr);
        body = textEncoder().encode(JSON.stringify(parsed, null, 2));
      } catch {
        body = textEncoder().encode(
          JSON.stringify({ content: contentStr }, null, 2),
        );
      }
      break;
    }
    case "pdf":
      body = await buildPdf(filename, contentStr);
      break;
    case "docx":
      body = await buildDocx(filename, contentStr);
      break;
  }

  const uuid = randomHex(16);
  const path = `${env.userId}/${uuid}.${fileType}`;

  await uploadToSupabase({
    supabaseUrl: env.supabaseUrl,
    accessToken: env.accessToken,
    supabaseAnonKey: env.supabaseAnonKey,
    path,
    contentType: MIME[fileType],
    body,
  });

  return {
    filename,
    file_type: fileType,
    url: publicUrlFor(env.supabaseUrl, path),
    path,
    size_bytes: body.byteLength,
  };
}

// Anthropic-Tool-Definition für create_file (bewusst hier, damit die
// Definition und die Implementation nicht auseinanderlaufen können).
export const CREATE_FILE_TOOL = {
  name: "create_file",
  description:
    "Erzeugt eine herunterladbare Datei aus reinem Text/CSV/JSON oder als einfaches PDF/DOCX-Dokument. " +
    "Nutze das Tool, wenn der Nutzer explizit um eine Datei, einen Export, ein Dokument, eine Liste zum Download oder Ähnliches bittet. " +
    "Bei tabellarischen Daten immer CSV verwenden (Kopfzeile + kommagetrennt). Bei reinem Text TXT. " +
    "Bei strukturiertem Bericht/Kurzdokument PDF oder DOCX (Titel + Absätze/Aufzählungen).",
  input_schema: {
    type: "object" as const,
    properties: {
      filename: {
        type: "string",
        description:
          "Kurzer, sprechender Dateiname OHNE Pfad, OHNE Endung (Endung wird automatisch aus file_type ergänzt). Beispiel: 'arzt-liste-wien'.",
      },
      content: {
        type: "string",
        description:
          "Vollständiger Datei-Inhalt als Klartext. Bei CSV: kommagetrennte Zeilen mit Kopfzeile. Bei JSON: valides JSON. Bei TXT/PDF/DOCX: normaler Fließtext mit Zeilenumbrüchen, für Listen '- ' als Präfix.",
      },
      file_type: {
        type: "string",
        enum: ["csv", "txt", "pdf", "docx", "json"],
        description:
          "Dateityp/Endung. csv/txt/json: reiner Text; pdf/docx: einfaches formatiertes Dokument (Titel + Absätze/Listen, kein komplexes Layout).",
      },
    },
    required: ["filename", "content", "file_type"],
  },
} as const;
