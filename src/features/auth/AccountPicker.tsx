import { Button } from "@/components/ui/button";
import type { OfflineUserProfile } from "@/db/schema";

interface AccountPickerProps {
  /** Offline users with a usable cached credential (already filtered by the caller). */
  users: OfflineUserProfile[];
  /** Selecting a user hands its userId back so the parent can target the PIN unlock. */
  onSelect: (userId: string) => void;
  /** Route back to the online password form ("Sign in online instead"). */
  onUsePassword: () => void;
}

/** Compact "x ago" relative time for the last-synced hint; falls back to a date. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Offline multi-user account picker (offline-pin-multiuser Req 2.1, 2.2).
 *
 * Lists the offline users that have a usable cached credential so the operator can pick
 * which account to unlock before entering a PIN. This screen renders NO PIN input and
 * calls NO auth primitive — selection simply hands the chosen userId back to the parent,
 * which drives the per-user PIN unlock. The parent is responsible for passing only users
 * with a usable credential (R2.7).
 */
export function AccountPicker({ users, onSelect, onUsePassword }: AccountPickerProps) {
  return (
    <div className="space-y-3" aria-labelledby="account-picker-heading">
      <h2 id="account-picker-heading" className="text-sm font-semibold">
        Choose an account to unlock
      </h2>

      <ul className="space-y-2" aria-label="Offline accounts">
        {users.map((u) => (
          <li key={u.userId}>
            <button
              type="button"
              onClick={() => onSelect(u.userId)}
              className="flex w-full items-center gap-3 rounded-md border p-2 text-left hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label={`Unlock ${u.email}${u.congregationName ? ` — ${u.congregationName}` : ""}`}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground"
              >
                {u.initials}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{u.email}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {u.congregationName ?? "No congregation"} · Last synced {relativeTime(u.lastSyncAt)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="ghost"
        className="w-full text-xs"
        onClick={onUsePassword}
        aria-label="Sign in online with your password instead"
      >
        Sign in online instead
      </Button>
    </div>
  );
}
