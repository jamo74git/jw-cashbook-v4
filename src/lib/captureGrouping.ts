// CAPTURE GROUPING (pure logic).
// Groups Members/Officers line items by their officer (priest) association so the
// capture form can show the per-officer grouped view. Association is by `officer_id`.
//
// TRUTHFULNESS NOTES:
// - count / cashCount / ddCount / eftCount are counts of captured ENTRIES (line items),
//   NOT distinct people. A combined officer/spouse tithe may be a single entry.
// - Classification (retained AFTER banking):
//     Cash = Cash | CashPending | CashBanked   (banking changes type to CashBanked; still Cash)
//     DD   = DirectDebit
//     EFT  = EFT
// - Any item whose item_type is none of the above is put in an `other` bucket (never silently
//   dropped) so the breakdown reconciles to the total:
//     cashTotal + ddTotal + eftTotal + otherTotal === subtotal
//     cashCount + ddCount + eftCount + otherCount === count

export interface GroupableItem {
  officer_id: string | null;
  item_type: string;
  amount: number;
}

export interface OfficerGroup<I extends GroupableItem> {
  officerId: string | null; // null => entries with no officer association ("Unassigned")
  items: I[];
  count: number; // captured entries, NOT distinct people
  subtotal: number;
  cashCount: number;
  cashTotal: number; // Cash / CashPending / CashBanked
  ddCount: number;
  ddTotal: number; // DirectDebit
  eftCount: number;
  eftTotal: number; // EFT
  otherCount: number; // unrecognised payment types (surfaced separately)
  otherTotal: number;
}

const CASH_TYPES = ["Cash", "CashPending", "CashBanked"];
const DD_TYPES = ["DirectDebit"];
const EFT_TYPES = ["EFT"];

const sum = <I extends GroupableItem>(items: I[]): number =>
  items.reduce((s, i) => s + Number(i.amount || 0), 0);

/**
 * Group items by `officer_id`. Officers are emitted in `officerOrder` first (only
 * those that actually have items), then any other officer ids encountered, and
 * finally the unassigned group (officer_id === null) last, if present.
 */
export function groupItemsByOfficer<I extends GroupableItem>(
  items: I[],
  officerOrder: { id: string }[] = []
): OfficerGroup<I>[] {
  const byId = new Map<string | null, I[]>();
  for (const it of items) {
    const key = it.officer_id ?? null;
    const arr = byId.get(key) ?? [];
    arr.push(it);
    byId.set(key, arr);
  }

  const orderedKeys: (string | null)[] = [];
  for (const o of officerOrder) {
    if (byId.has(o.id) && !orderedKeys.includes(o.id)) orderedKeys.push(o.id);
  }
  for (const key of byId.keys()) {
    if (key !== null && !orderedKeys.includes(key)) orderedKeys.push(key);
  }
  if (byId.has(null)) orderedKeys.push(null);

  return orderedKeys.map((key) => {
    const groupItems = byId.get(key) ?? [];
    const cash = groupItems.filter((i) => CASH_TYPES.includes(i.item_type));
    const dd = groupItems.filter((i) => DD_TYPES.includes(i.item_type));
    const eft = groupItems.filter((i) => EFT_TYPES.includes(i.item_type));
    const other = groupItems.filter(
      (i) => !CASH_TYPES.includes(i.item_type) && !DD_TYPES.includes(i.item_type) && !EFT_TYPES.includes(i.item_type)
    );
    return {
      officerId: key,
      items: groupItems,
      count: groupItems.length,
      subtotal: sum(groupItems),
      cashCount: cash.length,
      cashTotal: sum(cash),
      ddCount: dd.length,
      ddTotal: sum(dd),
      eftCount: eft.length,
      eftTotal: sum(eft),
      otherCount: other.length,
      otherTotal: sum(other),
    };
  });
}
