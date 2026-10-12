// ─────────────────────────────────────────────────────────────────────────────
// CENSUS MANAGER (Phase B, FEAT-002 UI) — 3-step census capture for the
// Treasurer/Chair dashboard. All balancing + inactivity logic is delegated to the
// pure, unit-tested @/lib/censusBalancing module; all persistence goes through the
// Dexie-local @/db/censusRepo data layer. This component owns NO business rules —
// it renders previews, runs the exported checks live, and blocks saves on mismatch.
//
//   Step 1  Overseership Upload   — parse CSV (papaparse) / XLSX (SheetJS), preview,
//                                   per-row souls balance, all-or-nothing save.
//   Step 2  Congregation Totals   — editable per-congregation totals, blocked on
//                                   souls mismatch.
//   Step 3  Priestship Split      — matrix split across priestships, live sum vs
//                                   congregation totals, blocked on mismatch.
//
// `readOnly` hides every save control (driven by the dashboard permission gate).
// db.congregations is read read-only here solely to label rows with names.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  db,
  type CongregationSettings,
  type OfficerLookup,
  type LocalCensusCongregation,
  type LocalCensusPriestship,
} from "@/db/schema";
import {
  checkSoulsBalance,
  checkPriestshipSplit,
  inactivityStatus,
  daysSince,
  type SoulsBreakdown,
  type BalanceResult,
  type PriestshipMetrics,
} from "@/lib/censusBalancing";
import * as census from "@/db/censusRepo";

type Status = "green" | "amber" | "red";
type Step = "upload" | "totals" | "split";

interface SplitCell {
  families: number;
  contact_points: number;
  souls: number;
}

const BREAKDOWN_FIELDS = [
  { key: "adults", label: "Adults" },
  { key: "children_0_15", label: "Children 0–15" },
  { key: "unconfirmed_youth", label: "Unconf. Youth" },
  { key: "confirmed_youth", label: "Conf. Youth" },
  { key: "seniors", label: "Seniors" },
] as const;

// ── Numeric coercion (strings / blanks / NaN → 0), mirrors censusRepo.toNum ──
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function breakdownOf(src: Record<string, unknown>): SoulsBreakdown {
  return {
    adults: toNumber(src.adults),
    children_0_15: toNumber(src.children_0_15),
    unconfirmed_youth: toNumber(src.unconfirmed_youth),
    confirmed_youth: toNumber(src.confirmed_youth),
    seniors: toNumber(src.seniors),
  };
}

function rowToTotals(r: LocalCensusCongregation): census.CongregationTotalsInput {
  return {
    families: toNumber(r.families),
    contact_points: toNumber(r.contact_points),
    total_souls: toNumber(r.total_souls),
    adults: toNumber(r.adults),
    children_0_15: toNumber(r.children_0_15),
    unconfirmed_youth: toNumber(r.unconfirmed_youth),
    confirmed_youth: toNumber(r.confirmed_youth),
    seniors: toNumber(r.seniors),
    mem_breakdown: r.mem_breakdown ?? null,
  };
}

/** Signed diff for display, e.g. "+3" / "-2" / "0". */
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "green" ? "bg-green-500" : status === "amber" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className={cn("inline-block h-2.5 w-2.5 rounded-full", color)} aria-hidden="true" />
  );
}

export interface CensusManagerProps {
  congregationId: string;
  readOnly?: boolean;
}

