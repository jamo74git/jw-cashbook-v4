// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC LANDING PAGE (PRIORITY 3)
// Unauthenticated route at "/". Explains what Cashbook does and the capture -> submit
// -> audit flow, states the roles explicitly (Treasurer default; Chairperson exception
// only; no one signs their own preparation), and offers a sign-in control top-right.
// Mobile-first, built from the existing shadcn/ui primitives. No access decisions here.
// ─────────────────────────────────────────────────────────────────────────────

import { Link } from "react-router-dom";
import { CASHBOOK_FLOW } from "@/lib/roleGuide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const FLOW_STEPS: { title: string; body: string }[] = [
  { title: "Capture", body: CASHBOOK_FLOW[0] },
  { title: "Submit", body: CASHBOOK_FLOW[1] },
  { title: "Audit", body: CASHBOOK_FLOW[2] },
];

const ROLE_SUMMARY: { role: string; body: string }[] = [
  {
    role: "Treasurer",
    body: "Keeps the weekly cashbook and is the default sign-off when completing a capture.",
  },
  {
    role: "Chairperson",
    body: "Steps in only as a recorded exception when the Treasurer cannot act — not the normal signer.",
  },
  {
    role: "Auditor",
    body: "Reviews the submitted revision; two eligible auditors sign off before it is approved.",
  },
  {
    role: "Elder / Overseer / HO",
    body: "Oversee, submit the month onward, and administer access — oversight is not an audit signature.",
  },
];

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar with the sign-in control top-right. */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded bg-primary text-[9px] font-bold text-primary-foreground"
              aria-label="OAC"
            >
              OAC
            </div>
            <span className="text-sm font-semibold text-primary">OAC Cashbook</span>
          </div>
          <Button asChild size="sm">
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-12 px-4 py-10">
        {/* Hero */}
        <section className="space-y-4 text-center sm:space-y-5 sm:py-6">
          <h1 className="text-2xl font-bold tracking-tight sm:text-4xl">
            The congregation cashbook, captured and audited with confidence
          </h1>
          <p className="mx-auto max-w-2xl text-sm text-muted-foreground sm:text-base">
            OAC Cashbook records each week&apos;s offerings, banking and expenses on the
            device — even offline — then carries the work through submission and
            two-person audit sign-off before it is approved.
          </p>
          <div className="flex justify-center">
            <Button asChild size="lg">
              <Link to="/login">Sign in to continue</Link>
            </Button>
          </div>
        </section>

        {/* Flow: capture -> submit -> audit */}
        <section className="space-y-4">
          <h2 className="text-center text-lg font-semibold">How a week moves</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {FLOW_STEPS.map((step, i) => (
              <Card key={step.title}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                      {i + 1}
                    </span>
                    {step.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{step.body}</CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Roles — explicit about sign-off */}
        <section className="space-y-4">
          <h2 className="text-center text-lg font-semibold">Who does what</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {ROLE_SUMMARY.map((r) => (
              <Card key={r.role}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{r.role}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{r.body}</CardContent>
              </Card>
            ))}
          </div>
          <p className="mx-auto max-w-2xl rounded-md border border-primary/30 bg-primary/5 p-3 text-center text-sm font-medium">
            No one signs off their own preparation. Audit approval needs two independent,
            eligible sign-offs against the exact submitted revision.
          </p>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto max-w-5xl px-4 py-6 text-center text-xs text-muted-foreground">
          OAC Cashbook · <Link to="/login" className="text-primary underline">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
