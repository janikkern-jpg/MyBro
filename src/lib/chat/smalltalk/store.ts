import { supabase } from "../../supabase";
import type {
  SmalltalkConversation,
  SmalltalkMessage,
  SmalltalkPrinciple,
  SmalltalkProject,
  SmalltalkRole,
} from "./types";

/**
 * Kurzer Titel aus den ersten Wörtern einer Nachricht. Wird beim Anlegen
 * einer neuen Unterhaltung genutzt, falls der Nutzer keinen Titel setzt.
 */
export function buildAutoTitle(firstMessage: string, maxWords = 6): string {
  const cleaned = firstMessage
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…]+$/, "");
  if (!cleaned) return "Neue Unterhaltung";
  const words = cleaned.split(" ").slice(0, maxWords).join(" ");
  return words.length > 60 ? `${words.slice(0, 60)}…` : words;
}

export async function loadPrinciples(
  userId: string,
): Promise<SmalltalkPrinciple[]> {
  const { data, error } = await supabase
    .from("smalltalk_principles")
    .select("*")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SmalltalkPrinciple[];
}

export async function loadConversation(
  conversationId: string,
): Promise<{
  conversation: SmalltalkConversation | null;
  messages: SmalltalkMessage[];
}> {
  const [convRes, msgRes] = await Promise.all([
    supabase
      .from("st_conversations")
      .select("*")
      .eq("id", conversationId)
      .maybeSingle(),
    supabase
      .from("st_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }),
  ]);
  if (convRes.error) throw convRes.error;
  if (msgRes.error) throw msgRes.error;
  return {
    conversation: (convRes.data ?? null) as SmalltalkConversation | null,
    messages: (msgRes.data ?? []) as SmalltalkMessage[],
  };
}

export async function createConversation(params: {
  userId: string;
  title: string;
  projectId?: string | null;
}): Promise<SmalltalkConversation> {
  const { data, error } = await supabase
    .from("st_conversations")
    .insert({
      user_id: params.userId,
      title: params.title,
      project_id: params.projectId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Konnte Unterhaltung nicht anlegen.");
  }
  return data as SmalltalkConversation;
}

export async function insertMessage(params: {
  conversationId: string;
  role: SmalltalkRole;
  content: string;
  imageUrl?: string | null;
}): Promise<SmalltalkMessage> {
  const { data, error } = await supabase
    .from("st_messages")
    .insert({
      conversation_id: params.conversationId,
      role: params.role,
      content: params.content,
      image_url: params.imageUrl ?? null,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Konnte Nachricht nicht speichern.");
  }
  // updated_at der Unterhaltung wird per DB-Trigger automatisch gepflegt.
  return data as SmalltalkMessage;
}

export async function touchConversation(conversationId: string): Promise<void> {
  // Trigger pflegt updated_at bei UPDATE. Wir setzen title auf sich selbst,
  // damit der Trigger feuert – oder alternativ ein leerer Update-Aufruf:
  await supabase
    .from("st_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

// ---------------------------------------------------------------------------
// "Zuletzt verwendet": Unterhaltungen OHNE Projektzuordnung, die innerhalb
// der letzten 30 Tage angelegt wurden. Filter läuft rein per Query, kein
// automatisches Löschen nötig (siehe Cron-Hinweis in der Migration).
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function loadRecentConversations(
  userId: string,
): Promise<SmalltalkConversation[]> {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const { data, error } = await supabase
    .from("st_conversations")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .gt("created_at", cutoff)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SmalltalkConversation[];
}

// ---------------------------------------------------------------------------
// Projekte
// ---------------------------------------------------------------------------

export async function loadProjects(
  userId: string,
): Promise<SmalltalkProject[]> {
  const { data, error } = await supabase
    .from("st_projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SmalltalkProject[];
}

export async function createProject(params: {
  userId: string;
  name: string;
}): Promise<SmalltalkProject> {
  const name = params.name.trim();
  if (!name) throw new Error("Projektname darf nicht leer sein.");
  const { data, error } = await supabase
    .from("st_projects")
    .insert({ user_id: params.userId, name })
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Konnte Projekt nicht anlegen.");
  }
  return data as SmalltalkProject;
}

export async function loadProject(
  projectId: string,
): Promise<SmalltalkProject | null> {
  const { data, error } = await supabase
    .from("st_projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as SmalltalkProject | null;
}

export async function loadProjectConversations(
  projectId: string,
): Promise<SmalltalkConversation[]> {
  const { data, error } = await supabase
    .from("st_conversations")
    .select("*")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SmalltalkConversation[];
}

export async function assignConversationToProject(params: {
  conversationId: string;
  projectId: string | null;
}): Promise<SmalltalkConversation> {
  const { data, error } = await supabase
    .from("st_conversations")
    .update({ project_id: params.projectId })
    .eq("id", params.conversationId)
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Konnte Unterhaltung nicht verschieben.");
  }
  return data as SmalltalkConversation;
}
