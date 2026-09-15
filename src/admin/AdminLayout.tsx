import { Outlet } from "react-router-dom";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { AppHeader } from "@/components/AppHeader";

/**
 * Online-only Head Office layout (/admin).
 * Reads live from Supabase. When offline, it renders an explicit offline-unavailable
 * state and exposes no administrative data or Local_Store reads (Req 2.4, 2.5).
 */
export default function AdminLayout() {
  const online = useOnlineStatus();

  if (!online) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="max-w-sm text-center space-y-2">
          <h1 className="text-lg font-bold">Head Office is online-only</h1>
          <p className="text-sm text-muted-foreground">
            The admin dashboard needs a live connection to Supabase. Reconnect to
            continue. No administrative data is available offline.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader />
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
