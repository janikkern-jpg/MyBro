import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigError: string | null =
  !url || !anonKey
    ? "Supabase-Konfiguration fehlt: bitte VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY in Cloudflare Pages > Settings > Variables and Secrets als Plaintext-Build-Variablen setzen und neu deployen."
    : null;

if (supabaseConfigError) {
  console.error(supabaseConfigError);
}

// Fallback-URL/Key verhindert, dass createClient beim Boot wirft; die
// App zeigt stattdessen im AuthGate eine sichtbare Fehlermeldung.
export const supabase = createClient(
  url && anonKey ? url : "https://invalid.supabase.co",
  anonKey && url ? anonKey : "invalid",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
