import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Deutlicher Hinweis im Dev-Umfeld; im Prod würde man das schöner behandeln.
  console.error(
    "Supabase-Env fehlt. Bitte VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY in .env setzen.",
  );
}

export const supabase = createClient(url ?? "", anonKey ?? "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
