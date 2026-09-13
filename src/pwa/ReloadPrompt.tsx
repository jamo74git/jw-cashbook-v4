import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * Service-worker update prompt. Because registerType is 'prompt', a new bundle waits
 * until the user accepts — an in-progress capture is never interrupted. Accepting only
 * swaps the asset precache; the Dexie/IndexedDB Local_Store is a separate storage
 * domain and is never cleared, so unsynced records survive the update (Req 1.5).
 */
export function ReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-lg border bg-background p-3 shadow-lg text-sm">
      <p className="mb-2">A new version is available.</p>
      <div className="flex gap-2">
        <button
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground"
          onClick={() => updateServiceWorker(true)}
        >
          Reload
        </button>
        <button
          className="rounded border px-3 py-1 text-xs"
          onClick={() => setNeedRefresh(false)}
        >
          Later
        </button>
      </div>
    </div>
  );
}
