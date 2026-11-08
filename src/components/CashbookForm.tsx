import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hasPermission, isOverrideAction, logSelfReviewException } from "@/lib/permissions";
import { resolveSignOff } from "@/lib/completeCapture";
import { createClient } from "@/lib/supabase/client";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { db } from "@/db/schema";
import * as capture from "@/db/captureRepo";
import { groupItemsByOfficer } from "@/lib/captureGrouping";
import type { TabKey } from "@/db/captureRepo";
import {
  sectionTotals,
  incomeTotal,
  bankedTotal,
  expensesTotal,
  isBalanced,
  monthlyExpensesExceedThreshold,
  bankingView,
  isFutureDate,
} from "@/lib/captureTotals";
import { syncPending } from "@/utils/syncEngine";
import { ProofModal, type ProofResult } from "@/capture/ProofModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LocalPeriod, LocalLineItem, OfficerLookup, ItemType } from "@/db/schema";
import type { Role } from "@/lib/types";

const TABS: TabKey[] = ["Members", "Officers", "Burial", "Expenses", "Banking"];
const R500 = 500;

interface CashbookFormProps {
  period: LocalPeriod;
  role: Role;
  officers: OfficerLookup[];
  proofMandatory: boolean;
  onChanged: () => void;
  onSaveAndReturn?: () => void; // Task 3: navigate back to the capture dashboard (no status change)
}

const money = (n: number) => `R${n.toFixed(2)}`;
const needsProof = (i: LocalLineItem) => ["EFT", "DirectDebit", "Burial", "Expense"].includes(i.item_type);
const hasProofLocally = (i: LocalLineItem) => i.proof_status === "Deposited" || i.proof_status === "Pending" || !!i.proofBlob;

