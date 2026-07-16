// Anthropic Content-Blocks (Messages API).
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ApiMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

// Supabase-Zeilen
export type DbRole = "user" | "assistant";

export type DbMessage = {
  id: string;
  user_id: string;
  role: DbRole;
  content: string;
  created_at: string;
};

export type Profile = {
  user_id: string;
  name: string | null;
  summary: string | null;
  onboarding_complete: boolean;
};

export type ArchiveEntry = {
  id: string;
  user_id: string;
  title: string | null;
  summary: string | null;
  archived_at: string;
  message_count: number | null;
};

export type Challenge = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  active: boolean;
  created_at: string;
};

export type ChallengeDay = {
  id: string;
  challenge_id: string;
  user_id: string;
  date: string; // YYYY-MM-DD
  task: string | null;
  done: boolean;
};

// Marker für nicht-sichtbare Systemhinweis-Turns
export const SYSTEM_TRIGGER_PREFIX = "[Systemhinweis:";
