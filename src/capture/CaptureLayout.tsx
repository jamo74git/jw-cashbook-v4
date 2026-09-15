import { Outlet } from "react-router-dom";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { AppHeader } from "@/components/AppHeader";

/**
 * Offline-first field-officer layout (/capture).
 * Remains fully operable offline; reads/writes go through the Dexie Local_Store.
 * Shows the app header (with sign-out) and an offline indicator (Req 2.1, 2.3).
 */
export default function CaptureLayout() {
  const online = useOnlineStatus();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader />
      {!online && (
        <div className="bg-amber-100 text-amber-800 text-xs text-center py-1">
          Offline — working locally
        </div>
      )}
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
