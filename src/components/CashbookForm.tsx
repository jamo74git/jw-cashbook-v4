import { useCallback, useEffect, useState } from "react";
import { hasPermission, isOverrideAction } from "@/lib/permissions";
import { getSession } from "@/services/authService";
import * as capture from "@/db/captureRepo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { QueuedLineItem, OfficerLookup } from "@/db/schema";
import type { Role, IncomeType, LineSection } from "@/lib/types";

interface CashbookFormProps {
  serviceLocalId: string;
  congregationId: string;
  isLocked: boolean;
  role: Role;
}

const SECTIONS: LineSection[] = ["Members", "Officers", "Burial", "Expenses"];
const INCOME_TYPES: IncomeType[] = ["Cash", "EFT", "DirectDebit"];

/**
 * Offline-first cashbook capture form. All reads/writes go to the Dexie Local_Store
 * via captureRepo — zero network latency. The Sync_Engine reconciles to Supabase
 * later. Proof images are stored locally as Blobs and uploaded on sync.
 */
export function CashbookForm({ serviceLocalId, congregationId, isLocked, role }: CashbookFormProps) {
  const [items, setItems] = useState<QueuedLineItem[]>([]);
  const [officers, setOfficers] = useState<OfficerLookup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setItems(await capture.getLineItems(serviceLocalId));
  }, [serviceLocalId]);

  useEffect(() => {
    void reload();
    void capture.listOfficers(congregationId).then(setOfficers);
  }, [reload, congregationId]);

  const canCreate = hasPermission(role, "capture.create");
  const canEdit = hasPermission(role, "capture.edit") && !isLocked;

  const grouped = SECTIONS.reduce((acc, section) => {
    acc[section] = items.filter((i) => i.section === section);
    return acc;
  }, {} as Record<LineSection, QueuedLineItem[]>);

  async function updateField(localId: string, changes: Partial<QueuedLineItem>) {
    if (!canEdit) return;
    setBusy(localId);
    await capture.updateLineItem(localId, changes);
    await reload();
    setBusy(null);
  }

  async function changeIncomeType(localId: string, type: IncomeType) {
    if (!canEdit) return;
    setBusy(localId);
    await capture.setIncomeType(localId, type);
    await reload();
    setBusy(null);
  }

  async function attachProof(localId: string, file: File) {
    if (!canEdit) return;
    setBusy(localId);
    await capture.setLocalProof(localId, file, file.name);
    await reload();
    setBusy(null);
  }

  async function addRow(section: LineSection) {
    if (!canCreate && !canEdit) return;
    // Elder/Chairperson acting via an Override permission -> queue an audited exception.
    if (isOverrideAction(role, "capture.create")) {
      const session = getSession();
      if (session) {
        await capture.queueOverrideAudit({
          serviceLocalId,
          congregationId,
          userId: session.userId,
          role,
          assumedRole: "Treasurer",
          comment: `${role} created line item (override)`,
        });
      }
    }
    await capture.addLineItem(serviceLocalId, section);
    await reload();
  }

  async function deleteRow(localId: string) {
    if (!canEdit) return;
    await capture.deleteLineItem(localId);
    await reload();
  }

  const showCount = (i: QueuedLineItem) => i.income_type === "EFT" || i.income_type === "DirectDebit";
  const requiresProof = (i: QueuedLineItem) =>
    i.section === "Burial" || i.section === "Expenses" || (i.income_type !== "Cash" && i.income_type !== null);
  const showManualReference = (i: QueuedLineItem) => i.section === "Burial";
  const needsOfficerCode = (s: LineSection) => s === "Members" || s === "Officers";
  const sectionTitle = (s: LineSection) =>
    s === "Members" ? "Members Tithing" : s === "Officers" ? "Officers Tithing" : s === "Burial" ? "Burial Offering" : "Expenses";

  return (
    <div className="space-y-6">
      {SECTIONS.map((section) => (
        <Card key={section}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{sectionTitle(section)}</CardTitle>
          </CardHeader>
          <CardContent>
            {grouped[section]?.map((item) => (
              <div
                key={item.localId}
                className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-3 items-end border-b pb-3 last:border-0 last:pb-0"
              >
                {needsOfficerCode(section) && (
                  <div className="sm:col-span-2">
                    <Label className="sm:hidden text-xs">Officer</Label>
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                      value={item.officer_code ?? ""}
                      onChange={(e) => {
                        const off = officers.find((o) => o.officer_code === e.target.value);
                        void updateField(item.localId, {
                          officer_code: e.target.value,
                          officer_id: off?.id ?? null,
                        });
                      }}
                      disabled={!canEdit}
                    >
                      <option value="">Select...</option>
                      {officers.map((o) => (
                        <option key={o.id} value={o.officer_code}>
                          {o.officer_code}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Type</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                    value={item.income_type ?? "Cash"}
                    onChange={(e) => void changeIncomeType(item.localId, e.target.value as IncomeType)}
                    disabled={!canEdit}
                  >
                    {INCOME_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                {section !== "Expenses" && (
                  <div className="sm:col-span-1">
                    <Label className="sm:hidden text-xs">Count</Label>
                    <Input
                      type="number"
                      min="0"
                      value={showCount(item) ? item.item_count ?? "" : ""}
                      onChange={(e) => void updateField(item.localId, { item_count: parseInt(e.target.value) || 0 })}
                      disabled={!canEdit || !showCount(item)}
                      placeholder={showCount(item) ? "0" : "-"}
                    />
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Amount (R)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.amount ?? ""}
                    onChange={(e) => void updateField(item.localId, { amount: parseFloat(e.target.value) || 0 })}
                    disabled={!canEdit}
                    placeholder="0.00"
                  />
                </div>

                {showManualReference(item) && (
                  <div className="sm:col-span-2">
                    <Label className="sm:hidden text-xs">Receipt #</Label>
                    <Input
                      type="text"
                      value={item.manual_reference ?? ""}
                      onChange={(e) => void updateField(item.localId, { manual_reference: e.target.value || null })}
                      disabled={!canEdit}
                      placeholder="Receipt #"
                    />
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Proof</Label>
                  {requiresProof(item) ? (
                    <div className="space-y-1">
                      {item.proof_image_url ? (
                        <span className="text-xs text-green-600 font-medium">Uploaded</span>
                      ) : item.proofBlob ? (
                        <span className="text-xs text-amber-600 font-medium">Saved (will upload)</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <label className="cursor-pointer text-xs bg-primary text-primary-foreground px-2 py-1 rounded-md hover:bg-primary/90">
                            {busy === item.localId ? "..." : "Upload"}
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void attachProof(item.localId, file);
                              }}
                              disabled={!canEdit || busy === item.localId}
                            />
                          </label>
                          {item.income_type !== "Cash" && <span className="text-xs text-destructive">Required</span>}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground block h-10 leading-10">—</span>
                  )}
                </div>

                <div className="sm:col-span-1 flex items-center">
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void deleteRow(item.localId)}
                      disabled={busy === item.localId}
                    >
                      X
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {(canCreate || canEdit) && (
              <Button variant="outline" size="sm" onClick={() => void addRow(section)} className="mt-2">
                + Add {section === "Burial" ? "Burial Offering" : section} Row
              </Button>
            )}

            <div className="mt-3 pt-3 border-t flex justify-between text-sm">
              <span className="font-medium">Total {section}:</span>
              <span className="font-semibold">
                R{(grouped[section] ?? []).reduce((s, i) => s + (i.amount ?? 0), 0).toFixed(2)}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
