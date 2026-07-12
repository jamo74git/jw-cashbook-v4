"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type PaymentType = "EFT" | "DirectDebit" | "Cash";

interface LineItem {
  id: string;
  period_id: string;
  section: string;
  officer_id: string;
  payment_type: PaymentType | null;
  item_count: number | null;
  amount: number;
  manual_reference: string | null;
  proof_status: string | null;
}

interface CashbookFormProps {
  periodId: string;
  lineItems: LineItem[];
  isLocked: boolean;
  onUpdate: () => void;
}

const SECTIONS = ["Members", "Officers", "Burial", "Expenses"] as const;
const PAYMENT_TYPES: PaymentType[] = ["EFT", "DirectDebit", "Cash"];

export function CashbookForm({ periodId, lineItems, isLocked, onUpdate }: CashbookFormProps) {
  const supabase = createClient();
  const [saving, setSaving] = useState<string | null>(null);

  // Group items by section
  const groupedItems = SECTIONS.reduce(
    (acc, section) => {
      acc[section] = lineItems.filter((item) => item.section === section);
      return acc;
    },
    {} as Record<string, LineItem[]>
  );

  async function handleFieldUpdate(
    itemId: string,
    field: string,
    value: string | number | null
  ) {
    if (isLocked) return;
    setSaving(itemId);

    await supabase
      .from("cashbook_line_item")
      .update({ [field]: value })
      .eq("id", itemId);

    setSaving(null);
    onUpdate();
  }

  async function handlePaymentTypeChange(item: LineItem, newType: PaymentType) {
    if (isLocked) return;
    setSaving(item.id);

    const updates: Record<string, unknown> = { payment_type: newType };

    // If Cash, clear count and proof_status
    if (newType === "Cash") {
      updates.item_count = null;
      updates.proof_status = null;
    }

    await supabase
      .from("cashbook_line_item")
      .update(updates)
      .eq("id", item.id);

    setSaving(null);
    onUpdate();
  }

  async function handleAddRow(section: string) {
    if (isLocked) return;

    await supabase.from("cashbook_line_item").insert({
      period_id: periodId,
      section,
      officer_id: "",
      payment_type: section === "Expenses" ? "Cash" : "EFT",
      item_count: null,
      amount: 0,
      manual_reference: null,
      proof_status: null,
    });

    onUpdate();
  }

  async function handleDeleteRow(itemId: string) {
    if (isLocked) return;

    await supabase.from("cashbook_line_item").delete().eq("id", itemId);
    onUpdate();
  }

  function showCount(item: LineItem): boolean {
    return item.payment_type === "EFT" || item.payment_type === "DirectDebit";
  }

  function showProof(item: LineItem): boolean {
    if (item.payment_type === "Cash" && !["Burial", "Expenses"].includes(item.section)) {
      return false;
    }
    return (
      item.payment_type === "EFT" ||
      item.payment_type === "DirectDebit" ||
      item.section === "Burial" ||
      item.section === "Expenses"
    );
  }

  function showManualReference(item: LineItem): boolean {
    return item.section === "Burial";
  }

  return (
    <div className="space-y-6">
      {SECTIONS.map((section) => (
        <Card key={section}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{section}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Table header */}
            <div className="hidden sm:grid sm:grid-cols-12 gap-2 mb-2 text-xs font-medium text-muted-foreground">
              <div className="col-span-2">Payment Type</div>
              <div className="col-span-2">Count</div>
              <div className="col-span-2">Amount (R)</div>
              {section === "Burial" && <div className="col-span-2">Receipt #</div>}
              <div className="col-span-2">Proof</div>
              <div className="col-span-1" />
            </div>

            {/* Rows */}
            {groupedItems[section]?.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-3 items-end border-b pb-3 last:border-0 last:pb-0"
              >
                {/* Payment Type */}
                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Payment Type</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={item.payment_type ?? "EFT"}
                    onChange={(e) =>
                      handlePaymentTypeChange(item, e.target.value as PaymentType)
                    }
                    disabled={isLocked}
                  >
                    {PAYMENT_TYPES.map((pt) => (
                      <option key={pt} value={pt}>
                        {pt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Count (only for EFT/DirectDebit) */}
                <div className="sm:col-span-2">
                  <Label className="sm:hidden text-xs">Count</Label>
                  <Input
                    type="number"
                    min="0"
                    value={showCount(item) ? (item.item_count ?? "") : ""}
                    onChange={(e) =>
                      handleFieldUpdate(item.id, "item_count", parseInt(e.target.value) || 0)
                    }
                    disabled={isLocked || !showCount(item)}
                    placeholder={showCount(item) ? "0" : "-"}
                  />
                </div>

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
                    disabled={isLocked}
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
                      disabled={isLocked}
                      placeholder="Receipt #"
                    />
                  </div>
                )}

                {/* Proof Status */}
                <div className={`sm:col-span-2 ${!showManualReference(item) && section !== "Burial" ? "" : ""}`}>
                  <Label className="sm:hidden text-xs">Proof</Label>
                  {showProof(item) ? (
                    <div className="flex items-center gap-2">
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={item.proof_status ?? "Pending"}
                        onChange={(e) =>
                          handleFieldUpdate(item.id, "proof_status", e.target.value)
                        }
                        disabled={isLocked}
                      >
                        <option value="Pending">Pending</option>
                        <option value="Uploaded">Uploaded</option>
                        <option value="Deposited">Deposited</option>
                      </select>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground block h-10 leading-10">
                      N/A
                    </span>
                  )}
                </div>

                {/* Delete button */}
                <div className="sm:col-span-1 flex items-center">
                  {!isLocked && (
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

            {/* Add row button */}
            {!isLocked && (
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
              <span className="font-medium">Section Total:</span>
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
