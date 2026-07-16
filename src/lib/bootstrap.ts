import { supabase } from "./supabase";

/**
 * Legt beim ersten Login pro Nutzer einen leeren profiles-Eintrag an
 * (onboarding_complete: false). Idempotent: mehrfache Aufrufe
 * verursachen keine Duplikate.
 */
export async function ensureUserBootstrap(userId: string): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );

  if (error) {
    console.error("Bootstrap: profiles konnte nicht angelegt werden", error);
  }
}
