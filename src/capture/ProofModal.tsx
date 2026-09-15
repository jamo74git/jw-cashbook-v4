import { useState } from "react";
import { compressImage } from "@/lib/imageCompress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface ProofResult {
  blob: Blob;
  fileName: string;
  date: string | null;
  bankRef: string | null;
}

interface ProofModalProps {
  title: string;
  requireDate?: boolean;
  onSave: (result: ProofResult) => Promise<void> | void;
  onClose: () => void;
}

/**
 * Proof / deposit-slip upload modal. Compresses the chosen image client-side into a
 * Blob (held locally until sync). Used for EFT/DD/Burial/Expense proofs and for the
 * bulk "Mark Banked" cash deposit slip.
 */
export function ProofModal({ title, requireDate = true, onSave, onClose }: ProofModalProps) {
  const [date, setDate] = useState("");
  const [bankRef, setBankRef] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!file || (requireDate && !date)) return;
    setBusy(true);
    const compressed = await compressImage(file);
    await onSave({ blob: compressed, fileName: compressed.name, date: date || null, bankRef: bankRef || null });
    setBusy(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <Card className="relative z-10 w-full max-w-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {requireDate && (
            <div className="space-y-1">
              <Label className="text-xs">Date *</Label>
              <Input type="date" className="h-9 text-xs" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Bank Ref</Label>
            <Input className="h-9 text-xs" value={bankRef} onChange={(e) => setBankRef(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Photo *</Label>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="text-xs"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy || !file || (requireDate && !date)}>
              {busy ? "…" : "Save"}
            </Button>
            <Button size="sm" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
