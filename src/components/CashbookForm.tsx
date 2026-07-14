"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hasPermission, isOverrideAction, logSelfReviewException } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Role, CashbookLineItem, Officer, IncomeType, LineSection } from "@/lib/types";

interface CashbookFormProps {
  serviceId: string;
  lineItems: CashbookLineItem[];
  officers: Officer[];
  isLocked: boolean;
  role: Role;
  onUpdate: () => void;
}

const SECTIONS: LineSection[] = ["Members", "Officers", "Burial", "Expenses"];
const INCOME_TYPES: IncomeType[] = ["Cash", "EFT", "DirectDebit"];

export function CashbookForm({
  serviceId,
  lineItems,
  officers,
  isLocked,
  role,
  onUpdate,
}: CashbookFormProps) {
  const supabase = createClient();
  const [saving, setSaving] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState<string | null>(null);

  // Group items by section
  const groupedItems = SECTIONS.reduce(
    (acc, section) => {
      acc[section] = lineItems.filter((item) => item.section === section);
      return acc;
    },
    {} as Record<string, CashbookLineItem[]>
  );

  // ── Permission checks ───────────────────────────────────────────────────
  const canCreate = hasPermission(role, "capture.create");
  const canEdit = hasPermission(role, "capture.edit") && !isLocked;

  // ── Field Update ────────────────────────────────────────────────────────
  async function handleFieldUpdate(
    itemId: string,
    field: string,
    value: string | number | null
  ) {
    if (!canEdit) return;
    setSaving(itemId);
    await supabase
      .from("cashbook_line_item")
      .update({ [field]: value })
      .eq("id", itemId);
    setSaving(null);
    onUpdate();
  }

  // ── Income Type Change (clears proof if Cash) ───────────────────────────
  async function handleIncomeTypeChange(item: CashbookLineItem, newType: IncomeType) {
    if (!canEdit) return;
    setSaving(item.id);
    const updates: Record<string, unknown> = { income_type: newType };
    if (newType === "Cash") {
      updates.item_count = null;
      updates.proof_status = null;
      updates.proof_image_url = null;
    }
    await supabase
      .from("cashbook_line_item")
      .update(updates)
      .eq("id", item.id);
    setSaving(null);
    onUpdate();
  }

  // ── Photo Upload (required if IncomeType != Cash) ───────────────────────
  async function handlePhotoUpload(item: CashbookLineItem, file: File) {
    if (!canEdit) return;
    setPhotoUploading(item.id);

    const filePath = `proofs/${serviceId}/${item.id}_${Date.now()}.${file.name.split(".").pop()}`;
    const { error: uploadError } = await supabase.storage
      .from("proof-images")
      .upload(filePath, file);

    if (uploadError) {
      setPhotoUploading(null);
      return;
    }

    const { data: urlData } = supabase.storage
      .from("proof-images")
      .getPublicUrl(filePath);

    await supabase
      .from("cashbook_line_item")
      .update({
        proof_image_url: urlData.publicUrl,
        proof_status: "Uploaded",
      })
      .eq("id", item.id);

    setPhotoUploading(null);
    onUpdate();
  }

  // ── Add Row ─────────────────────────────────────────────────────────────
  async function handleAddRow(section: LineSection) {
    if (!canCreate && !canEdit) return;

    // If override action, log it
    if (isOverrideAction(role, "capture.create")) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await logSelfReviewException({
          userId: user.id,
          entityType: "cashbook_service",
          entityId: serviceId,
          assumedRole: "Treasurer",
          comment: `${role} created line item (override)`,
        });
      }
    }

    await supabase.from("cashbook_line_item").insert({
      service_id: serviceId,
      section,
      officer_id: null,
      officer_code: null,
      income_type: section === "Expenses" ? "Cash" : "EFT",
      amount: 0,
      item_count: null,
      manual_reference: null,
      proof_status: null,
      proof_image_url: null,
    });
    onUpdate();
  }

  // ── Delete Row ──────────────────────────────────────────────────────────
  async function handleDeleteRow(itemId: string) {
    if (!canEdit) return;
    await supabase.from("cashbook_line_item").delete().eq("id", itemId);
    onUpdate();
  }

  // ── Conditional display logic ───────────────────────────────────────────
  function showCount(item: CashbookLineItem): boolean {
    return item.income_type === "EFT" || item.income_type === "DirectDebit";
  }

  function requiresProof(item: CashbookLineItem): boolean {
    // Photo required if IncomeType != Cash (Members/Officers)
    // Also required for Burial (receipt) and Expenses (receipt)
    if (item.section === "Burial" || item.section === "Expenses") return true;
    return item.income_type !== "Cash" && item.income_type !== null;
  }

  function showManualReference(item: CashbookLineItem): boolean {
    return item.section === "Burial";
  }

  function needsOfficerCode(section: LineSection): boolean {
    return section === "Members" || section === "Officers";
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {SECTIONS.map((section) => (
        <Card key={section}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {section === "Members" ? "Members Tithing" :
               section === "Officers" ? "Officers Tithing" :
               section === "Burial" ? "Burial Offering" : "Expenses"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Table header (desktop) */}
            <div className="hidden sm:grid sm:grid-cols-12 gap-2 mb-2 text-xs font-medium text-muted-foreground">
              {needsOfficerCode(section) && <div className="col-span-2">Officer</div>}
              <div className={needsOfficerCode(section) ? "col-span-2" : "col-span-2"}>Type</div>
              {section !== "Expenses" && <div className="col-span-1">Count</div>}
              <div className="col-span-2">Amount (R)</div>
              {showManualReference({ section } as CashbookLineItem) && <div className="col-span-2">Receipt #</div>}
              <div className="col-span-2">Proof</div>
              <div className="col-span-1" />
            </div>

            {/* Rows */}
            {groupedItems[section]?.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-3 items-end border-b pb-3 last:border-0 last:pb-0"
              >
                {/* Officer Code Dropdown (Members/Officers only) */}
                {needsOfficerCode(section) && (
                  <div className="sm:col-span-2">
                    <Label className="sm:hidden text-xs">Officer</Label>
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                      value={item.officer_code ?? ""}
                      onChange={(e) => {
                        const selectedOfficer = officers.find((o) => o.officer_code === e.target.value);
                        handleFieldUpdate(item.id, "officer_code", e.target.value);
                        if (selectedOfficer) {
                          handleFieldUpdate(item.id, "officer_id", selectedOfficer.id);
                        }
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

                {/* Income Type / Payment Type */}
                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Type</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                    value={item.income_type ?? "Cash"}
                    onChange={(e) => handleIncomeTypeChange(item, e.target.value as IncomeType)}
                    disabled={!canEdit}
                  >
                    {INCOME_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                {/* Count (only for EFT/DirectDebit) */}
                {section !== "Expenses" && (
                  <div className="sm:col-span-1">
                    <Label className="sm:hidden text-xs">Count</Label>
                    <Input
                      type="number"
                      min="0"
                      value={showCount(item) ? (item.item_count ?? "") : ""}
                      onChange={(e) =>
                        handleFieldUpdate(item.id, "item_count", parseInt(e.target.value) || 0)
                      }
                      disabled={!canEdit || !showCount(item)}
                      placeholder={showCount(item) ? "0" : "-"}
                    />
                  </div>
                )}

                {/* Amount */}
                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Amount (R)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.amount ?? ""}
                    onChange={(e) =>
                      handleFieldUpdate(item.id, "amount", parseFloat(e.target.value) || 0)
                    }
                    disabled={!canEdit}
                    placeholder="0.00"
                  />
                </div>

                {/* Manual Reference (Burial only) */}
                {showManualReference(item) && (
                  <div className="sm:col-span-2">
                    <Label className="sm:hidden text-xs">Receipt #</Label>
                    <Input
                      type="text"
                      value={item.manual_reference ?? ""}
                      onChange={(e) =>
                        handleFieldUpdate(item.id, "manual_reference", e.target.value || null)
                      }
                      disabled={!canEdit}
                      placeholder="Receipt #"
                    />
                  </div>
                )}

                {/* Proof Upload */}
                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Proof</Label>
                  {requiresProof(item) ? (
                    <div className="space-y-1">
                      {item.proof_image_url ? (
                        <span className="text-xs text-green-600 font-medium">Uploaded</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <label className="cursor-pointer text-xs bg-primary text-primary-foreground px-2 py-1 rounded-md hover:bg-primary/90">
                            {photoUploading === item.id ? "..." : "Upload"}
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handlePhotoUpload(item, file);
                              }}
                              disabled={!canEdit || photoUploading === item.id}
                            />
                          </label>
                          {item.income_type !== "Cash" && (
                            <span className="text-xs text-destructive">Required</span>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground block h-10 leading-10">—</span>
                  )}
                </div>

                {/* Delete */}
                <div className="sm:col-span-1 flex items-center">
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDeleteRow(item.id)}
                      disabled={saving === item.id}
                    >
                      X
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {/* Add row */}
            {(canCreate || canEdit) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAddRow(section)}
                className="mt-2"
              >
                + Add {section === "Burial" ? "Burial Offering" : section} Row
              </Button>
            )}

            {/* Section total */}
            <div className="mt-3 pt-3 border-t flex justify-between text-sm">
              <span className="font-medium">
                Total {section === "Members" ? "Members" :
                       section === "Officers" ? "Officers" :
                       section === "Burial" ? "Burial" : "Expenses"}:
              </span>
              <span className="font-semibold">
                R{(groupedItems[section] ?? []).reduce((s, i) => s + (i.amount ?? 0), 0).toFixed(2)}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