export function CensusManager({ congregationId, readOnly = false }: CensusManagerProps) {
  const month = useMemo(() => census.monthKey(), []);
  const [tab, setTab] = useState<Step>("upload");
  const [toast, setToast] = useState<string | null>(null);

  // Shared reference data.
  const [settings, setSettings] = useState<CongregationSettings | undefined>(undefined);
  const [congNames, setCongNames] = useState<Record<string, string>>({});
  const [censusRows, setCensusRows] = useState<LocalCensusCongregation[]>([]);

  // Step 1 — upload.
  const [uploadRows, setUploadRows] = useState<census.OverseershipUploadRow[]>([]);
  const [uploadFileName, setUploadFileName] = useState<string>("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [rejections, setRejections] = useState<census.UploadRejection[]>([]);
  const [savingUpload, setSavingUpload] = useState(false);

  // Step 2 — editable totals.
  const [totalsDraft, setTotalsDraft] = useState<Record<string, census.CongregationTotalsInput>>({});
  const [totalsBalance, setTotalsBalance] = useState<Record<string, BalanceResult>>({});

  // Step 3 — priestship split.
  const [selectedCong, setSelectedCong] = useState<string>("");
  const [priests, setPriests] = useState<OfficerLookup[]>([]);
  const [priestCensus, setPriestCensus] = useState<LocalCensusPriestship[]>([]);
  const [splitDraft, setSplitDraft] = useState<Record<string, SplitCell>>({});

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function reload() {
    const [s, rows, congs] = await Promise.all([
      census.getCensusSettings(congregationId),
      census.getCongregationCensus(month),
      db.congregations.toArray(),
    ]);
    setSettings(s);
    setCensusRows(rows);
    setCongNames(Object.fromEntries(congs.map((c) => [c.id, c.name])));
    const draft: Record<string, census.CongregationTotalsInput> = {};
    for (const r of rows) draft[r.congregation_id] = rowToTotals(r);
    setTotalsDraft(draft);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [congregationId, month]);

  // Load priestships + existing split whenever the selected congregation changes.
  useEffect(() => {
    if (!selectedCong) {
      setPriests([]);
      setPriestCensus([]);
      setSplitDraft({});
      return;
    }
    let cancelled = false;
    (async () => {
      const [ps, pc] = await Promise.all([
        census.listPriestships(selectedCong),
        census.getPriestshipCensus(selectedCong),
      ]);
      if (cancelled) return;
      setPriests(ps);
      setPriestCensus(pc);
      const draft: Record<string, SplitCell> = {};
      for (const p of ps) {
        const existing = pc.find((x) => x.priest_id === p.id);
        draft[p.id] = {
          families: toNumber(existing?.families),
          contact_points: toNumber(existing?.contact_points),
          souls: toNumber(existing?.souls),
        };
      }
      setSplitDraft(draft);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCong]);

  // ── Step 1 handlers ──────────────────────────────────────────────────────
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setParseError(null);
    setRejections([]);
    setUploadRows([]);
    setUploadFileName(file.name);
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith(".csv")) {
        Papa.parse<census.OverseershipUploadRow>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) =>
            setUploadRows((res.data ?? []).filter((r) => r && String(r.congregation_name ?? "").trim())),
          error: (err) => setParseError(err.message),
        });
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<census.OverseershipUploadRow>(ws, { defval: "" });
        setUploadRows(json.filter((r) => r && String(r.congregation_name ?? "").trim()));
      } else {
        setParseError("Unsupported file type. Upload a .csv or .xlsx file.");
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Failed to parse file.");
    }
  }

  const uploadBalances = useMemo(
    () => uploadRows.map((r) => checkSoulsBalance(toNumber(r.total_souls), breakdownOf(r))),
    [uploadRows]
  );
  const anyUploadUnbalanced = uploadBalances.some((b) => !b.balanced);

  async function handleSaveUpload() {
    if (readOnly) return;
    setSavingUpload(true);
    setRejections([]);
    try {
      const res = await census.saveOverseershipUpload(month, uploadRows);
      if (!res.ok) {
        setRejections(res.rejections);
        setToast(`Blocked — ${res.rejections.length} row(s) rejected. Nothing was saved.`);
        return;
      }
      setToast(`Saved ${res.savedCount} congregation total(s).`);
      setUploadRows([]);
      setUploadFileName("");
      await reload();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSavingUpload(false);
    }
  }

  // ── Step 2 handlers ──────────────────────────────────────────────────────
  function patchTotals(congId: string, key: keyof census.CongregationTotalsInput, value: number) {
    setTotalsDraft((prev) => ({
      ...prev,
      [congId]: { ...prev[congId], [key]: value },
    }));
  }

  async function handleSaveTotals(congId: string) {
    if (readOnly) return;
    const totals = totalsDraft[congId];
    if (!totals) return;
    try {
      const res = await census.saveCongregationTotals(congId, month, totals);
      setTotalsBalance((prev) => ({ ...prev, [congId]: res.balance }));
      const name = congNames[congId] ?? congId;
      if (!res.ok) {
        setToast(`${name}: balancing mismatch (diff ${signed(res.balance.diff)}). Not saved.`);
        return;
      }
      setToast(`${name}: totals saved.`);
      await reload();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Save failed.");
    }
  }

  // ── Step 3 handlers ──────────────────────────────────────────────────────
  function patchSplit(priestId: string, key: keyof SplitCell, value: number) {
    setSplitDraft((prev) => ({
      ...prev,
      [priestId]: { ...(prev[priestId] ?? { families: 0, contact_points: 0, souls: 0 }), [key]: value },
    }));
  }

  const congRow = censusRows.find((r) => r.congregation_id === selectedCong);
  const splitTotals: PriestshipMetrics = {
    families: toNumber(congRow?.families),
    contact_points: toNumber(congRow?.contact_points),
    souls: toNumber(congRow?.total_souls),
  };
  const splitRows: PriestshipMetrics[] = priests.map(
    (p) => splitDraft[p.id] ?? { families: 0, contact_points: 0, souls: 0 }
  );
  const splitResult = checkPriestshipSplit(splitRows, splitTotals);

  async function handleSaveSplit() {
    if (readOnly || !selectedCong) return;
    const splits: census.PriestshipSplitInput[] = priests.map((p) => {
      const cell = splitDraft[p.id] ?? { families: 0, contact_points: 0, souls: 0 };
      return { priest_id: p.id, ...cell };
    });
    try {
      const res = await census.splitToPriestships(selectedCong, month, splits);
      if (!res.ok) {
        setToast("Balancing mismatch — split not saved.");
        return;
      }
      setToast("Priestship split saved.");
      const pc = await census.getPriestshipCensus(selectedCong);
      setPriestCensus(pc);
      await reload();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Save failed.");
    }
  }

  // ── Header inactivity badge ────────────────────────────────────────────────
  const headerInact = inactivityStatus(settings?.last_census_verified_at ?? null);
  const lastVerifiedLabel = settings?.last_census_verified_at
    ? new Date(settings.last_census_verified_at).toLocaleDateString()
    : "Never verified";

  const steps: { key: Step; label: string }[] = [
    { key: "upload", label: "1 · Overseership Upload" },
    { key: "totals", label: "2 · Congregation Totals" },
    { key: "split", label: "3 · Priestship Split" },
  ];

  return (
    <div className="space-y-4">
      {toast && (
        <div
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md text-xs shadow-lg"
          role="status"
        >
          {toast}
        </div>
      )}

      {/* Header: inactivity badge */}
      <Card>
        <CardHeader className="p-3 pb-0">
          <CardTitle className="text-base font-semibold">Census — {month}</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-2">
          <div className="flex items-center gap-2 text-xs" role="status" aria-label="Census verification status">
            <StatusDot status={headerInact.status} />
            <span className="font-medium">{headerInact.label}</span>
            <span className="text-muted-foreground">
              · Last verified: {lastVerifiedLabel}
              {headerInact.days != null ? ` (${headerInact.days}d ago)` : ""}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Step tabs */}
      <div className="inline-flex flex-wrap gap-1 rounded-md bg-muted p-1">
        {steps.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setTab(s.key)}
            className={cn(
              "rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
              tab === s.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <UploadStep
          readOnly={readOnly}
          uploadRows={uploadRows}
          uploadBalances={uploadBalances}
          uploadFileName={uploadFileName}
          parseError={parseError}
          rejections={rejections}
          anyUnbalanced={anyUploadUnbalanced}
          saving={savingUpload}
          onFile={handleFile}
          onSave={handleSaveUpload}
        />
      )}

      {tab === "totals" && (
        <TotalsStep
          readOnly={readOnly}
          month={month}
          rows={censusRows}
          congNames={congNames}
          draft={totalsDraft}
          balance={totalsBalance}
          onPatch={patchTotals}
          onSave={handleSaveTotals}
        />
      )}

      {tab === "split" && (
        <SplitStep
          readOnly={readOnly}
          rows={censusRows}
          congNames={congNames}
          selectedCong={selectedCong}
          onSelectCong={setSelectedCong}
          priests={priests}
          priestCensus={priestCensus}
          splitDraft={splitDraft}
          splitTotals={splitTotals}
          splitResult={splitResult}
          onPatch={patchSplit}
          onSave={handleSaveSplit}
        />
      )}
    </div>
  );
}

