import { useCallback, useEffect, useMemo, useState } from "react";
import { hasPermission, isOverrideAction, logSelfReviewException } from "@/lib/permissions";
import * as capture from "@/db/captureRepo";
import type { TabKey } from "@/db/captureRepo";
import {
  sectionTotals,
  incomeTotal,
  bankedTotal,
  expensesTotal,
  isBalanced,
  monthlyExpensesExceedThreshold,
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
}

const money = (n: number) => `R${n.toFixed(2)}`;
const needsProof = (i: LocalLineItem) => ["EFT", "DirectDebit", "Burial", "Expense"].includes(i.item_type);
const hasProofLocally = (i: LocalLineItem) => i.proof_status === "uploaded" || !!i.proofBlob;

export function CashbookForm({ period, role, officers, proofMandatory, onChanged }: CashbookFormProps) {
  const [items, setItems] = useState<LocalLineItem[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("Members");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [elderComment, setElderComment] = useState(period.elderApprovalComment ?? "");
  const [requestorComment, setRequestorComment] = useState(period.requestorComment ?? "");
  const [proofTarget, setProofTarget] = useState<{ mode: "item" | "cash"; localId?: string } | null>(null);

  // Capture-bar form
  const [officerId, setOfficerId] = useState("");
  const [type, setType] = useState<ItemType>("Cash");
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [txnDate, setTxnDate] = useState("");
  const [bankRef, setBankRef] = useState("");

  const editable = capture.isPeriodEditable(period);
  const canEdit = hasPermission(role, "capture.edit") && editable;
  const canSubmit = hasPermission(role, "capture.submit") && editable;

  const priests = useMemo(() => officers.filter((o) => o.rank === "Priest"), [officers]);

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
      if (!officerId) return setError("Select an officer first");
      if (!amt || amt <= 0) return setError("Amount must be > 0");
      if (["EFT", "DirectDebit"].includes(type) && !txnDate) return setError("Transaction date is required");
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
      await capture.markCashBanked(period.localId, {
        blob: result.blob,
        fileName: result.fileName,
        date: result.date,
        bankRef: result.bankRef,
      });
    } else if (proofTarget.localId) {
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

  async function del(localId: string) {
    if (!canEdit) return;
    await capture.deleteLineItem(localId);
    await reload();
    onChanged();
  }

  async function submit() {
    if (!canSubmit || !balanced) return;
    if (over500 && !elderComment.trim()) return setError("Elder approval comment required for expenses over R500");
    if (proofMandatory && missingProofs.length > 0) return setError(`${missingProofs.length} proof(s) missing`);
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
    await capture.submitPeriod(period.localId, {
      requestorComment: requestorComment.trim() || undefined,
      elderApprovalComment: elderComment.trim() || undefined,
    });
    void syncPending().catch(() => {});
    setSubmitting(false);
    onChanged();
  }

  const officerLabel = (o: OfficerLookup) =>
    `${o.officer_code} - ${o.first_name}${o.last_name ? " " + o.last_name : ""}`;
  const pickerOfficers = activeTab === "Members" ? priests : officers;

  return (
    <div className="grid gap-3 md:grid-cols-[1fr_260px]">
      <div className="min-w-0 space-y-3">
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
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
                  <option value="Cash">Cash</option>
                  <option value="DirectDebit">Direct Deposit</option>
                </select>
              )}
              {activeTab === "Burial" && (
                <Input className="h-9 text-xs w-40" placeholder="Receipt # *" value={ref} onChange={(e) => setRef(e.target.value)} />
              )}
              {activeTab === "Expenses" && (
                <>
                  <Input className="h-9 text-xs flex-1 min-w-[140px]" placeholder="Description *" value={ref} onChange={(e) => setRef(e.target.value)} />
                  <Input type="date" className="h-9 text-xs w-36" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
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
                  <Input type="date" className="h-8 text-xs" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Bank Ref</Label>
                  <Input className="h-8 text-xs" placeholder="Optional" value={bankRef} onChange={(e) => setBankRef(e.target.value)} />
                </div>
              </div>
            )}
            {error && <p className="text-destructive text-[11px]">{error}</p>}
          </div>
        )}

        {/* Lists */}
        {activeTab !== "Banking" &&
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
                    {item.proof_status === "uploaded" ? "Uploaded" : "Saved"}
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
                <button className="text-destructive" onClick={() => del(item.localId)}>
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
                const b = bankedTotal;
                void b;
                return null;
              })()}
              <div className="flex justify-between">
                <span>Banked (EFT + DD + Cash Banked)</span>
                <b>{money(banked)}</b>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Cash Pending (not yet banked)</span>
                <span>{money(income - banked - 0)}</span>
              </div>
              <div className="pt-2 border-t flex items-center justify-between">
                <span className="text-muted-foreground">Bank all pending cash with one deposit slip:</span>
                <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => setProofTarget({ mode: "cash" })}>
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
            <div className={`flex justify-between border-t pt-1 font-bold ${balanced ? "text-green-700" : "text-destructive"}`}>
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

        {editable && (
          <Button
            className="w-full"
            disabled={
              submitting ||
              !canSubmit ||
              income === 0 ||
              !balanced ||
              (proofMandatory && missingProofs.length > 0) ||
              (over500 && !elderComment.trim())
            }
            onClick={submit}
          >
            {submitting ? "…" : "Submit for Audit"}
          </Button>
        )}
        {!editable && (
          <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">
            {period.status} — forms are locked.
          </div>
        )}
      </div>

      {proofTarget && (
        <ProofModal
          title={proofTarget.mode === "cash" ? "Mark Cash as Banked" : "Upload Proof"}
          onSave={onProofSaved}
          onClose={() => setProofTarget(null)}
        />
      )}
    </div>
  );
}