// Task 6: readable, theme-aware payment-type badge (label + colour; never colour alone).
function paymentBadge(t: string): { label: string; cls: string } {
  switch (t) {
    case "EFT":
      return { label: "EFT", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" };
    case "DirectDebit":
      return { label: "DD", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" };
    case "Cash":
    case "CashPending":
      return { label: "Cash", cls: "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100" };
    case "CashBanked":
      return { label: "Cash banked", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" };
    default:
      return { label: t, cls: "bg-muted text-muted-foreground" };
  }
}

export function CashbookForm({ period, role, officers, proofMandatory, onChanged, onSaveAndReturn }: CashbookFormProps) {
  const [items, setItems] = useState<LocalLineItem[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("Members");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [elderComment, setElderComment] = useState(period.elderApprovalComment ?? "");
  const [requestorComment, setRequestorComment] = useState(period.requestorComment ?? "");
  const [proofTarget, setProofTarget] = useState<{ mode: "item" | "cash"; localId?: string } | null>(null);

  // Capture-bar form
  const [officerId, setOfficerId] = useState("");
  const [type, setType] = useState<ItemType>("EFT"); // Task 9: default EFT
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [txnDate, setTxnDate] = useState("");
  const [bankRef, setBankRef] = useState("");

  // Task 12: focused edit of an existing Members/Officers entry (period must be editable).
  const [editTarget, setEditTarget] = useState<LocalLineItem | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ localId: string; changes: Partial<LocalLineItem> } | null>(null); // Task 4: atomic proof replace
  const [deleteTarget, setDeleteTarget] = useState<LocalLineItem | null>(null); // Task 4
  const [draftPrompt, setDraftPrompt] = useState(false); // Task 3: un-added capture-bar amount
  // Task 2: per-tab capture drafts (amount/type/date/ref/bankRef) preserved across tab switches.
  const tabDrafts = useRef<Record<string, { type: ItemType; amount: string; ref: string; txnDate: string; bankRef: string }>>({});

  // Interim officer request (online-only insert; usable in capture immediately).
  const online = useOnlineStatus();
  const [addedInterim, setAddedInterim] = useState<OfficerLookup[]>([]);
  const [showInterim, setShowInterim] = useState(false);
  const [iFirst, setIFirst] = useState("");
  const [iLast, setILast] = useState("");
  const [iInitials, setIInitials] = useState("");
  const [iRank, setIRank] = useState("Priest");
  const [iReason, setIReason] = useState("");
  const [iSaving, setISaving] = useState(false);
  const [interimError, setInterimError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const editable = capture.isPeriodEditable(period);
  const canEdit = hasPermission(role, "capture.edit") && editable;
  const canSubmit = hasPermission(role, "capture.submit") && editable;
  const canRequestInterim = hasPermission(role, "officer.interim_add");
  // Complete_Capture sign-off: Treasurer by default; anyone else = recorded exception.
  const signOff = resolveSignOff(role);
  const [signOffReason, setSignOffReason] = useState("");

  // Cached officers plus any interim officers requested this session.
  const allOfficers = useMemo(() => {
    const seen = new Set(officers.map((o) => o.id));
    return [...officers, ...addedInterim.filter((o) => !seen.has(o.id))];
  }, [officers, addedInterim]);
  const priests = useMemo(() => allOfficers.filter((o) => o.rank === "Priest"), [allOfficers]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  async function submitInterim() {
    if (!iLast.trim()) return setInterimError("Surname is required");
    setISaving(true);
    setInterimError(null);
    const supabase = createClient();
    // Task 1: record the AUTHENTICATED requester (auth.uid), NOT the congregation id. Falls back
    // to the period's capturing user id if the session user can't be read.
    const { data: authData } = await supabase.auth.getUser();
    const requestedBy = authData?.user?.id ?? period.capturedByUserId;
    const officer_code = `INT-${Date.now().toString().slice(-6)}`;
    const initials = iInitials.trim() || `${iFirst.trim() ? iFirst.trim()[0].toUpperCase() + "." : ""}${iLast.trim() ? iLast.trim()[0].toUpperCase() + "." : ""}`;
    // pending_ho_approval + is_interim + request metadata. NOTE: requires these columns
    // on `officers` (or a metadata JSONB) to persist at runtime.
    const { data, error: e } = await supabase
      .from("officers")
      .insert({
        officer_code,
        first_name: iFirst.trim() || iLast.trim(),
        last_name: iLast.trim(),
        initials,
        rank: iRank,
        congregation_id: period.congregationId,
        is_active: true,
        is_interim: true,
        status: "pending_ho_approval",
        requested_by: requestedBy,
        request_reason: iReason.trim() || null,
        requested_at: new Date().toISOString(),
      })
      .select("id, congregation_id, officer_code, first_name, last_name, rank, is_active")
      .single();
    setISaving(false);
    if (e || !data) {
      const raw = e?.message ?? "Failed to request interim officer";
      // Task 6: the deployed `officers` table is missing the interim-approval columns, so
      // PostgREST rejects the whole insert. Surface an actionable message; nothing was written
      // (atomic server-side). Do NOT strip approval/attribution fields - that needs the migration.
      // Task 6: distinguish a DEFINITE client-side rejection from an AMBIGUOUS failure. A
      // PostgREST schema rejection (missing interim-approval columns) is validated before any
      // row is written -> nothing saved. Any other error (e.g. network/timeout) is ambiguous -
      // never claim it saved or failed. Never strip approval/attribution fields to mask this.
      const schemaGap = /schema cache|could not find the .*column|column .* does not exist/i.test(raw);
      setInterimError(
        schemaGap
          ? "Interim officer requests are temporarily unavailable: the server is missing the interim-approval fields (pending a database update). The request was rejected before saving, so no officer was created."
          : `The request could not be confirmed (${raw}). Do not assume it was saved or failed - check the officer list after reconnecting before retrying.`
      );
      return;
    }
    const created: OfficerLookup = { ...(data as OfficerLookup), initials, is_interim: true, status: "pending_ho_approval" };
    setAddedInterim((prev) => [...prev, created]);
    void db.officers.put(created).catch(() => {}); // cache locally so it persists for capture
    setOfficerId(created.id);
    setShowInterim(false);
    setIFirst(""); setILast(""); setIInitials(""); setIRank("Priest"); setIReason("");
    setToast(`Interim officer ${created.officer_code} requested — pending HO approval.`);
  }

  const reload = useCallback(async () => {
    setItems(await capture.getLineItems(period.localId));
  }, [period.localId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const tabList = capture.tabItems(items, activeTab);
  const totals = sectionTotals(items);
  const income = incomeTotal(items);
  const banked = bankedTotal(items);
  const expenses = expensesTotal(items);
  const balanced = isBalanced(items);
  const over500 = monthlyExpensesExceedThreshold(items, R500);
  const missingProofs = proofMandatory ? items.filter((i) => needsProof(i) && !hasProofLocally(i)) : [];
  const eligibleCash = capture.eligibleCashItems(items); // Task 8: cash/burial entries awaiting banking

  // Task 7: interim-request errors live ONLY in the interim modal. Opening clears any stale
  // error; cancel/close/backdrop clears it so it can never leak onto a capture tab.
  function openInterim() { setInterimError(null); setShowInterim(true); }
  function closeInterim() { setInterimError(null); setShowInterim(false); }

  // Task 5: switching tabs clears the transient capture-validation error and FORCES a
  // deliberate re-selection of the priest/officer for the new tab (never carry the other
  // tab's selection). Unfinished amount/date/reference drafts are intentionally preserved.
  function switchTab(t: TabKey) {
    if (t === activeTab) return;
    // Task 2: stash the current tab's unfinished draft, restore the target tab's draft (or an EFT
    // default). Officer selection is never carried - it must be chosen again for the new tab.
    tabDrafts.current[activeTab] = { type, amount, ref, txnDate, bankRef };
    const d = tabDrafts.current[t];
    setType(d?.type ?? "EFT");
    setAmount(d?.amount ?? "");
    setRef(d?.ref ?? "");
    setTxnDate(d?.txnDate ?? "");
    setBankRef(d?.bankRef ?? "");
    setActiveTab(t);
    setOfficerId("");
    setError(null);
  }

  // Task 12: edit an existing entry. Reuses capture.updateLineItem (which marks the row pending
  // so a previously-synced item is re-reconciled, not falsely acknowledged). Banked cash has no
  // authorised in-capture correction path, so it is blocked here with an explanation.
  function openEdit(item: LocalLineItem) {
    if (item.item_type === "CashBanked") {
      setToast("This cash is already marked banked and cannot be edited here; reverse the banking or use an authorised correction.");
      return;
    }
    setEditError(null);
    setEditTarget(item);
    setEditAmount(String(item.amount ?? ""));
    setEditDate(item.transaction_date ?? "");
  }
  function closeEdit() { setEditTarget(null); setEditError(null); }
  // Applies the validated amount/date change. Cash keeps its recorded capture date; EFT/DD may
  // correct the transaction date (not future). Existing proof bytes/version and historical
  // attachment metadata are untouched (Task 11). Returns false (with an inline error) if invalid.
  // Builds the validated edit payload WITHOUT committing. Cash preserves its recorded capture
  // date; EFT/DD may correct the (non-future) transaction date. Returns null + inline error if invalid.
  function buildEditChanges(): { localId: string; changes: Partial<LocalLineItem> } | null {
    if (!editTarget || !canEdit) return null;
    const amt = parseFloat(editAmount);
    if (!amt || amt <= 0) { setEditError("Amount must be > 0"); return null; }
    const isNonCash = editTarget.item_type === "EFT" || editTarget.item_type === "DirectDebit";
    if (isNonCash && !editDate) { setEditError("Transaction date is required"); return null; }
    if (isNonCash && isFutureDate(editDate)) { setEditError("Transaction date cannot be in the future."); return null; }
    return { localId: editTarget.localId, changes: isNonCash ? { amount: amt, transaction_date: editDate } : { amount: amt } };
  }
  async function saveEdit() {
    if (!editTarget) return;
    // Task 2: a proof-backed edit cannot complete via a (non-durable) confirmation - it must go
    // through "Replace proof and save" so a fresh, version-bound proof matches the new values.
    const hasProof = !!editTarget.proofBlob || editTarget.proof_status === "Deposited";
    if (hasProof) {
      setEditError('This entry has an attached proof. Use "Replace proof and save" so the evidence matches, or cancel to leave it unchanged. Durable confirmation that the existing proof still matches is not yet supported.');
      return;
    }
    const e = buildEditChanges();
    if (!e) return;
    await capture.updateLineItem(e.localId, e.changes);
    closeEdit();
    await reload();
    onChanged();
  }
  // Task 4: ATOMIC replace. Validate + stash the pending edit, then open proof capture. The
  // amount/date change is applied ONLY together with the new proof (see onProofSaved). Cancelling
  // or closing proof capture leaves the ORIGINAL transaction AND proof unchanged, so an incomplete
  // replacement can never be submitted or synced as complete.
  function replaceProofForEdit() {
    if (!editTarget) return;
    const e = buildEditChanges();
    if (!e) return;
    const id = e.localId;
    setPendingEdit(e);
    closeEdit();
    setProofTarget({ mode: "item", localId: id });
  }
  function cancelProof() { setProofTarget(null); setPendingEdit(null); }

  function resetBar() {
    setAmount("");
    setRef("");
    setTxnDate("");
    setBankRef("");
    setError(null);
  }

  async function addRow() {
    if (!canEdit) return;
    const amt = parseFloat(amount);
    if (activeTab === "Members" || activeTab === "Officers") {
      if (!officerId) return setError(`Select a ${activeTab === "Members" ? "priest" : "officer"} first`);
      // Task 5: never save against a selection that is not valid for the ACTIVE tab.
      if (!pickerOfficers.some((o) => o.id === officerId)) {
        return setError(`Select a valid ${activeTab === "Members" ? "priest" : "officer"} for this tab`);
      }
      if (!amt || amt <= 0) return setError("Amount must be > 0");
      if (["EFT", "DirectDebit"].includes(type) && !txnDate) return setError("Transaction date is required");
      if (["EFT", "DirectDebit"].includes(type) && isFutureDate(txnDate)) return setError("Transaction date cannot be in the future."); // Task 1
    }
    if (activeTab === "Burial" && !ref.trim()) return setError("Receipt number is required");
    if (activeTab === "Expenses" && !ref.trim()) return setError("Description is required");
    if ((activeTab === "Burial" || activeTab === "Expenses") && (!amt || amt <= 0)) return setError("Amount must be > 0");

    const localId = await capture.addLineItem(period.localId, activeTab as Exclude<TabKey, "Banking">, {
      officer_id: officerId || null,
      type: activeTab === "Members" || activeTab === "Officers" ? type : undefined,
      amount: amt,
      receipt_number: activeTab === "Burial" ? ref.trim() : null,
      description: activeTab === "Expenses" ? ref.trim() : null,
      transaction_date: txnDate || null,
      bank_reference: bankRef || null,
    });

    // Log override if an Elder/Chairperson is capturing via 'O'.
    if (isOverrideAction(role, "capture.create")) {
      try {
        await logSelfReviewException({
          userId: period.capturedByUserId,
          entityType: "cashbook_period",
          entityId: period.serverId ?? period.localId,
          assumedRole: "Treasurer",
          comment: `${role} captured line item (override)`,
        });
      } catch {
        /* offline: audit flushed on sync */
      }
    }
    void localId;
    resetBar();
    await reload();
    onChanged();
  }

  async function onProofSaved(result: ProofResult) {
    if (!proofTarget) return;
    if (proofTarget.mode === "cash") {
      const banked = await capture.markCashBanked(period.localId, {
        blob: result.blob,
        fileName: result.fileName,
        date: result.date,
        bankRef: result.bankRef,
      });
      // Task 8: eligibility is re-checked inside the repo transaction; 0 => nothing was banked
      // (e.g. a stale screen) and NO deposit was recorded.
      if (banked === 0) setToast("No pending cash was available to bank; no deposit was recorded.");
    } else if (proofTarget.localId) {
      // Task 4: apply any stashed amount/date edit TOGETHER with its replacement proof, so the
      // corrected values and the fresh, version-bound proof commit as one consistent change.
      if (pendingEdit && pendingEdit.localId === proofTarget.localId) {
        await capture.updateLineItem(pendingEdit.localId, pendingEdit.changes);
        setPendingEdit(null);
      }
      await capture.attachProof(proofTarget.localId, {
        blob: result.blob,
        fileName: result.fileName,
        date: result.date,
        bankRef: result.bankRef,
      });
    }
    await reload();
    onChanged();
  }

  // Task 4: confirm before deleting; block cases that cannot be deleted safely.
  function requestDelete(item: LocalLineItem) {
    if (item.serverId) {
      setToast("This entry has already synced to the server; it can't be safely deleted here (a server-side correction is required).");
      return;
    }
    if (item.item_type === "CashBanked") {
      setToast("This cash is part of a banking deposit; deleting it here would remove shared evidence. Reverse the banking first.");
      return;
    }
    setDeleteTarget(item);
  }
  async function confirmDelete() {
    if (!deleteTarget || !canEdit) return;
    const localId = deleteTarget.localId;
    setDeleteTarget(null);
    await capture.deleteLineItem(localId);
    await reload();
    onChanged();
  }

  function renderRow(item: LocalLineItem) {
    return (
      <div key={item.localId} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
        <span className="w-24 text-muted-foreground shrink-0">{item.transaction_date ?? "\u2014"}</span>
        <span className="w-24 shrink-0">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${paymentBadge(item.item_type).cls}`}>
            {paymentBadge(item.item_type).label}
          </span>
        </span>
        <span className="flex-1 text-right font-medium">{money(Number(item.amount))}</span>
        {needsProof(item) &&
          (hasProofLocally(item) ? (
            <span className="text-[10px] text-green-600">
              {item.proof_status === "Deposited" ? "Deposited" : "Saved"}
            </span>
          ) : (
            <button
              className="text-[10px] text-primary underline"
              onClick={() => setProofTarget({ mode: "item", localId: item.localId })}
              disabled={!canEdit}
            >
              Attach
            </button>
          ))}
        {canEdit && item.item_type !== "CashBanked" && (
          <button className="text-[10px] text-primary underline" aria-label="Edit entry" title="Edit entry" onClick={() => openEdit(item)}>
            Edit
          </button>
        )}
        {canEdit && item.item_type === "CashBanked" && (
          <span className="text-[10px] text-muted-foreground" title="Already banked - edit via authorised correction">banked</span>
        )}
        {canEdit && (
          <button
            className="rounded px-1 font-bold text-red-600 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:text-red-300"
            aria-label="Delete line"
            title="Delete line"
            onClick={() => requestDelete(item)}
          >
            {"\u2715"}
          </button>
        )}
      </div>
    );
  }

  // Task 3: Save draft & return. Drafts are already written to Dexie on each add/edit (local-first);
  // this verifies the local period + line items read back before navigating, warns about an un-added
  // capture-bar amount, and never submits or changes the period's business status.
  async function doSaveReturn() {
    const p = await capture.getPeriod(period.localId);
    if (!p) { setError("Could not confirm the draft was saved on this device. Stay on this page and try again."); return; }
    const its = await capture.getLineItems(period.localId);
    // Task 3: reflect the ACTUAL local sync state - never claim "not yet synced" for acknowledged
    // work, nor "synced" for pending work.
    const n = its.length;
    const base = `Draft saved on this device (${n} entr${n === 1 ? "y" : "ies"}).`;
    const sync =
      p.localStatus === "synced"
        ? " The latest changes are acknowledged by the server."
        : p.localStatus === "conflict"
          ? " A sync conflict must be resolved before the server can accept it."
          : " Changes are not yet synced to the server.";
    setToast(base + sync);
    onSaveAndReturn?.();
  }
  function onSaveReturnClick() {
    if (amount.trim() !== "") { setDraftPrompt(true); return; } // un-added capture-bar amount
    void doSaveReturn();
  }

  async function submit() {
    if (!canSubmit || !balanced) return;
    if (!signOff.eligible) return setError("You are not permitted to complete and sign off this capture.");
    if (over500 && !elderComment.trim()) return setError("Elder approval comment required for expenses over R500");
    if (proofMandatory && missingProofs.length > 0) return setError(`${missingProofs.length} proof(s) missing`);
    // Treasurer is the default signer; anyone else must record an exception reason (e.g. Treasurer ill).
    if (signOff.requiresException && !signOffReason.trim()) {
      return setError("A sign-off reason is required when the Treasurer is not signing (e.g. Treasurer ill).");
    }
    setSubmitting(true);
    if (isOverrideAction(role, "capture.submit")) {
      try {
        await logSelfReviewException({
          userId: period.capturedByUserId,
          entityType: "cashbook_period",
          entityId: period.serverId ?? period.localId,
          assumedRole: "Treasurer",
        });
      } catch {
        /* offline */
      }
    }
    // Complete_Capture: freeze the revision + Required_Manifest and record the sign-off. An
    // exception sign-off also carries actingAsRole so the mandatory ACTING_AS_TREASURER audit
    // is flushed by the Sync_Engine.
    await capture.submitPeriod(period.localId, {
      requestorComment: requestorComment.trim() || undefined,
      elderApprovalComment: elderComment.trim() || undefined,
      actingAsRole: signOff.requiresException ? signOff.signOffRole : null,
      signOff: {
        role: signOff.signOffRole ?? "Treasurer",
        isException: signOff.requiresException,
        reason: signOff.requiresException ? signOffReason.trim() : null,
        completedByUserId: period.capturedByUserId,
      },
    });
    // Actor isolation: scope the submit-triggered sync to THIS period's congregation AND the
    // authenticated actor, so a shared device never dispatches a second user's queued work under
    // the wrong identity. Falls back to the capturer id when the auth user cannot be read (offline);
    // the server (RLS) remains the authority.
    let actorUserId = period.capturedByUserId;
    try {
      const { data: authData } = await createClient().auth.getUser();
      if (authData?.user?.id) actorUserId = authData.user.id;
    } catch {
      /* offline: fall back to the capturer id; server RLS still enforces authority */
    }
    void syncPending(new Date(), period.congregationId, { actorUserId }).catch(() => {});
    setSubmitting(false);
    onChanged();
  }

  const officerLabel = (o: OfficerLookup) =>
    `${o.officer_code} - ${o.first_name}${o.last_name ? " " + o.last_name : ""}${o.is_interim ? " * (Pending HO)" : ""}`;
  const pickerOfficers = activeTab === "Members" ? priests : allOfficers;

  return (
    <div className="grid gap-3 md:grid-cols-[1fr_260px]">
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md text-xs shadow-lg">
          {toast}
        </div>
      )}

      {showInterim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeInterim}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Request Interim Officer</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[11px] text-muted-foreground">Usable in this cashbook immediately; marked <b>Pending HO</b> until Head Office approves.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label className="text-xs">Surname *</Label><Input className="h-8 text-xs" value={iLast} onChange={(e) => setILast(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">First Name</Label><Input className="h-8 text-xs" value={iFirst} onChange={(e) => setIFirst(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Initials</Label><Input className="h-8 text-xs" placeholder="auto" value={iInitials} onChange={(e) => setIInitials(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Rank *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={iRank} onChange={(e) => setIRank(e.target.value)}><option value="Priest">Priest</option><option value="Underdeacon">Underdeacon</option></select></div>
              </div>
              <div className="space-y-1"><Label className="text-xs">Reason</Label><textarea className="w-full rounded border border-input bg-background px-2 py-1 text-xs" rows={2} value={iReason} onChange={(e) => setIReason(e.target.value)} placeholder="Why is this interim officer needed?" /></div>
              {interimError && <p className="text-xs text-red-600 dark:text-red-400">{interimError}</p>}
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={closeInterim}>Cancel</Button>
                <Button size="sm" onClick={() => void submitInterim()} disabled={iSaving || !online}>{iSaving ? "Requesting…" : "Submit Request"}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeEdit}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Edit entry</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                {editTarget.item_type === "Cash"
                  ? "Cash entry - correct the amount. The recorded capture date is preserved."
                  : "Correct the amount and/or transaction date."}
              </p>
              <div className="space-y-1">
                <Label className="text-xs">Amount (R)</Label>
                <Input type="number" step="0.01" className="h-8 text-xs text-right" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
              </div>
              {(editTarget.item_type === "EFT" || editTarget.item_type === "DirectDebit") && (
                <div className="space-y-1">
                  <Label className="text-xs">Transaction Date *</Label>
                  <Input type="date" className="h-8 text-xs dark:[color-scheme:dark]" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
              )}
              {(editTarget.proofBlob || editTarget.proof_status === "Deposited") && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-2 dark:border-amber-800 dark:bg-amber-950/40">
                  <p className="text-[10px] text-amber-800 dark:text-amber-300">
                    This entry has an attached proof. A corrected amount or date can only be saved by replacing the proof
                    so the evidence matches - this app cannot durably record that the existing proof still supports the new
                    values (that is not bank verification and is not yet persisted). Otherwise cancel to leave it unchanged.
                  </p>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void replaceProofForEdit()}>Replace proof and save</Button>
                </div>
              )}
              {editError && <p className="text-xs text-red-600 dark:text-red-400">{editError}</p>}
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={closeEdit}>Cancel</Button>
                <Button size="sm" onClick={() => void saveEdit()}>Save</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteTarget(null)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Delete line?</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[11px] text-muted-foreground">This removes the entry from this device's draft. It cannot be undone.</p>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
                <Button size="sm" variant="destructive" onClick={() => void confirmDelete()}>Delete line</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {draftPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDraftPrompt(false)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Un-added amount</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                You typed an amount that has not been added with "+ Add". Your saved entries are kept on this device
                either way. Continue editing to add it, or leave without adding this amount?
              </p>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={() => setDraftPrompt(false)}>Continue editing</Button>
                <Button size="sm" onClick={() => { setDraftPrompt(false); void doSaveReturn(); }}>Leave without adding</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="min-w-0 space-y-3">
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                activeTab === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {t} ({capture.tabItems(items, t).length})
            </button>
          ))}
        </div>

        {/* Capture bar (not for Banking) */}
        {canEdit && activeTab !== "Banking" && (
          <div className="border rounded-lg p-2 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              {(activeTab === "Members" || activeTab === "Officers") && canRequestInterim && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 shrink-0 text-base font-normal leading-none"
                  disabled={!online}
                  aria-label="Request interim officer"
                  title={online ? "Request interim officer" : "Connect to request an interim officer"}
                  onClick={openInterim}
                >
                  +
                </Button>
              )}
              {(activeTab === "Members" || activeTab === "Officers") && (
                <select
                  className="h-9 rounded border border-input bg-background px-2 text-xs"
                  value={officerId}
                  onChange={(e) => setOfficerId(e.target.value)}
                >
                  <option value="">{activeTab === "Members" ? "Select Priest *" : "Select Officer *"}</option>
                  {pickerOfficers.map((o) => (
                    <option key={o.id} value={o.id}>
                      {officerLabel(o)}
                    </option>
                  ))}
                </select>
              )}
              {(activeTab === "Members" || activeTab === "Officers") && (
                <select
                  className="h-9 w-28 rounded border border-input bg-background px-2 text-xs"
                  value={type}
                  onChange={(e) => setType(e.target.value as ItemType)}
                >
                  <option value="EFT">EFT</option>
                  <option value="DirectDebit">Direct Deposit</option>
                  <option value="Cash">Cash</option>
                </select>
              )}
              {activeTab === "Burial" && (
                <Input className="h-9 text-xs w-40" placeholder="Receipt # *" value={ref} onChange={(e) => setRef(e.target.value)} />
              )}
              {activeTab === "Expenses" && (
                <>
                  <Input className="h-9 text-xs flex-1 min-w-[140px]" placeholder="Description *" value={ref} onChange={(e) => setRef(e.target.value)} />
                  <Input type="date" className="h-9 text-xs w-36 dark:[color-scheme:dark]" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
                </>
              )}
              <Input
                type="number"
                step="0.01"
                className="h-9 text-xs w-28 text-right"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Button size="sm" className="h-9 text-xs" onClick={addRow}>
                + Add
              </Button>
            </div>
            {(activeTab === "Members" || activeTab === "Officers") && ["EFT", "DirectDebit"].includes(type) && (
              <div className="grid grid-cols-2 gap-2 pt-2 border-t">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Transaction Date *</Label>
                  <Input type="date" className="h-8 text-xs dark:[color-scheme:dark]" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Bank Ref</Label>
                  <Input className="h-8 text-xs" placeholder="Optional" value={bankRef} onChange={(e) => setBankRef(e.target.value)} />
                </div>
              </div>
            )}
            {error && <p className="text-red-600 dark:text-red-400 text-[11px]">{error}</p>}
          </div>
        )}

        {/* Lists */}
        {(activeTab === "Members" || activeTab === "Officers") && (
          <p className="text-[10px] text-muted-foreground">
            Grouped by {activeTab === "Members" ? "priest" : "officer"} (by officer association). Counts are
            captured entries, not distinct people - a combined officer/spouse tithe may be one entry.
          </p>
        )}
        {(activeTab === "Members" || activeTab === "Officers") &&
          groupItemsByOfficer(tabList, pickerOfficers).map((g) => {
            const off = allOfficers.find((o) => o.id === g.officerId);
            // Task 4: a null officer_id is genuinely unassigned; a non-null id missing from the
            // loaded lookup is NOT - its name just is not cached. Never conflate the two.
            const heading =
              g.officerId === null
                ? "Unassigned (no officer linked)"
                : off
                  ? officerLabel(off)
                  : `Officer ${g.officerId.slice(0, 8)} (name not in loaded list)`;
            return (
              <div key={g.officerId ?? "unassigned"} className="rounded-lg border">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-muted/60 px-2 py-1.5 text-[11px]">
                  <span className="font-medium truncate">{heading}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span>{g.cashCount} Cash <b className="text-foreground">{money(g.cashTotal)}</b></span>
                    <span className="opacity-50">|</span>
                    <span>{g.ddCount} DD <b className="text-foreground">{money(g.ddTotal)}</b></span>
                    <span className="opacity-50">|</span>
                    <span>{g.eftCount} EFT <b className="text-foreground">{money(g.eftTotal)}</b></span>
                    {g.otherCount > 0 && (
                      <>
                        <span className="opacity-50">|</span>
                        <span className="text-amber-700 dark:text-amber-400">{g.otherCount} other <b>{money(g.otherTotal)}</b></span>
                      </>
                    )}
                    <span className="opacity-50">|</span>
                    <span className="font-semibold text-foreground">Total {money(g.subtotal)}</span>
                  </span>
                </div>
                <div className="px-2">{g.items.map((item) => renderRow(item))}</div>
              </div>
            );
          })}
        {(activeTab === "Burial" || activeTab === "Expenses") &&
          tabList.map((item) => (
            <div key={item.localId} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
              <span className="w-24 text-muted-foreground shrink-0">{item.transaction_date ?? "—"}</span>
              <span className="w-24 truncate">
                {activeTab === "Burial"
                  ? item.receipt_number
                  : activeTab === "Expenses"
                    ? item.manual_reference
                    : item.item_type === "DirectDebit"
                      ? "DD"
                      : item.item_type}
              </span>
              <span className="flex-1 text-right font-medium">{money(Number(item.amount))}</span>
              {needsProof(item) &&
                (hasProofLocally(item) ? (
                  <span className="text-[10px] text-green-600">
                    {item.proof_status === "Deposited" ? "Deposited" : "Saved"}
                  </span>
                ) : (
                  <button
                    className="text-[10px] text-primary underline"
                    onClick={() => setProofTarget({ mode: "item", localId: item.localId })}
                    disabled={!canEdit}
                  >
                    Attach
                  </button>
                ))}
              {canEdit && (
                <button className="rounded px-1 font-bold text-red-600 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:text-red-300" aria-label="Delete line" title="Delete line" onClick={() => requestDelete(item)}>
                  ✕
                </button>
              )}
            </div>
          ))}

        {/* Banking (read-only) + Mark Banked */}
        {activeTab === "Banking" && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">Banking</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {(() => {
                const bv = bankingView(items);
                const cashPendingAmt = eligibleCash.reduce((s, i) => s + Number(i.amount || 0), 0);
                return (
                  <div className="space-y-1">
                    <div className="flex justify-between"><span>EFT recorded</span><b>{money(bv.eft)}</b></div>
                    <div className="flex justify-between"><span>Direct Deposit recorded</span><b>{money(bv.directDebit)}</b></div>
                    <div className="flex justify-between"><span>Cash marked banked</span><b>{money(bv.cashBanked)}</b></div>
                    <div className="flex justify-between text-muted-foreground"><span>Cash pending (awaiting banking)</span><span>{money(cashPendingAmt)}</span></div>
                    <p className="pt-1 text-[10px] text-muted-foreground">
                      "Recorded" and "marked banked" are the Treasurer's captured values, not a bank-statement match.
                      "Cash pending" is what Mark Banked will bank (Members/Officers cash + burial cash). Expenses
                      ({money(bv.expenses)}) reduce the net deposit but are captured in the Expenses tab, not here.
                    </p>
                  </div>
                );
              })()}
              <div className="pt-2 border-t flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {eligibleCash.length > 0
                    ? "Bank all pending cash with one deposit slip:"
                    : "No pending cash to bank (EFT/DD are not banked here; already-banked cash is excluded)."}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canEdit || eligibleCash.length === 0}
                  title={eligibleCash.length === 0 ? "Nothing to bank: no pending cash or burial cash entries" : undefined}
                  onClick={() => setProofTarget({ mode: "cash" })}
                >
                  Mark Banked
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Right panel: totals + submit */}
      <div className="space-y-3">
        <Card>
          <CardHeader className="pb-1 px-3">
            <CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Totals</CardTitle>
          </CardHeader>
          <CardContent className="px-3 space-y-1 text-xs">
            <div className="flex justify-between"><span>Members</span><b>{money(totals.Members)}</b></div>
            <div className="flex justify-between"><span>Officers</span><b>{money(totals.Officers)}</b></div>
            <div className="flex justify-between"><span>Burial</span><b>{money(totals.Burial)}</b></div>
            <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>{money(income)}</span></div>
            <div className="flex justify-between text-muted-foreground"><span>Banked</span><span>{money(banked)}</span></div>
            <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>{money(expenses)}</span></div>
            <div className={`flex justify-between border-t pt-1 font-bold ${balanced ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              <span>{balanced ? "Balanced ✓" : "Not balanced"}</span>
              <span>{money(income - banked - expenses)}</span>
            </div>
          </CardContent>
        </Card>

        {/* R500 governance */}
        {over500 && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-2">
            <p className="text-[11px] font-medium text-amber-800">
              Expenses exceed R500 — Elder approval comment required before submission.
            </p>
            <Input
              className="h-8 text-xs"
              placeholder="Requestor reason"
              value={requestorComment}
              onChange={(e) => setRequestorComment(e.target.value)}
            />
            <Input
              className="h-8 text-xs"
              placeholder="Elder approval comment *"
              value={elderComment}
              onChange={(e) => setElderComment(e.target.value)}
            />
          </div>
        )}

        {onSaveAndReturn && (
          <Button variant="outline" className="w-full" onClick={onSaveReturnClick}>
            Save draft and return
          </Button>
        )}
        {/* Complete_Capture sign-off. Treasurer is the default; a non-Treasurer signer
            (e.g. the Chairperson when the Treasurer is ill) is an EXCEPTION and must record a reason. */}
        {editable && signOff.requiresException && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-2 dark:border-amber-800 dark:bg-amber-950/40">
            <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
              Treasurer sign-off is the default. You are completing this capture as an exception; a reason is
              required and recorded with the submission.
            </p>
            <Input
              className="h-8 text-xs"
              placeholder="Reason for signing as an exception (e.g. Treasurer ill) *"
              value={signOffReason}
              onChange={(e) => setSignOffReason(e.target.value)}
            />
          </div>
        )}
        {editable && (
          <Button
            className="w-full"
            disabled={
              submitting ||
              !canSubmit ||
              !signOff.eligible ||
              income === 0 ||
              !balanced ||
              (proofMandatory && missingProofs.length > 0) ||
              (over500 && !elderComment.trim()) ||
              (signOff.requiresException && !signOffReason.trim())
            }
            onClick={submit}
          >
            {submitting ? "…" : "Complete capture & submit for audit"}
          </Button>
        )}
        {!editable && (
          <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
            {period.status} — forms are locked.
          </div>
        )}
      </div>

      {proofTarget && (
        <ProofModal
          title={proofTarget.mode === "cash" ? "Mark Cash as Banked" : "Upload Proof"}
          onSave={onProofSaved}
          onClose={cancelProof}
        />
      )}
    </div>
  );
}
