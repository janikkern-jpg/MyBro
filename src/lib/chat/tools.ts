import { supabase } from "../supabase";

// Anthropic-Tool-Definitionen (input_schema als JSON-Schema).
export const CHAT_TOOLS = [
  {
    name: "save_profile",
    description:
      "Speichert oder aktualisiert das Nutzerprofil und beendet das Onboarding. " +
      "Nutze das Tool am Ende des Kennenlerngesprächs mit einer dichten, wohlwollenden " +
      "Zusammenfassung über die Person (Lebenssituation, Ziele, Umfeld, Antrieb).",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Vorname oder gewünschte Anrede, falls bekannt.",
        },
        summary: {
          type: "string",
          description:
            "Kompakte, warme Zusammenfassung des Nutzers als Kontext für zukünftige Gespräche.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "create_challenge",
    description:
      "Legt eine neue Challenge mit einer Tagesaufgabe pro Element in daily_tasks an. " +
      "Nur selten und organisch nutzen, nie mehrere aktive Challenges gleichzeitig. " +
      "Bevorzugte Länge 5–14 Tage.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        daily_tasks: {
          type: "array",
          items: { type: "string" },
          description:
            "Eine Aufgabe pro Tag, beginnend heute; Reihenfolge = Tagesabfolge.",
        },
      },
      required: ["title", "description", "daily_tasks"],
    },
  },
  {
    name: "archive_topic",
    description:
      "Archiviert das bisherige Gespräch: fasst alle Nachrichten bis auf die letzten zwei " +
      "als eine Zeile im Archiv zusammen und löscht sie aus der Chat-Historie. " +
      "Nur nutzen, wenn ein Thema erkennbar abgeschlossen ist UND der Verlauf lang geworden ist.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
      },
      required: ["title", "summary"],
    },
  },
] as const;

export type ToolContext = {
  userId: string;
  refreshProfile: () => Promise<void>;
  refreshChallenges: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshArchive: () => Promise<void>;
};

export type ToolOutcome = { ok: boolean; text: string };

function todayIsoDate(): string {
  const d = new Date();
  // Lokale Zeit, YYYY-MM-DD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDaysIso(baseIso: string, offset: number): string {
  const [y, m, d] = baseIso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + offset);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "save_profile": {
        const summary = typeof input.summary === "string" ? input.summary.trim() : "";
        if (!summary) return { ok: false, text: "summary fehlt." };

        const patch: Record<string, unknown> = {
          user_id: ctx.userId,
          summary,
          onboarding_complete: true,
        };
        if (typeof input.name === "string" && input.name.trim()) {
          patch.name = input.name.trim();
        }

        const { error } = await supabase
          .from("profiles")
          .upsert(patch, { onConflict: "user_id" });
        if (error) throw error;

        await ctx.refreshProfile();
        return { ok: true, text: "Profil gespeichert, Onboarding abgeschlossen." };
      }

      case "create_challenge": {
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const description =
          typeof input.description === "string" ? input.description.trim() : "";
        const rawTasks = Array.isArray(input.daily_tasks) ? input.daily_tasks : [];
        const tasks = rawTasks
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        if (!title) return { ok: false, text: "title fehlt." };
        if (tasks.length === 0) return { ok: false, text: "daily_tasks ist leer." };

        const { data: challenge, error: e1 } = await supabase
          .from("challenges")
          .insert({
            user_id: ctx.userId,
            title,
            description: description || null,
            active: true,
          })
          .select("id")
          .single();
        if (e1 || !challenge) throw e1 ?? new Error("Insert challenges fehlgeschlagen.");

        const start = todayIsoDate();
        const rows = tasks.map((task, i) => ({
          challenge_id: challenge.id,
          user_id: ctx.userId,
          date: addDaysIso(start, i),
          task,
          done: false,
        }));
        const { error: e2 } = await supabase.from("challenge_days").insert(rows);
        if (e2) throw e2;

        await ctx.refreshChallenges();
        return {
          ok: true,
          text: `Challenge "${title}" mit ${tasks.length} Tag(en) angelegt.`,
        };
      }

      case "archive_topic": {
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const summary = typeof input.summary === "string" ? input.summary.trim() : "";
        if (!title) return { ok: false, text: "title fehlt." };
        if (!summary) return { ok: false, text: "summary fehlt." };

        const { data: msgs, error: e1 } = await supabase
          .from("messages")
          .select("id, created_at")
          .order("created_at", { ascending: true });
        if (e1) throw e1;
        const list = msgs ?? [];
        if (list.length <= 2) {
          return {
            ok: false,
            text: "Zu wenige Nachrichten, nichts archiviert.",
          };
        }

        const toArchiveIds = list.slice(0, list.length - 2).map((m) => m.id);

        const { error: e2 } = await supabase.from("archive").insert({
          user_id: ctx.userId,
          title,
          summary,
          message_count: toArchiveIds.length,
        });
        if (e2) throw e2;

        const { error: e3 } = await supabase
          .from("messages")
          .delete()
          .in("id", toArchiveIds);
        if (e3) throw e3;

        await ctx.refreshMessages();
        await ctx.refreshArchive();
        return {
          ok: true,
          text: `${toArchiveIds.length} Nachrichten archiviert.`,
        };
      }

      default:
        return { ok: false, text: `Unbekanntes Tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
    return { ok: false, text: msg };
  }
}
