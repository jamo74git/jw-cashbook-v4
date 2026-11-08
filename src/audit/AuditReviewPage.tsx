// ─────────────────────────────────────────────────────────────────────────────
// AUDITOR DETAIL REVIEW (online-only). Sectioned review of a submitted period with
// proof viewers, a 4-section verification hard-gate, and approve/reject writes that
// use an optimistic status="Submitted" row-lock. Supabase Realtime watches the period
// for external status changes. Reuses captureTotals for all math.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import {
  getUserAccess,
  hasPermission,
  isOverrideAction,
  logSelfReviewException,
  logAuditAction,
} from "@/lib/permissions";
import {
  signoffRoleKind,
  signoffsForRevision,
  pairHasAuditor,
  signoffLabel,
  type SignoffRecord,
} from "@/audit/signoff";
import {
  bankingView,
  sectionTotals,
  incomeTotal,
  expensesTotal,
  type CaptureItem,
  type ItemType,
} from "@/lib/captureTotals";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { computeReviewReadiness } from "@/lib/completeCapture";
import { ProofLink } from "@/audit/ProofLink";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess, LineSection } from "@/lib/types";

interface Period {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service: string;
  status: string;
  week_key: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  audit_comment: string | null;
  // Revision model (PRIORITY 2 / spec Task 2) — present only once the schema is applied.
  // Default defensively so the page works before the migration lands.
  server_revision?: number | null;
  capture_generation?: number | null;
}
interface LineItem {
  id: string;
  period_id: string;
  section: string;
  officer_id: string | null;
  item_type: string;
  amount: number;
  is_officer: boolean;
  receipt_number: string | null;
  manual_reference: string | null;
  transaction_date: string | null;
}
interface Attachment {
  id: string;
  line_item_id: string;
  file_url: string;
  transaction_date: string | null;
  bank_reference: string | null;
}
interface Officer {
  id: string;
  officer_code: string;
}

const money = (n: number) => `R${n.toFixed(2)}`;
const OFFLINE_MSG = "Offline Unavailable — Please connect to a stable network to audit submissions.";

