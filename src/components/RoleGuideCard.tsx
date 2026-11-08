// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUIDE CARD (PRIORITY 3 — "What you can do here")
// Presentational, NON-compulsory helper card. Rendered as a dismissible, non-modal
// panel (no backdrop, no focus trap) so it never blocks the page. Two dismissals:
//   • "Got it"          — dismiss for this session
//   • "Don't show again"— persist the dismissal
// Content comes from the pure getRoleGuide map; this component makes no access
// decisions. Reusable for both the auto-shown card and the Help-opened view.
// ─────────────────────────────────────────────────────────────────────────────

import { getRoleGuide, CASHBOOK_FLOW } from "@/lib/roleGuide";
import type { Role } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function RoleGuideCard({
  role,
  onDismissSession,
  onDontShowAgain,
}: {
  role: Role;
  onDismissSession: () => void;
  onDontShowAgain: () => void;
}) {
  const guide = getRoleGuide(role);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 p-3 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:max-w-sm"
      role="region"
      aria-labelledby="role-guide-title"
    >
      <Card className="max-h-[70vh] overflow-y-auto shadow-lg">
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-4 pb-2">
          <div className="space-y-1">
            <CardTitle id="role-guide-title" className="text-base">
              What you can do here
            </CardTitle>
            <Badge variant="secondary" className="text-[10px]">{guide.role}</Badge>
          </div>
          <button
            type="button"
            onClick={onDismissSession}
            aria-label="Dismiss guide"
            className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 text-sm">
          <p className="text-muted-foreground">{guide.summary}</p>

          <ul className="list-disc space-y-1 pl-5">
            {guide.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>

          {guide.note && (
            <p className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs font-medium">
              {guide.note}
            </p>
          )}

          <div className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">How a week moves</p>
            <ol className="list-decimal space-y-0.5 pl-4">
              {CASHBOOK_FLOW.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={onDontShowAgain}>
              Don&apos;t show again
            </Button>
            <Button type="button" size="sm" onClick={onDismissSession}>
              Got it
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
