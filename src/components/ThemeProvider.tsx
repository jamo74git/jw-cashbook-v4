"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const ua = await getUserAccess();
      if (!ua?.congregation_id) return;

      const { data: settings } = await supabase
        .from("congregation_settings")
        .select("theme_default")
        .eq("congregation_id", ua.congregation_id)
        .maybeSingle();

      if (settings?.theme_default === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    })();
  }, []);

  return <>{children}</>;
}