// ─── Step 1: Overseership Upload ───────────────────────────────────────────────
function UploadStep({
  readOnly,
  uploadRows,
  uploadBalances,
  uploadFileName,
  parseError,
  rejections,
  anyUnbalanced,
  saving,
  onFile,
  onSave,
}: {
  readOnly: boolean;
  uploadRows: census.OverseershipUploadRow[];
  uploadBalances: BalanceResult[];
  uploadFileName: string;
  parseError: string | null;
  rejections: census.UploadRejection[];
  anyUnbalanced: boolean;
  saving: boolean;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
}) {
  return (
    <Card>
      <CardHeader className="p-3 pb-0">
        <CardTitle className="text-sm font-semibold">Step 1 — Overseership Upload</CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Upload a CSV or Excel file with columns: congregation_name, families, contact_points,
          total_souls, adults, children_0_15, unconfirmed_youth, confirmed_youth, seniors,
          mem_breakdown. Each row must balance (total_souls = sum of the five breakdown buckets).
          Save is all-or-nothing.
        </p>

        <div className="flex items-center gap-2">
          <Input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={onFile}
            className="h-9 w-auto text-xs"
            aria-label="Census upload file"
          />
          {uploadFileName && <span className="text-xs text-muted-foreground">{uploadFileName}</span>}
        </div>

        {parseError && (
          <div
            className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700"
            role="alert"
          >
            {parseError}
          </div>
        )}

        {rejections.length > 0 && (
          <div
            className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 space-y-1"
            role="alert"
          >
            <p className="font-semibold">Save blocked — nothing was written:</p>
            <ul className="list-disc pl-4">
              {rejections.map((rej, i) => (
                <li key={i}>
                  {String(rej.row.congregation_name ?? "(unnamed)")} —{" "}
                  {rej.reason === "unknown_congregation"
                    ? "unknown congregation"
                    : `unbalanced (expected ${rej.balance?.expected}, got ${rej.balance?.actual}, diff ${signed(
                        rej.balance?.diff ?? 0
                      )})`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {uploadRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Congregation</th>
                  <th className="py-1 pr-2 font-medium text-right">Families</th>
                  <th className="py-1 pr-2 font-medium text-right">Contacts</th>
                  <th className="py-1 pr-2 font-medium text-right">Souls</th>
                  {BREAKDOWN_FIELDS.map((f) => (
                    <th key={f.key} className="py-1 pr-2 font-medium text-right">
                      {f.label}
                    </th>
                  ))}
                  <th className="py-1 pr-2 font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {uploadRows.map((r, i) => {
                  const bal = uploadBalances[i];
                  const bad = !bal.balanced;
                  return (
                    <tr
                      key={i}
                      className={cn("border-b last:border-0", bad && "bg-red-50 text-red-700")}
                    >
                      <td className="py-1 pr-2">{String(r.congregation_name ?? "")}</td>
                      <td className="py-1 pr-2 text-right">{toNumber(r.families)}</td>
                      <td className="py-1 pr-2 text-right">{toNumber(r.contact_points)}</td>
                      <td className="py-1 pr-2 text-right">{toNumber(r.total_souls)}</td>
                      {BREAKDOWN_FIELDS.map((f) => (
                        <td key={f.key} className="py-1 pr-2 text-right">
                          {toNumber((r as Record<string, unknown>)[f.key])}
                        </td>
                      ))}
                      <td className="py-1 pr-2 font-medium">
                        {bal.balanced ? (
                          <span className="text-green-600">OK</span>
                        ) : (
                          <span>diff {signed(bal.diff)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!readOnly && uploadRows.length > 0 && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={saving || anyUnbalanced} onClick={onSave}>
              {saving ? "Saving…" : "Save upload"}
            </Button>
            {anyUnbalanced && (
              <span className="text-xs font-medium text-red-700">
                Fix the red rows before saving (all-or-nothing).
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Step 2: Congregation Totals ────────────────────────────────────────────────
function TotalsStep({
  readOnly,
  month,
  rows,
  congNames,
  draft,
  balance,
  onPatch,
  onSave,
}: {
  readOnly: boolean;
  month: string;
  rows: LocalCensusCongregation[];
  congNames: Record<string, string>;
  draft: Record<string, census.CongregationTotalsInput>;
  balance: Record<string, BalanceResult>;
  onPatch: (congId: string, key: keyof census.CongregationTotalsInput, value: number) => void;
  onSave: (congId: string) => void;
}) {
  const numericFields: { key: keyof census.CongregationTotalsInput; label: string }[] = [
    { key: "families", label: "Families" },
    { key: "contact_points", label: "Contacts" },
    { key: "total_souls", label: "Souls" },
    ...BREAKDOWN_FIELDS.map((f) => ({ key: f.key as keyof census.CongregationTotalsInput, label: f.label })),
  ];

  return (
    <Card>
      <CardHeader className="p-3 pb-0">
        <CardTitle className="text-sm font-semibold">Step 2 — Congregation Totals ({month})</CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-3">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No congregation totals yet for {month}. Upload an overseership file in Step 1 first.
          </p>
        ) : (
          rows.map((r) => {
            const d = draft[r.congregation_id];
            if (!d) return null;
            const live = checkSoulsBalance(d.total_souls, {
              adults: d.adults,
              children_0_15: d.children_0_15,
              unconfirmed_youth: d.unconfirmed_youth,
              confirmed_youth: d.confirmed_youth,
              seniors: d.seniors,
            });
            const saved = balance[r.congregation_id];
            return (
              <div key={r.congregation_id} className="rounded border p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">
                    {congNames[r.congregation_id] ?? r.congregation_id}
                  </span>
                  <span
                    className={cn(
                      "text-xs font-medium",
                      live.balanced ? "text-green-600" : "text-red-700"
                    )}
                  >
                    {live.balanced ? "Balanced" : `Mismatch — diff ${signed(live.diff)}`}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {numericFields.map((f) => (
                    <label key={f.key} className="block text-xs">
                      <span className="text-muted-foreground">{f.label}</span>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={Number(d[f.key] ?? 0)}
                        disabled={readOnly}
                        onChange={(e) => onPatch(r.congregation_id, f.key, toNumber(e.target.value))}
                      />
                    </label>
                  ))}
                </div>
                {saved && !saved.balanced && (
                  <p className="text-xs text-red-700" role="alert">
                    Save blocked: souls {saved.actual} ≠ breakdown {saved.expected} (diff{" "}
                    {signed(saved.diff)}). Nothing was written.
                  </p>
                )}
                {!readOnly && (
                  <Button
                    size="sm"
                    disabled={!live.balanced}
                    onClick={() => onSave(r.congregation_id)}
                  >
                    Save totals
                  </Button>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ─── Step 3: Priestship Split ────────────────────────────────────────────────────
function SplitStep({
  readOnly,
  rows,
  congNames,
  selectedCong,
  onSelectCong,
  priests,
  priestCensus,
  splitDraft,
  splitTotals,
  splitResult,
  onPatch,
  onSave,
}: {
  readOnly: boolean;
  rows: LocalCensusCongregation[];
  congNames: Record<string, string>;
  selectedCong: string;
  onSelectCong: (id: string) => void;
  priests: OfficerLookup[];
  priestCensus: LocalCensusPriestship[];
  splitDraft: Record<string, SplitCell>;
  splitTotals: PriestshipMetrics;
  splitResult: ReturnType<typeof checkPriestshipSplit>;
  onPatch: (priestId: string, key: keyof SplitCell, value: number) => void;
  onSave: () => void;
}) {
  const metrics: { key: keyof SplitCell; label: string; totalKey: keyof PriestshipMetrics }[] = [
    { key: "families", label: "Families", totalKey: "families" },
    { key: "contact_points", label: "Contacts", totalKey: "contact_points" },
    { key: "souls", label: "Souls", totalKey: "souls" },
  ];

  return (
    <Card>
      <CardHeader className="p-3 pb-0">
        <CardTitle className="text-sm font-semibold">Step 3 — Priestship Split</CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-3">
        <label className="block text-xs">
          <span className="text-muted-foreground">Congregation</span>
          <select
            className="mt-1 block h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
            value={selectedCong}
            onChange={(e) => onSelectCong(e.target.value)}
          >
            <option value="">Select a congregation…</option>
            {rows.map((r) => (
              <option key={r.congregation_id} value={r.congregation_id}>
                {congNames[r.congregation_id] ?? r.congregation_id}
              </option>
            ))}
          </select>
        </label>

        {!selectedCong ? (
          <p className="text-xs text-muted-foreground">
            Pick a congregation to split its totals across priestships.
          </p>
        ) : priests.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No priestships (officers with rank “Priest”) found for this congregation. Sync officers
            online first.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Priestship</th>
                    {metrics.map((m) => (
                      <th key={m.key} className="py-1 pr-2 font-medium text-right">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {priests.map((p) => {
                    const pc = priestCensus.find((x) => x.priest_id === p.id);
                    const inact = inactivityStatus(pc?.last_verified_at ?? null);
                    const days = daysSince(pc?.last_verified_at ?? null);
                    const cell = splitDraft[p.id] ?? { families: 0, contact_points: 0, souls: 0 };
                    return (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="py-1 pr-2">
                          <span className="flex items-center gap-1.5">
                            <StatusDot status={inact.status} />
                            <span>
                              {p.first_name} {p.last_name ?? ""}
                            </span>
                            <span className="text-muted-foreground">
                              · {days == null ? "never updated" : `${days}d since update`}
                            </span>
                          </span>
                        </td>
                        {metrics.map((m) => (
                          <td key={m.key} className="py-1 pr-2 text-right">
                            <Input
                              type="number"
                              className="h-8 w-20 text-xs text-right ml-auto"
                              value={Number(cell[m.key] ?? 0)}
                              disabled={readOnly}
                              onChange={(e) => onPatch(p.id, m.key, toNumber(e.target.value))}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t font-medium">
                    <td className="py-1 pr-2">Split sum / Congregation total</td>
                    {metrics.map((m) => {
                      const r = splitResult[m.key];
                      return (
                        <td
                          key={m.key}
                          className={cn(
                            "py-1 pr-2 text-right",
                            r.balanced ? "text-green-600" : "text-red-700"
                          )}
                        >
                          {r.actual} / {splitTotals[m.totalKey]}
                          {!r.balanced && <span className="block">diff {signed(r.diff)}</span>}
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>

            {!splitResult.allBalanced && (
              <div
                className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700"
                role="alert"
              >
                <p className="font-semibold">Balancing mismatch — save blocked.</p>
                <ul className="list-disc pl-4">
                  {metrics.map((m) =>
                    splitResult[m.key].balanced ? null : (
                      <li key={m.key}>
                        {m.label}: diff {signed(splitResult[m.key].diff)} (sum{" "}
                        {splitResult[m.key].actual} vs total {splitResult[m.key].expected})
                      </li>
                    )
                  )}
                </ul>
              </div>
            )}

            {!readOnly && (
              <Button size="sm" disabled={!splitResult.allBalanced} onClick={onSave}>
                Save split
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
