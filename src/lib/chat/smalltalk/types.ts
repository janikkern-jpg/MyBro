// Datentypen für den Smalltalk-Zweig – bewusst getrennt von den
// MyBro-Typen unter ../types.ts, um beide Modi klar zu isolieren.

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
export type StApiMessage = {
  role: SmalltalkRole;
  content: string;
};

export type StChatResponse = {
  id: string;
  content: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string | null;
};

export type StImageResponse = {
  imageUrl: string;
};
