import { Outlet } from "react-router-dom";
import { useOnlineStatus } from "@/lib/useOnlineStatus";

/**
 * Offline-first field-officer layout (/capture).
 * Remains fully operable offline; reads/writes go through the Dexie Local_Store
 * (wired in a later task). Shows a small connectivity indicator (Req 2.1, 2.3).
 */
export default function CaptureLayout() {
  const online = useOnlineStatus();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-semibold">OAC Cashbook — Capture</span>
        <span
          className={`text-[10px] rounded px-2 py-0.5 ${
            online
              ? "bg-green-100 text-green-700"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {online ? "Online" : "Offline — working locally"}
        </span>
      </header>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
