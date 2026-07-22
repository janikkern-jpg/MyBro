import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "./supabase";

export type ChatMode = "mybro" | "smalltalk";

type ModeState = {
  mode: ChatMode;
  setMode: (m: ChatMode) => Promise<void>;
  loading: boolean;
};

const ModeContext = createContext<ModeState | undefined>(undefined);

function normalizeMode(value: unknown): ChatMode {
  return value === "smalltalk" ? "smalltalk" : "mybro";
}

export function ModeProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const [mode, setModeState] = useState<ChatMode>("mybro");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("last_mode")
        .eq("user_id", userId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.error("ModeProvider: last_mode konnte nicht geladen werden", error);
      }
      setModeState(normalizeMode(data?.last_mode));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const setMode = useCallback(
    async (next: ChatMode) => {
      setModeState(next); // optimistisch
      const { error } = await supabase
        .from("profiles")
        .upsert(
          { user_id: userId, last_mode: next },
          { onConflict: "user_id" },
        );
      if (error) {
        console.error("ModeProvider: last_mode konnte nicht gespeichert werden", error);
      }
    },
    [userId],
  );

  const value = useMemo<ModeState>(
    () => ({ mode, setMode, loading }),
    [mode, setMode, loading],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeState {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode muss innerhalb von <ModeProvider> genutzt werden.");
  return ctx;
}