export function AuditReviewPage() {
  const { periodId } = useParams();
  const navigate = useNavigate();
  const supabase = createClient();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externallyChanged, setExternallyChanged] = useState(false);
  const [decidedAt, setDecidedAt] = useState<string | null>(null);
  // PRIORITY 2 — accepted sign-off rows for this period (resilient: empty if the sign-off
  // ledger is not yet provisioned) and the acting-auditor recorded reason.
  const [signoffs, setSignoffs] = useState<SignoffRecord[]>([]);
  const [actingReason, setActingReason] = useState("");
  const [signoffBackendReady, setSignoffBackendReady] = useState(true);

  const [checkedBanking, setCheckedBanking] = useState(false);
  const [checkedCash, setCheckedCash] = useState(false);
  const [checkedBurial, setCheckedBurial] = useState(false);
  const [checkedExpenses, setCheckedExpenses] = useState(false);
  const allChecked = checkedBanking && checkedCash && checkedBurial && checkedExpenses;

  const role = access?.role as Role | undefined;
  // PRIORITY 2 — who may SIGN OFF is matrix-routed: Auditor (primary) or Chairperson
  // (acting). Elder is NOT a signatory (its "O" is the separate drill-in override).
  const signoffKind = role ? signoffRoleKind(role) : null;
  const canSignoff = !!signoffKind;
  const canReject = role ? hasPermission(role, "audit.reject") : false;

  const load = useCallback(async () => {
    if (!periodId) return;
    setLoading(true);
    const ua = await getUserAccess();
    if (!ua) {
      setLoading(false);
      return;
    }
    setAccess(ua);
    const { data: p } = await supabase.from("cashbook_period").select("*").eq("id", periodId).single();
    if (!p) {
      setLoading(false);
      return;
    }
    setPeriod(p as Period);
    const [li, att, off] = await Promise.all([
      supabase
        .from("cashbook_line_item")
        .select("id, period_id, section, officer_id, item_type, amount, is_officer, receipt_number, manual_reference, transaction_date")
        .eq("period_id", periodId),
      supabase.from("cashbook_attachment").select("id, line_item_id, file_url, transaction_date, bank_reference"),
      supabase.from("officers").select("id, officer_code").eq("congregation_id", (p as Period).congregation_id).eq("is_active", true),
    ]);
    const lineItems = (li.data ?? []) as LineItem[];
    setItems(lineItems);
    const ids = new Set(lineItems.map((i) => i.id));
    setAttachments(((att.data ?? []) as Attachment[]).filter((a) => ids.has(a.line_item_id)));
    setOfficers((off.data ?? []) as Officer[]);
    // Task 3: decision timestamp from the audit log (truthful; null -> "Not recorded").
    if ((p as Period).status === "AuditApproved" || (p as Period).status === "Rejected") {
      const { data: dec } = await supabase
        .from("audit_log")
        .select("created_at, action_type")
        .eq("entity_id", periodId)
        .in("action_type", ["AUDIT_APPROVE", "AUDIT_REJECT"])
        .order("created_at", { ascending: false })
        .limit(1);
      setDecidedAt(dec && dec.length > 0 ? (dec[0] as { created_at: string }).created_at : null);
    } else {
      setDecidedAt(null);
    }
    // PRIORITY 2: load accepted sign-off rows from the (extended) decision ledger. The
    // table is schema-gated (authored, NOT applied); degrade gracefully if it is absent so
    // the page still renders — but FAIL CLOSED on the sign-off action (never auto-approve).
    const { data: soData, error: soErr } = await supabase
      .from("cashbook_review_decision")
      .select("actor_user_id, signoff_perm_code, acting_as_auditor, acting_reason, capture_generation, reviewed_revision, signoff_slot")
      .eq("period_id", periodId)
      .eq("decision", "signoff")
      .eq("outcome", "accepted");
    if (soErr) {
      setSignoffBackendReady(false);
      setSignoffs([]);
    } else {
      setSignoffBackendReady(true);
      setSignoffs(
        ((soData ?? []) as Record<string, unknown>[]).map((r) => ({
          actorUserId: String(r.actor_user_id),
          permCode: (r.signoff_perm_code === "O" ? "O" : "A"),
          actingAsAuditor: !!r.acting_as_auditor,
          actingReason: (r.acting_reason as string) ?? null,
          captureGeneration: Number(r.capture_generation ?? 1),
          reviewedRevision: Number(r.reviewed_revision ?? 0),
          slot: (Number(r.signoff_slot) === 2 ? 2 : 1),
        }))
      );
    }
    setLoading(false);
  }, [periodId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: watch this period for external status changes (concurrency signal).
  useEffect(() => {
    if (!periodId) return;
    const channel = supabase
      .channel(`audit-period-${periodId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "cashbook_period", filter: `id=eq.${periodId}` },
        (payload) => {
          const newStatus = (payload.new as { status?: string })?.status;
          if (newStatus && newStatus !== "Submitted") setExternallyChanged(true);
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  if (!online) return <p className="p-6 text-sm text-amber-700">{OFFLINE_MSG}</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading audit…</p>;
  if (role && !hasPermission(role, "audit.view_queue")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Auditor role required.</p>;
  }
  if (!period) return <p className="p-6 text-sm text-destructive">Period not found.</p>;

  const maskedOfficer = (id: string | null) => (id ? officers.find((o) => o.id === id)?.officer_code ?? "Officer" : "—");
  const getAtt = (id: string) => attachments.find((a) => a.line_item_id === id);

  // Reuse captureTotals math (map server rows to the CaptureItem shape).
  const ci: CaptureItem[] = items.map((i) => ({
    section: i.section as LineSection,
    item_type: i.item_type as ItemType,
    amount: Number(i.amount),
    proof_status: null,
    item_count: null,
  }));
  const bank = bankingView(ci);
  const sec = sectionTotals(ci);
  const income = incomeTotal(ci);
  const expensesT = expensesTotal(ci);

  const ddItems = items.filter((i) => i.item_type === "DirectDebit" && ["Members", "Officers"].includes(i.section));
  const eftItems = items.filter((i) => i.item_type === "EFT" && ["Members", "Officers"].includes(i.section));
  const cashBankedItems = items.filter((i) => i.item_type === "CashBanked");
  const cashPendingItems = items.filter((i) => ["Cash", "CashPending"].includes(i.item_type));
  const burialItems = items.filter((i) => i.item_type === "Burial");
  const expenseItems = items.filter((i) => i.item_type === "Expense");

  // Review_Ready gate (PRIORITY 1): `Submitted` is NOT the same as "Ready for Audit".
  // Approval opens only once evidence (every proof-required line has an attachment) AND the
  // balance verify for this revision. This is the client mirror of the server-computed
  // condition; the AUTHORITATIVE exact-revision Review_Ready is computed server-side from
  // cashbook_submission_manifest (schema-gated, NOT applied) — flag for hosted testing.
  const reviewReadiness = computeReviewReadiness(
    items.map((i) => ({ id: i.id, section: i.section, item_type: i.item_type, amount: Number(i.amount) })),
    attachments.map((a) => a.line_item_id)
  );

  // ── PRIORITY 2: two-person sign-off state for THIS exact revision ───────────
  const serverRevision = Number(period.server_revision ?? 0);
  const captureGeneration = Number(period.capture_generation ?? 1);
  const currentSignoffs = signoffsForRevision(signoffs, captureGeneration, serverRevision);
  const signoffCount = currentSignoffs.length;
  const alreadySigned = !!access && currentSignoffs.some((s) => s.actorUserId === access.user_id);
  const myPermCode: "A" | "O" | null = signoffKind === "primary" ? "A" : signoffKind === "acting" ? "O" : null;
  const wouldBeSlot: 1 | 2 = signoffCount === 0 ? 1 : 2;
  const acting = signoffKind === "acting";
  // An acting-auditor sign-off may only be the SECOND sign-off, and a valid pair must still
  // contain one real Auditor-"A". The four-section verify + Review_Ready gate the COMPLETING
  // sign-off only (design §5). The first sign-off keeps the period Submitted.
  const actingBlockedFirst = acting && wouldBeSlot === 1;
  const pairMissingAuditor =
    wouldBeSlot === 2 && myPermCode !== null && !pairHasAuditor([...currentSignoffs, { permCode: myPermCode }]);
  const reasonMissing = acting && !actingReason.trim();
  const completingVerifyBlocked = wouldBeSlot === 2 && (!allChecked || !reviewReadiness.ready);
  const signoffDisabled =
    processing ||
    !canSignoff ||
    !signoffBackendReady ||
    alreadySigned ||
    actingBlockedFirst ||
    pairMissingAuditor ||
    reasonMissing ||
    completingVerifyBlocked;

  function back() {
    const r = access?.role;
    if (r === "Elder") navigate("/elder");
    else if (r === "Chairperson") navigate("/chairperson");
    else navigate("/audit");
  }

  // PRIORITY 2: a sign-off is a call to the single decision authority (the extended
  // `cashbook_review_decision` RPC). The server records the sign-off and — ONLY on the
  // second valid, independent sign-off of this exact revision — flips the period to
  // AuditApproved inside one transaction. The client NEVER writes AuditApproved directly
  // (a direct Data-API update is rejected server-side by the trigger guard). Fail-closed:
  // any RPC error blocks and reloads; there is no fallback that could auto-approve.
  async function submitSignoff() {
    if (!period || !access || signoffDisabled) return;
    if (acting) {
      if (!window.confirm("A Chairperson acting-auditor sign-off is recorded as a SELF_REVIEW_EXCEPTION. Continue?")) return;
    }
    setProcessing(true);
    setError(null);
    const verification = {
      banking: checkedBanking,
      cash: checkedCash,
      burial: checkedBurial,
      expenses: checkedExpenses,
    };
    const fingerprint = JSON.stringify({ rev: serverRevision, gen: captureGeneration, income, expenses: expensesT, lines: items.length });
    const { data, error: e } = await supabase.rpc("cashbook_review_decision", {
      p_decision_op_id: crypto.randomUUID(),
      p_period_id: period.id,
      p_capture_generation: captureGeneration,
      p_decision: "signoff",
      p_reviewed_revision: serverRevision,
      p_payload_fingerprint: fingerprint,
      p_acting_as_auditor: acting,
      p_acting_reason: acting ? actingReason.trim() : null,
      p_reason: comment || null,
      p_verification: verification,
    });
    if (e) {
      // Fail-closed: surface the server's definitive failure (involvement, already-signed,
      // not-ready, stale, or "backend not provisioned"); do NOT fall back to a direct write.
      setError(
        signoffBackendReady
          ? e.message
          : "Two-person sign-off is not yet provisioned on this backend (migration pending)."
      );
      setProcessing(false);
      await load();
      return;
    }
    setProcessing(false);
    const status = (data as { status?: string } | null)?.status;
    if (status === "AuditApproved") {
      back();
    } else {
      // First sign-off recorded; stay to show "1 of 2" and let a second reviewer sign.
      setActingReason("");
      await load();
    }
  }

  // Rejection is unchanged from the single-decision path: an actor + a mandatory reason +
  // the reviewed revision. It is NOT gated on Review_Ready or two sign-offs, and the trigger
  // guard does not touch the Rejected transition.
  async function decide() {
    if (!period || !access) return;
    if (!canReject || !comment.trim()) return;

    if (role && isOverrideAction(role, "audit.reject")) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({
        userId: access.user_id,
        entityType: "cashbook_period",
        entityId: period.id,
        assumedRole: "Auditor",
      });
    }

    setProcessing(true);
    setError(null);

    // Optimistic row-lock: only update rows still Submitted.
    const { data, error: e } = await supabase
      .from("cashbook_period")
      .update({ status: "Rejected", audit_comment: comment })
      .eq("id", period.id)
      .eq("status", "Submitted")
      .select("id");

    if (e) {
      setError(e.message);
      setProcessing(false);
      return;
    }
    if (!data || data.length === 0) {
      setProcessing(false);
      setError("This period was already audited elsewhere. Reloading…");
      await load();
      return;
    }
    await logAuditAction({
      userId: access.user_id,
      actionType: "AUDIT_REJECT",
      entityType: "cashbook_period",
      entityId: period.id,
      comment,
    });
    setProcessing(false);
    back();
  }

  const decisionOpen = period.status === "Submitted" && !externallyChanged && (canSignoff || canReject);

  const bankingRows = (group: LineItem[], label: string) =>
    group.length === 0 ? null : (
      <>
        {group.map((item) => {
          const att = getAtt(item.id);
          return (
            <tr key={item.id} className="border-b last:border-0">
              <td className="py-1.5 pr-2">{att?.transaction_date ?? item.transaction_date ?? "—"}</td>
              <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
              <td className="py-1.5 pr-2 text-right font-medium">{money(Number(item.amount))}</td>
              <td className="py-1.5 pr-2">{maskedOfficer(item.officer_id)}</td>
              <td className="py-1.5"><ProofLink url={att?.file_url} /></td>
            </tr>
          );
        })}
        <tr className="bg-muted/50 font-bold border-t">
          <td colSpan={2} className="py-1.5 pl-2 text-[11px]">Subtotal {label}</td>
          <td className="py-1.5 text-right text-[11px]">{money(group.reduce((s, i) => s + Number(i.amount), 0))}</td>
          <td colSpan={2} />
        </tr>
      </>
    );

  // Task 3: section verification is only interactive during ACTIVE review (status Submitted). It is
  // NOT persisted, so on historical (approved/rejected) periods we show a read-only "Not recorded".
  const activeReview = period.status === "Submitted";
  const VerifyBox = ({ checked, set, label }: { checked: boolean; set: (v: boolean) => void; label: string }) =>
    activeReview ? (
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="rounded accent-green-600" />
        <span className={checked ? "text-green-700 dark:text-green-400 font-medium" : "text-muted-foreground"}>{label}</span>
      </label>
    ) : (
      <span className="text-[10px] text-muted-foreground" title="Section verification is not recorded for historical periods">Not recorded</span>
    );

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
      <Button variant="outline" size="sm" onClick={back}>← Back</Button>

      <div className="rounded-md bg-orange-50 border border-orange-200 px-4 py-3 flex items-center justify-between dark:bg-orange-950/40 dark:border-orange-800">
        <div>
          <p className="text-sm font-bold text-orange-800 dark:text-orange-300">Audit Review</p>
          <p className="text-[10px] text-orange-600 dark:text-orange-400">
            Week {period.week} · {period.service} · {period.year}/{String(period.month).padStart(2, "0")}
          </p>
        </div>
        <Badge variant="secondary" className="text-[10px]">{period.status}</Badge>
      </div>

      {externallyChanged && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          This period was updated elsewhere.{" "}
          <button className="underline" onClick={() => void load()}>Reload</button>
        </div>
      )}

      {/* Task 3: submission + decision metadata (truthful; "Not recorded" where absent). */}
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] space-y-0.5">
        <p>Submitted: <b>{period.submitted_at ? new Date(period.submitted_at).toLocaleString("en-GB") : "Not recorded"}</b></p>
        {!activeReview && (
          <>
            <p>Decision: <b>{period.status === "AuditApproved" ? "Approved" : period.status === "Rejected" ? "Rejected" : period.status}</b> on{" "}
              <b>{decidedAt ? new Date(decidedAt).toLocaleString("en-GB") : "Not recorded"}</b></p>
            <p>Decision comment: <b>{period.audit_comment || "Not recorded"}</b></p>
            <p className="text-muted-foreground">Read-only historical review. Section verification is not recorded.</p>
          </>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "EFT", val: bank.eft, count: eftItems.length },
          { label: "Direct Debit", val: bank.directDebit, count: ddItems.length },
          { label: "Cash", val: bank.cashBanked + bank.cashPending, count: cashBankedItems.length + cashPendingItems.length },
        ].map((c) => (
          <Card key={c.label} className="bg-blue-50 border-blue-200">
            <CardContent className="py-2 px-3 text-center">
              <p className="text-[10px] uppercase text-blue-600 font-medium">{c.label}</p>
              <p className="text-sm font-bold text-blue-900">{money(c.val)}</p>
              <p className="text-[10px] text-blue-500">{c.count} entries</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Panel 1: Banking Detail */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Banking Detail</CardTitle>
            <VerifyBox checked={checkedBanking} set={setCheckedBanking} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {ddItems.length + eftItems.length + cashBankedItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No electronic banking items.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="pb-1 pr-2">Date</th><th className="pb-1 pr-2">Type</th>
                  <th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Officer</th><th className="pb-1">Proof</th>
                </tr>
              </thead>
              <tbody>
                {bankingRows(ddItems, "Direct Debit")}
                {bankingRows(eftItems, "EFT")}
                {bankingRows(cashBankedItems, "Cash Banked")}
                <tr className="font-bold border-t">
                  <td colSpan={2} className="py-2">BANKING TOTAL</td>
                  <td className="py-2 text-right">{money(bank.bankingTotal)}</td><td colSpan={2} />
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 2: Cash Pending */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Cash Pending</CardTitle>
            <VerifyBox checked={checkedCash} set={setCheckedCash} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {cashPendingItems.length === 0 && burialItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pending cash.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Source</th><th className="pb-1 pr-2">Entries</th><th className="pb-1 text-right">Amount</th></tr></thead>
              <tbody>
                {cashPendingItems.length > 0 && (
                  <tr className="border-b"><td className="py-2 font-medium">Cash Income</td><td className="py-2 text-muted-foreground">{cashPendingItems.length}</td><td className="py-2 text-right font-medium">{money(cashPendingItems.reduce((s, i) => s + Number(i.amount), 0))}</td></tr>
                )}
                {burialItems.length > 0 && (
                  <tr className="border-b"><td className="py-2 font-medium">Cash Burial</td><td className="py-2 text-muted-foreground">{burialItems.length} ({burialItems.map((i) => i.receipt_number || "—").join(", ")})</td><td className="py-2 text-right font-medium">{money(sec.Burial)}</td></tr>
                )}
                <tr className="font-bold border-t bg-muted/30"><td className="py-2">TOTAL CASH</td><td /><td className="py-2 text-right">{money(bank.cashPending + sec.Burial)}</td></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 3: Burial */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Burial</CardTitle>
            <VerifyBox checked={checkedBurial} set={setCheckedBurial} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {burialItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No burial entries this period.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Receipt</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {burialItems.map((item) => {
                  const att = getAtt(item.id);
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium">{item.receipt_number || "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-medium">{money(Number(item.amount))}</td>
                      <td className="py-1.5"><ProofLink url={att?.file_url} /></td>
                    </tr>
                  );
                })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL BURIAL</td><td className="py-2 text-right">{money(sec.Burial)}</td><td /></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 4: Expenses */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Expenses</CardTitle>
            <VerifyBox checked={checkedExpenses} set={setCheckedExpenses} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {expenseItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No expenses this period.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1">Description</th><th className="pb-1 text-right pr-2">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {expenseItems.map((item) => {
                  const att = getAtt(item.id);
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">{item.manual_reference || "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-medium">{money(Number(item.amount))}</td>
                      <td className="py-1.5"><ProofLink url={att?.file_url} /></td>
                    </tr>
                  );
                })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL EXPENSES</td><td className="py-2 text-right">{money(expensesT)}</td><td /></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 5: Summary */}
      <Card className="bg-muted/30">
        <CardContent className="py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold">Grand Total (Income − Expenses)</span>
            <span className="font-bold text-lg text-primary">{money(income - expensesT)}</span>
          </div>
          <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground">
            <span>Members: {money(sec.Members)}</span>
            <span>Officers: {money(sec.Officers)}</span>
            <span>Burial: {money(sec.Burial)}</span>
            <span>Expenses: {money(expensesT)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Review_Ready separation: Submitted but not yet ready for audit sign-off. */}
      {activeReview && !reviewReadiness.ready && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300" role="status">
          <b>Submitted — not yet ready for audit.</b> Approval opens only once the revision balances and
          every required proof is present.
          {!reviewReadiness.balanced && <span> This revision does not balance.</span>}
          {reviewReadiness.missingEvidenceLineIds.length > 0 && (
            <span> {reviewReadiness.missingEvidenceLineIds.length} line(s) are missing proof evidence.</span>
          )}
          <span className="block text-[10px] text-muted-foreground">
            Rejection with a comment remains available. Authoritative readiness is verified server-side for the exact submitted revision.
          </span>
        </div>
      )}

      {/* Audit decision — TWO-PERSON SIGN-OFF (PRIORITY 2) */}
      {decisionOpen && (
        <Card className={signoffCount >= 1 ? "border-green-300" : "border-orange-200"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Audit Decision — Two-Person Sign-Off</CardTitle>
            <p className="text-[10px] text-muted-foreground">
              Two independent, eligible sign-offs are required on this revision. The period becomes
              <b> AuditApproved</b> only when the second valid sign-off is recorded.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Sign-off progress */}
            <div className="rounded border bg-muted/30 px-3 py-2 text-[11px] space-y-1" role="status">
              <p className="font-medium">Sign-offs: {signoffCount} of 2</p>
              {currentSignoffs.length === 0 ? (
                <p className="text-muted-foreground">Awaiting the first sign-off.</p>
              ) : (
                currentSignoffs
                  .slice()
                  .sort((a, b) => a.slot - b.slot)
                  .map((s, i) => (
                    <p key={i} className="text-green-700 dark:text-green-400">
                      ✓ {signoffLabel(s, s.actorUserId === access?.user_id ? "you" : undefined)}
                      {s.actingAsAuditor && s.actingReason ? ` — reason: ${s.actingReason}` : ""}
                    </p>
                  ))
              )}
            </div>

            {!signoffBackendReady && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400" role="alert">
                Two-person sign-off is not yet provisioned on this backend (migration pending). Sign-off is disabled.
              </p>
            )}

            {/* Four-section verification — gates the COMPLETING sign-off (design §5). */}
            <div className="flex gap-3 text-[10px]">
              <span className={checkedBanking ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>✓ Banking</span>
              <span className={checkedCash ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>✓ Cash</span>
              <span className={checkedBurial ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>✓ Burial</span>
              <span className={checkedExpenses ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>✓ Expenses</span>
            </div>

            {/* Signatory guidance */}
            {canSignoff ? (
              <>
                {alreadySigned && (
                  <p className="text-[11px] text-muted-foreground">
                    You have already signed off. An <b>independent</b> second reviewer must give the second sign-off.
                  </p>
                )}
                {actingBlockedFirst && (
                  <p className="text-[11px] text-orange-600 dark:text-orange-400">
                    An acting-auditor sign-off can only be the <b>second</b> sign-off — a real Auditor must sign first.
                  </p>
                )}
                {pairMissingAuditor && !actingBlockedFirst && (
                  <p className="text-[11px] text-orange-600 dark:text-orange-400">
                    A valid pair must include one real Auditor sign-off.
                  </p>
                )}
                {wouldBeSlot === 2 && completingVerifyBlocked && !alreadySigned && (
                  <p className="text-[11px] text-orange-600 dark:text-orange-400">
                    The completing sign-off needs all four sections verified and the revision Review-Ready.
                  </p>
                )}
                {acting && !alreadySigned && !actingBlockedFirst && (
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="acting-reason">Acting-auditor reason (required — e.g. only one auditor available)</Label>
                    <Input
                      id="acting-reason"
                      className="h-9 text-xs"
                      value={actingReason}
                      onChange={(e) => setActingReason(e.target.value)}
                      placeholder="Why a Chairperson is giving the second sign-off…"
                    />
                    <p className="text-[10px] text-muted-foreground">Recorded as a SELF_REVIEW_EXCEPTION in the audit log.</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Your role may review but <b>cannot give an audit sign-off</b> (oversight is not a signature). Coordinate an
                independent second reviewer; the capture stays pending until two valid sign-offs are obtained.
              </p>
            )}

            <div className="space-y-1">
              <Label className="text-xs">Comment {canReject ? "(mandatory for rejection)" : "(optional)"}</Label>
              <Input className="h-9 text-xs" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Audit comment…" />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-3">
              {canSignoff && !alreadySigned && (
                <Button size="sm" className="bg-green-700 text-white hover:bg-green-800" onClick={() => void submitSignoff()} disabled={signoffDisabled}>
                  {processing
                    ? "…"
                    : wouldBeSlot === 1
                    ? "Give sign-off (1 of 2)"
                    : acting
                    ? "Second sign-off (acting auditor)"
                    : "Second sign-off — approve"}
                </Button>
              )}
              {canReject && (
                <Button size="sm" variant="destructive" onClick={() => void decide()} disabled={processing || !comment.trim()}>
                  {processing ? "…" : "Reject"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
