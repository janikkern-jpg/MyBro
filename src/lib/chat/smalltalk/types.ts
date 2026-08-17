// Datentypen für den Smalltalk-Zweig – bewusst getrennt von den
// MyBro-Typen unter ../types.ts, um beide Modi klar zu isolieren.

import type { ContentBlock } from "../types";

export type SmalltalkRole = "user" | "assistant";

export type SmalltalkPrinciple = {
  id: string;
  user_id: string;
  position: number;
  title: string;
  body: string;
};

export type SmalltalkProject = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
};

export type SmalltalkConversation = {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type SmalltalkMessage = {
  id: string;
  conversation_id: string;
  role: SmalltalkRole;
  content: string;
  image_url: string | null;
  created_at: string;
};

// Anthropic-Wire-Format (nur die Felder, die der Smalltalk-Endpoint nutzt).
// content darf entweder ein einfacher String sein (Text-only) ODER
// ein ContentBlock-Array, wenn ein Bild als Base64-Block angehängt ist.
export type StApiMessage = {
  role: SmalltalkRole;
  content: string | ContentBlock[];
};

// Zitations-Eintrag aus einem web_search-Ergebnis (Anthropic-Format).
export type StWebSearchCitation = {
  type: "web_search_result_location";
  url?: string;
  title?: string;
  cited_text?: string;
  encrypted_index?: string;
};

// Text-Block in einer Anthropic-Response kann optional Zitationen tragen,
// wenn das Modell das Web-Search-Tool genutzt hat.
export type StResponseTextBlock = {
  type: "text";
  text?: string;
  citations?: StWebSearchCitation[];
};

export type StChatResponse = {
  id: string;
  content: Array<StResponseTextBlock | { type: string; text?: string }>;
  model?: string;
  stop_reason?: string | null;
  // Vom Smalltalk-Endpoint gefüllt, wenn Claude im Tool-Loop das
  // `create_file`-Tool aufgerufen hat. Der Client rendert diese Karten
  // unter der Nachricht (nicht als Anhang der User-Nachricht!).
  _files?: StCreatedFile[];
  // Vom Smalltalk-Endpoint gefüllt, wenn Claude im Tool-Loop das
  // `generate_image`-Tool aufgerufen hat. Enthält bereits die public URL
  // im `chat-images`-Bucket – der Client speichert sie in image_url der
  // Assistant-Nachricht und rendert sie mit ChatImage.
  _images?: StGeneratedImage[];
};

// Kompakte, in `content` persistierbare Quellenangabe.
export type StSource = {
  title: string;
  url: string;
};

// Vom Server erzeugte Datei-Metadaten (siehe netlify/functions/_shared/createFile.ts).
export type StCreatedFile = {
  filename: string;
  file_type: "csv" | "txt" | "pdf" | "docx" | "json";
  url: string;
  path: string;
  size_bytes: number;
};

// Vom Server via generate_image erzeugtes Bild (siehe generateImage.ts).
export type StGeneratedImage = {
  prompt: string;
  size: string;
  url: string;
  path: string;
};

export type StImageResponse = {
  imageUrl: string;
};
