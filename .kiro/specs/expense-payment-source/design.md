# Design Document: Expense Payment Source, Officer Pre-paid Expenses, Multi-proof and Balance Rule

Status: DRAFT for user approval, revision 6, 2026-11-27 (revision 5 answered the fourth review, section 26; rounds 1 to 4 are sections 23 to 26 in ascending order; revision 6 adds the user's additions of 2026-11-27, sections 27 to 29). Documentation only. Two migrations are authored and NOT applied: `supabase/migrations/20261124100000_expense_payment_source.sql` (payment source, balance) and `supabase/migrations/20261124115000_expense_category.sql` (expense categories). Nothing is applied or pushed; document and SQL-file changes are committed locally only.
Requirements: `requirements.md` (numbers such as R3.1 refer to it). **[UNVERIFIED]** marks anything not read
from code or the schema.

## 1. Overview

Every expense gets a stored payment source: `CongregationCash` or `OfficerPrepaid`. A pre-paid expense stores the
officer in the existing `officer_id` column, so the link between the expense and the officer's tithing is one
database row and cannot dangle. The officer's tithing total is derived (tithe lines plus linked pre-paid expenses);
no extra line and no fake payment type is created.

The balance rule changes from `income === banked + expenses` (which can never hold when a cash expense exists)
to: all income is banked or electronic, cash expenses do not exceed the tithe cash collected, and pre-paid expenses
are neutral. The deposit slip amount becomes the net deposit (gross cash minus cash expenses). The server stops
trusting the client's `balanced` flag and computes the rule itself.

Exactly two sources exist and nothing else (requirement 1.9): there is no third option and no per-line Notes field; the Expenses notice of `burial-notice-and-trend` (Spec 2) is shown above the expense capture line instead (section 28). Every expense also carries a category chosen from an HO-managed list (District or Apostleship scope) with a built-in "Other" that needs a short description (section 27). Category storage, scope resolution, the line columns, the offline cache and the capture control are owned by this spec; the shared scope, HO-authority and read-rule SQL helpers, the admin-write path and the HO scope picker are reused from Spec 2, not copied.

Proofs for expenses move to a new local store (`lineProofs`, Dexie v5, together with `expenseCategories`) so an expense can have many proofs. The proof
dialog gets a label prop so the reference reads "Invoice No." for expenses, plus optional supplier and document
amount fields that a later OCR step can fill.

Technology stack (locked on approval): Vite 5, React 18, TypeScript, Dexie 4 (IndexedDB), Supabase Postgres with RLS
and plpgsql SECURITY DEFINER functions, Supabase Storage bucket `cashbook-proofs`, Vitest with fast-check and
fake-indexeddb for tests, plain-SQL assertion files under `supabase/tests/` (the existing style, `RAISE` on mismatch) for the server. No new runtime
dependency.

## 2. Facts this design stands on

| # | Fact | Source |
|---|------|--------|
| F1 | `isBalanced` is `cents(income) === cents(bankedTotal + expensesTotal)`; `bankedTotal` = EFT + DirectDebit + CashBanked (gross); `markCashBanked` banks whole lines, so expenses are never netted. | `src/lib/captureTotals.ts` (`bankedTotal` line 54, `expensesTotal` line 58, `bankingView` line 72, `isBalanced` line 90); `src/db/captureRepo.ts` 515-585 |
| F2 | The comments say expenses "reduce the net deposit" but no code does it. | `captureRepo.ts` 491-496; `CashbookForm.tsx` ~889-890 |
| F3 | Submit is disabled while `!balanced`. | `CashbookForm.tsx` ~986-990, 501 |
| F4 | `bankingView.cashPending` counts only `Cash`/`CashPending` in income sections. Unbanked Burial lines have `item_type='Burial'`, so they are eligible for banking (`eligibleCashItems`) but are not in `cashPending`; `isAwaitingBankingOnly` compares the shortfall with `cashPending`, so a period with unbanked burial cash shows red, not amber. | `captureTotals.ts` 56-64; `balanceState.ts`; `captureRepo.ts` 497-503 |
| F5 | Live `cashbook_line_item` columns: id, period_id, section, officer_id (nullable FK to officers), item_type (text, NO check), item_count, amount (numeric), proof_status (enum), payment_type, manual_reference, receipt_number, is_officer, transaction_date (NOT NULL), proof_reference, approved. CHECKs: `section` in (Members, Officers, Burial, Banking, Expenses); `payment_type` in (EFT, DirectDebit, Cash, Burial, Expense) (NULL passes). | read-only query 2026-11-24 |
| F6 | Live data: 10 Expense rows, all `officer_id` NULL (8 `payment_type='Expense'`, 2 NULL); zero `CashBanked` rows. | read-only query 2026-11-24 |
| F7 | `markCashBanked` writes `payment_type='CashBanked'` and `syncLineItem` sends `payment_type`; the live CHECK rejects it (23514). Not runtime-verified, but the constraint text is read. | `captureRepo.ts` 548, 572; `syncEngine.ts` 484; F5 |
| F8 | `cashbook_attachment` columns: id, line_item_id (FK, ON DELETE CASCADE), file_url, uploaded_by, uploaded_at, transaction_date, bank_reference, congregation_id. Unique index `(line_item_id, proof_ref_key(file_url))` allows many attachments with different object keys. Insert and update policies bind the object path's period to the line's period. | read-only query; `20261105130000_tranche4_proof_access.sql` 253-356 |
| F9 | The client keeps one proof per line (`proofBlob`, `proofFileName`, `proofObjectKey`, `proofHash`, `proofSize`, `proofBankRef`, `proofDate` on `LocalLineItem`). `attachProof` overwrites. After upload the blob is nulled and `proof_status='Deposited'`. | `schema.ts` 260-290; `captureRepo.ts` 473-489; `syncEngine.ts` 534-545 |
| F10 | `cashbook_submit_period` stores `balanced` from the client argument `p_balanced`. `cashbook_review_ready` trusts `manifest.balanced`. | `20261105110000_signoff_foundation.sql` 182-290 (sections 5, 7); `20261105140000_banked_cash_deposit.sql` 131-215 |
| F11 | `cashbook_review_ready` returns true early when `proof_mandatory` is false. Only inside the `proof_mandatory = true` branch does it require attachments for EFT, DirectDebit, Burial and Expense lines, and a deposit-slip row when the period has any cash line. Requirements 4.5 and 4.8 are read against that branch; the new always-required expense proof (R5.9) and the balance re-check are added outside it. | `20261105140000_banked_cash_deposit.sql` 176-214 |
| F12 | `cashbook_deposit_slip.amount` exists (numeric(12,2), nullable) and the client never sends it. | `20261105140000_banked_cash_deposit.sql` 39-55; `syncEngine.ts` 614-628 |
| F13 | Sync order inside `reconcilePeriod`: all line items, then the deposit slip, then `cashbook_submit_period`. Any failure throws before the submit RPC. | `syncEngine.ts` 342-465 |
| F14 | R500 check: `monthlyExpensesExceedThreshold(items, 500)` sums all expenses of the period (known per-period defect, recorded in `captureTotals.characterization.test.ts`). The constant `R500` is hard-coded in `CashbookForm.tsx` line 33. `congregation_settings.expense_approval_threshold` exists on the server and in the Dexie type, but `cacheLoader` selects only `congregation_id, proof_mandatory` (commit c98feafd) and no code reads the threshold. | `captureTotals.ts` 94-98; `CashbookForm.tsx` 33, 210; `schema.ts` 107; `cacheLoader.ts` |
| F15 | `officers` has no `user_id` column (id, congregation_id, officer_code, names, rank, is_active, ... interim fields). The code cannot tell whether the prepaid officer is the signed-in submitter. | read-only query 2026-11-24 |
| F16 | Dexie is at version 4. Non-indexed object fields need no version bump; a new store needs `version(5)` (this spec's version carries two stores, `lineProofs` and `expenseCategories`). | `schema.ts` 323-370 |
| F17 | Readers of `cashbook_line_item`: `AuditReviewPage.tsx` 139-146, `ChairpersonDashboard.tsx` 181-184, `ElderDashboard.tsx` 199-202, `OverseerReview.tsx` 209-212, `HOReview.tsx` 205-208, `SecretaryReview.tsx` 134-137, `officerFaithfulnessLive.ts` 26-29, `src/lib/supabase/queries.ts` 109-158. | grep |
| F18 | Chair and Elder tithing review group lines by `officer_id`, then by `is_officer`, and sum only cash and deposit item types (`CASH_TYPES`, `DEPOSIT_TYPES`). An Expense line with an `officer_id` is therefore ignored today. | `ChairpersonDashboard.tsx` 261-267; `ElderDashboard.tsx` 356-359 |
| F19 | Test tooling: vitest, fast-check, fake-indexeddb. No React Testing Library, no jsdom. | `package.json` |
| F20 | Latest applied migration is `20261105150000_fix_guard_enum`. | `PROJECT-LOG.md`; `supabase/migrations/` |
| F21 | Impact on existing server periods (read-only aggregate query, 2026-11-24): 14 periods; 7 have Expenses rows (4 Draft, 2 AuditApproved, 1 SubmittedToHO); `cashbook_submission_manifest` has 0 rows. So no existing period has a stored `manifest.balanced`, and none can flip under `cashbook_review_ready`. The 3 past-Draft periods have no manifest, so `review_ready` already returns false for them (no manifest row for the revision). The risk is for manifests created between now and the apply. | read-only query; migration header "PRE-APPLY IMPACT CHECK" |
| F22 | `cashbook_line_item` has no category column and no notes column (F5 lists every live column). No expense category concept exists in the code or in any spec before this revision (grep `categor` over `expense-payment-source`: 0 hits, 2026-11-27, before the edits). | F5; grep | Verified |
| F23 | The congregation cache already carries `district_id` and `apostleship_id` (and `overseership_id`), so category scope resolution needs no new column. `refreshReferenceCache` replaces each store only when its own query succeeded. | `burial-notice-and-trend` design F12; `cacheLoader.ts` | Verified |
| F24 | Role and scope facts for the HO write path and the read rule were read from the dev/demo backend (SELECT only, 2026-11-27): HO access is `scope_level = 'District'` with `hierarchy_id` = the district; `hierarchy_levels.level_type` is title case; `user_hierarchy_access.start_date` is `timestamptz`. See Spec 2 design F27. | `burial-notice-and-trend` design F27 | Verified |

## 3. Key decisions

### 3.1 Where the prepaid officer is stored: reuse `officer_id`

Alternative A: a new column `prepaid_officer_id`. Alternative B: reuse `officer_id`. Chosen: **B**. `officer_id`
already exists, is a nullable FK to `officers`, is in `LocalLineItem`, `MUTABLE_LINE_FIELDS` and the sync row, and no
Expenses row uses it today (F5, F6). The cost is that code which reads `officer_id` from any line now sees it on
Expenses rows. That is the intended effect for faithfulness (A3) and is handled explicitly for the tithing review
(F18, section 13). A CHECK ties the two fields together (`prepaid <=> officer_id not null`) so they cannot drift.

### 3.2 Officer prepaid value: derived, not materialised (recommendation, user to confirm: D5)

| | Derived (chosen) | Materialised offset line |
|---|---|---|
| Rows per pre-paid event | 1 (the Expense row) | 2 (Expense + an Officers line) |
| Link integrity | Cannot dangle (single row) | Two rows must be created, synced and deleted atomically; the sync engine upserts row by row (F13), so a half-sync is possible |
| New payment type | None | Needs a type that is not EFT, DirectDebit or Cash, and a widened `payment_type` CHECK (F5) |
| Effect on banking | None | The offset line must be excluded from banked, pending and cash sums in every reader, or it breaks the balance |
| Officer total | Computed by one shared function; every reader must call it | Falls out of existing sums |
| Risk | A reader that forgets the function under-reports an officer | Fake payment type pollutes reports and the CHECK |

Derived wins on atomicity and on not inventing a payment type. Its weak point is reader omission. Mitigation: one
function `officerTithingTotals` (section 6), the readers listed in F17 and F18 are all changed in this spec, and a
unit test asserts the Chair and Elder reviews use it.

### 3.3 Balance authority: server recomputes (recommendation: D12)

Today the server stores whatever the client says (F10). The new rule is more complex, so a client or a stale-cache
bug could mark an unbalanced period review-ready. The server computes the rule from the synced rows
(`cashbook_period_balance`, internal only) in `cashbook_submit_period` and again in `cashbook_review_ready`. The
sync order guarantees the lines are on the server before submit (F13). The client keeps its own copy for the UI and
for early blocking.

### 3.4 Multi-proof storage: new local store for expenses only

Alternative A: generalise to all line types now. Alternative B: new store used by Expense lines only, the legacy
single-proof fields untouched for EFT, DirectDebit and Burial. Chosen: **B** (smaller blast radius; the user asked
for multiple proofs on expenses). The store API is generic (`lineProofs` keyed by `lineLocalId`), so a later spec
can move other types over.

### 3.5 Invoice No. storage: reuse `bank_reference` (D10)

The user said the column stays unless the design finds a reason. No functional reason exists: the Audit page selects
`bank_reference` but does not display it (`AuditReviewPage.tsx` 77, 143), and no other reader exists. Chosen: reuse.
The cost is a column name that says "bank" while holding an invoice number for expense proofs. A later rename is
cheap and independent. OCR-ready fields get their own columns (`supplier_name`, `document_amount`, `entry_source`).

### 3.6 Cash available for cash expenses: tithe cash only (D2)

Burial money passes through to the district. Allowing it to fund congregation expenses would blur that. The rule uses
tithe cash (Members and Officers cash) as the ceiling for cash expenses. The net deposit still subtracts the
expense from total gross cash, so burial cash is still deposited in full. If the user prefers any cash, change one
filter in `balanceBreakdown` and one in the SQL function.

## 4. Data model

### 4.1 Server (migration `20261124100000_expense_payment_source.sql`, authored, not applied)

| Change | Detail |
|---|---|
| `cashbook_line_item.expense_payment_source text` | Values `CongregationCash`, `OfficerPrepaid`. NULL for non-Expenses rows. Backfill `CongregationCash` for the 10 existing Expense rows. |
| CHECK `cashbook_line_item_expense_source_check` | Expenses rows: source in the two values and `(source='OfficerPrepaid') = (officer_id is not null)`. Other rows: source IS NULL. |
| Trigger `trg_line_item_expense_guard` (BEFORE INSERT OR UPDATE) | Old clients: null source on an Expenses row becomes `CongregationCash`; non-Expenses rows are forced to NULL. Prepaid: officer must be active and belong to the period's congregation (checked on insert, or when officer or source changes, so later proof-status updates never fail). SQLSTATE 23514. |
| `cashbook_line_item.expense_category text`, `expense_category_other text` (separate migration `20261124115000_expense_category.sql`, section 27) | Category label snapshot (1-40 chars) and, only for the built-in label `Other`, a description (1-60 chars). NULL on every existing row and every non-Expenses row. CHECK `cashbook_line_item_expense_category_check` validates format only, not membership in a list. |
| `expense_category_config` table, `expense_category_publish`, `expense_category_clear` (same migration) | HO-managed list per District or Apostleship. Reuses Spec 2's SQL helpers `scope_resolve_district`, `scope_assert_ho` and the read function `scope_district_readable`. Browser SELECT only (any role). See 27.2. |
| `cashbook_attachment`: `supplier_name text`, `document_amount numeric(12,2) >= 0`, `entry_source text not null default 'manual' in ('manual','ocr')` | OCR-ready optional metadata. `bank_reference` unchanged. Existing RLS unchanged (policies check object path, period and congregation, not these columns). |
| `payment_type` CHECK widened (**separate migration, D8**) | Adds `CashPending`, `CashBanked`. Needed so banked cash can sync at all (F7). Recommended D8 = separate file `20261124095000_payment_type_cashbanked.sql` (sorts before the main migration), now authored (NOT APPLIED), reviewed and tested by task T13. Section 5 of `20261124100000_expense_payment_source.sql` is replaced by a pointer comment. If the user answers D8 = "inside this migration", T13 is skipped and section 5 stays. Either way exactly one file widens the CHECK. |
| `cashbook_period_balance(uuid) returns jsonb` | Server authority for the rule. SECURITY DEFINER, `search_path ''`, STABLE, **not granted to `authenticated`** (internal use by the two definer functions; avoids a cross-congregation read). |
| `cashbook_submission_manifest.balance_rule smallint not null` (D17) | New column (migration section 7a). Existing rows get 1 (legacy rule, client flag); the default is then set to 2 and `cashbook_submit_period` writes 2 explicitly. Lets `cashbook_review_ready` keep the old semantics for manifests frozen before the migration. |
| `cashbook_submit_period` replaced in place | Same signature and grants. Manifest `balanced` = server result, `balance_rule` = 2. Result JSON adds `balanced` and `client_balanced`. |
| `cashbook_review_ready` replaced in place | Same signature and grants. For `balance_rule = 1` manifests it runs the 20261105140000 logic unchanged (D17). For rule 2 it adds live balance re-check, always-required expense proof, slip required only when net deposit > 0, slip amount match. |

Apply order rule (section 19): this migration must be applied before any client build that sends the new fields to
that backend.

**Interim officers and the guard trigger (fact, verified in code).** The trigger rejects a pre-paid officer whose
`officers.is_active` is not true. The interim-request insert in `src/components/CashbookForm.tsx` (lines 146-163) always writes
`is_active: true`, `is_interim: true`, `status: 'pending_ho_approval'`, so a pending interim officer passes the guard, and
the picker (`allOfficers`, built from the same record plus the cached active officers) lists it. The live column default of
`officers.is_active` is not needed for this path and was not read **[UNVERIFIED]**; the migration
`20261102210349_officers_interim_fields.sql` does not touch `is_active`, and its RLS insert policy does not check it, so a
non-form insert without `is_active` could fall back to the live default. Residual risk: if HO later rejects an interim officer
and sets `is_active = false`, existing pre-paid expenses for that officer stay valid (the trigger runs only when the officer
or source changes, section 4.1), but a later edit that changes the officer fails 23514. This is accepted and recorded as risk R-11.

### 4.2 Client: `LocalLineItem` (`src/db/schema.ts`)

Add optional, non-indexed field `expense_payment_source?: "CongregationCash" | "OfficerPrepaid" | null`. Undefined on
an Expense row means `CongregationCash`. Add it to `MUTABLE_LINE_FIELDS` in `syncEngine.ts` (line 260) so an edit
leaves the row pending. `officer_id` already is in that list.

Also add optional, non-indexed `expense_category?: string | null` and `expense_category_other?: string | null` (section 27), likewise
added to `MUTABLE_LINE_FIELDS`. An undefined category on an Expense row means "Uncategorised"; `expense_category_other` is set only when
`expense_category === "Other"`. There is no notes field (requirement 11.1).

### 4.3 Client: new stores `lineProofs` and `expenseCategories` (Dexie `version(5)`, additive)

```ts
export interface LocalLineProof {
  localId: string;            // pk (uuid)
  lineLocalId: string;        // FK -> LocalLineItem.localId
  periodLocalId: string;      // for period-level "any proof pending" checks
  blob: Blob | null;          // null once uploaded
  fileName: string;
  objectKey: string;          // stable per proof, reused across retries
  hash: string | null;        // sha-256 hex of the bytes
  size: number | null;
  date: string | null;        // document date (ISO)
  invoiceNo: string | null;   // -> cashbook_attachment.bank_reference
  supplier: string | null;    // -> supplier_name
  documentAmount: number | null; // -> document_amount
  entrySource: "manual" | "ocr";
  createdAt: string;
  uploadedAt: string | null;  // set when the attachment row is acknowledged
}
// stores: lineProofs: "localId, lineLocalId, periodLocalId"
//         expenseCategories: "id, district_id, scope_id"      (section 27.4; one version, two additive stores)
```

`uploadedAt` is deliberately not indexed (IndexedDB cannot index null). Filter in memory. No `.upgrade()` function:
legacy single-proof fields on existing Expense rows keep working through a dual read (section 8.4). This follows the
v3 and v4 precedent in `schema.ts` (add-only, no data transform).

### 4.4 Client: `LocalPeriod`

Add optional, non-indexed `depositNetAmount?: number | null` (confirmed deposit, stored by `markCashBanked`).
`cashbook_deposit_slip.amount` receives it at sync (F12).

### 4.5 Client: `CaptureItem` (`captureTotals.ts`)

Add optional `expense_payment_source?: "CongregationCash" | "OfficerPrepaid" | null` and `officer_id?: string | null`.
Optional so every existing caller and test keeps compiling; an undefined source on an `Expense` item is a cash expense.

## 5. The balance rule

### 5.1 Definition

Let, per period (cents):

- `I` = sum of Members, Officers and Burial lines (income collected).
- `El` = EFT + DirectDebit lines.
- `Bg` = `CashBanked` lines (gross banked cash).
- `Tb` = `titheCashBanked` = `CashBanked` lines in Members and Officers. Used only after banking (the `balanced` test and the server).
- `Ta` = `titheCashAvailable` = `Cash`, `CashPending` and `CashBanked` lines in Members and Officers (entered, banked or not). Used before banking (the Mark Banked block and the `awaiting` test). `markCashBanked` banks every eligible line at once (`captureRepo.ts` 515-585), so after banking `Tb = Ta`; before banking `Tb = 0` and `Ta` is the entered tithe cash.
- `Pend` = Cash, CashPending and unbanked Burial lines in income sections (gross cash not yet banked). This fixes F4.
- `Tr` = `tithingRecorded` = Members + Officers lines + `P` (total tithing recorded, requirement 2.8).
- `Fk` = `fundsKept` = `I - C` (funds banked or kept).
- `C` = Expenses with source `CongregationCash` (undefined counts as cash).
- `P` = Expenses with source `OfficerPrepaid`.

Then:

```
balanced     <=>  I == El + Bg   AND   C <= Tb          (post-banking test; server uses the same)
netDeposit    =   Bg - C                                 (>= 0 when balanced)
cashShortfall <=>  C > Ta                                (pre- and post-banking; blocks Mark Banked)
awaiting      <=>  not balanced AND  I - El - Bg == Pend AND C <= Ta
```

Why two ceilings: before the first banking `Tb` is 0, so a test against `Tb` would block Mark Banked for every
period that has a cash expense and banking could never happen. Mark Banked is therefore blocked by `C > Ta`
(requirement 3.7), and once banked the verdict uses `Tb` (which equals `Ta`). Vector V14 pins the blocked case and V10
the amber case.

Period totals for readers (requirement 2.8): `tithingRecorded = Members + Officers + P` and `fundsKept = I - C`.
Neither feeds `balanced`. For V2 (income 700, pre-paid 120): tithing recorded 820, funds kept 700, net deposit 200.

Equivalent reading, to connect with the old formula: gross income including pre-paid officer tithing is `I + P`;
total expenses are `C + P`; banked is `El + (Bg - C)`; the old shape `income === banked + expenses` becomes
`(I + P) == (El + Bg - C) + (C + P)`, which reduces to `I == El + Bg`. Pre-paid cancels on both sides, which is why it
never moves the verdict (R3.4). With `C = P = 0` the rule is exactly the old one (R3.3).

Why not keep `expenses` inside the formula? Because cash expenses are paid out before banking, so they never appear in
`Bg`. The only information they add is the ceiling `C <= Tb` (`C <= Ta` before banking) and the net deposit.

### 5.2 Single implementation on the client

`src/lib/captureTotals.ts` gains `balanceBreakdown(items): BalanceBreakdown` returning `{ income, electronic,
cashBanked, titheCashBanked, titheCashAvailable, cashPending, cashExpenses, prepaid, tithingRecorded, fundsKept,
netDeposit, balanced, cashExpensesExceedCash (= C > Ta), awaitingBanking }`. Everything else delegates:

- `isBalanced(items)` returns `balanceBreakdown(items).balanced`.
- `bankedTotal(items)` is unchanged (gross), kept for the existing Audit banking table and the capture right-hand
  panel row "Banked (gross)". New exports `cashExpensesTotal`, `prepaidExpensesTotal`, `netDeposit`.
- `bankingView(items)` adds `cashExpenses`, `prepaid`, `netDeposit`, `netToBank` and fixes `cashPending` to include
  unbanked Burial lines. `netToBank` is what the next Mark Banked physically deposits and is defined by one rule that
  also covers a second banking (see 5.5): `netToBank = cashPending - C` when no line is `CashBanked` yet, and
  `netToBank = cashPending` once any line is `CashBanked` (the cash expenses C were already deducted from the first
  deposit and are frozen, R4.7). `netDeposit` (= `Bg - C`) stays the whole-period figure and is the one the server
  compares with the slip amount.
- `isAwaitingBankingOnly(items)` in `src/lib/balanceState.ts` returns `balanceBreakdown(items).awaitingBanking`.
- `monthlyExpensesExceedThreshold(items, threshold)` is unchanged: it sums `expensesTotal` (both sources, D4).
- `computeRequiredManifest` and `computeReviewReadiness` in `src/lib/completeCapture.ts` map `expense_payment_source`
  into the `CaptureItem` they build (`ManifestLineInput` and `ReviewEvidenceLine` get the optional field) and call
  `isBalanced`, so the manifest flag and the review mirror follow automatically. `buildSubmitManifestPayload` is
  unchanged.

### 5.3 Capture panel (CashbookForm right-hand card, lines ~927-933)

Rows: Income collected; Banked (electronic + gross cash); Paid from cash (C); then the verdict line and the
amount. A separate muted line "Pre-paid by officers (counts as tithing, not banked)" shows P when P > 0. The red
message for `C > Ta` is in R3.7. The verdict amount is `I - (El + Bg)` (what is still unaccounted).

### 5.4 Worked examples (golden vectors, duplicated in Appendix A)

| # | Lines | Result |
|---|---|---|
| V1 | Members Cash 300 and Burial 50 (both banked, so CashBanked), cash expense 40 | balanced, net deposit 310 |
| V2 | Officers EFT 500 (officer X), Members CashBanked 200, pre-paid 120 (X) | balanced, net deposit 200, X total 620 |
| V3 | Members EFT 100, cash expense 20 | not balanced (C 20 > Ta 0), message R3.7 |
| V4 | Members CashBanked 100, cash expense 100 | balanced, net deposit 0 (no slip needed) |
| V5 | Members CashBanked 100, Burial CashBanked 50, cash expense 120 | not balanced (C 120 > Ta 100) |
| V6 | Members Cash 100, nothing else | awaiting banking (amber) |
| V7 | Members EFT 100 only | balanced (same as legacy) |
| V8 | Members EFT 100, pre-paid 80 (officer Y) | balanced, net deposit 0, P 80 |
| V9 | Members CashBanked 0.10 and 0.20, cash expense 0.30 | balanced, net deposit 0 (cent rounding) |

### 5.5 Second (partial) banking

Cash lines can still be added after a first banking, and burial lines are eligible too. The rule, decided here
(recommended; user may choose the alternative in D16):

- First banking (no `CashBanked` line on the period): deposit = `cashPending - C`. After it, `Bg = cashPending_before`
  and `netDeposit = Bg - C` = what was deposited. Cash expenses freeze (R4.7).
- Later banking (some line already `CashBanked`): deposit = `cashPending` (new cash only; C is not subtracted again).
  After it, `Bg_total = Bg_before + cashPending` and `netDeposit = Bg_total - C`.
- Either way `markCashBanked` overwrites `depositNetAmount` with the recomputed whole-period `Bg_total - C`, and the
  slip photo is replaced as today (one slip per week coverage, `cashbook_deposit_slip_week_coverage_uq`,
  `20261105140000`). The slip amount therefore always equals the period's whole net deposit, which is what
  `cashbook_review_ready` compares (R4.8). The photo shown is the latest deposit; the amount is the sum. This is a
  documented simplification: two physical deposits, one slip record. The confirmation dialog for a later banking says
  "Deposit R x now (total deposited on this period R y)".
- Combined AM+PM slip: `depositNetAmount` always means the period's OWN whole-period net. `markCashBanked` writes the AM period's `depositNetAmount` in the same Dexie transaction that banks its cash and writes the PM period's own value on PM. The slip amount is never stored on a period: `syncDepositSlip` computes `amount = sum(depositNetAmount)` over every period the slip covers (the PM period and the AM period named by `coveredByDepositPeriodLocalId`), read from Dexie at sync time. The confirmation dialog shows that sum as the amount to deposit. Vector V13 pins it.
- A second banking never blocks on the ceiling being re-evaluated: `Ta` only grows, and C is frozen.

Alternative (D16 option B): block adding cash lines once any cash is banked, so only one banking ever happens. Simpler
arithmetic, but a Treasurer who banks on Monday and receives a late cash tithe has no way to record it. Not chosen.

Vectors V11 and V12 (Appendix A) pin this rule.

## 6. Officer total tithing (derived)

New pure module `src/lib/officerTithing.ts`:

```ts
officerTithingTotals(items, officerId): { paidIn: number; prepaid: number; total: number; byType: {EFT, DirectDebit, Cash} }
officerTithingByOfficer(items): Map<string, same>
```

`paidIn` = sum of the officer's Members and Officers section lines of type EFT, DirectDebit, Cash, CashPending or
CashBanked. `prepaid` = sum of Expenses lines with source `OfficerPrepaid` and that `officer_id`. `total = paidIn +
prepaid`. The tithe lines are never read for payment type beyond the `byType` breakdown, so a prepaid value cannot
alter any tithe line (R2.2). The shared function is used by:

- `CashbookForm.tsx` Officers tab group header (derived read-only "Pre-paid expense" rows, R2.4). Grouping stays
  in `src/lib/captureGrouping.ts`; the derived rows are appended in the render, not stored.
- `ChairpersonDashboard.tsx` lines 261-267 and `ElderDashboard.tsx` lines 356-359: the `priests` mapping adds
  `prepaid` and `total` (currently these screens ignore Expense lines, F18, so without this change pre-paid value would
  be invisible there). Both screens must also add `expense_payment_source` to their `select(...)` (R8.3).
- `officerFaithfulnessLive.ts` and `dashboardRepo.ts` already count any line with an `officer_id`, so a pre-paid
  expense marks the officer as having given (A3). No change; recorded as accepted behaviour.
- `SecretaryReview.tsx` shows totals only; it adds `expense_payment_source` to its select so its Expenses total can
  be split into "paid from cash" and "pre-paid". No officer-level data (R2.6).

Period-level totals (requirement 2.8). The user said the tithing amount "must be increased by the amount expensed", and the
review flagged that the spec never said whether the period figure is 700 or 820. The design shows both, with names, from the
one function `balanceBreakdown`: `tithingRecorded` = Members + Officers lines + pre-paid (V2: 820, "how much tithing was
recorded") and `fundsKept` = income - cash expenses (V2: 700, "what the congregation holds or banks"). They answer different
questions and are never added together or swapped. Every `*Totals` helper in section 18 (`chairpersonTotals`,
`elderTotals`, `overseerTotals`, `hoTotals`, `secretaryTotals`, `auditTotals`) returns both and a test asserts V2 gives 820 and 700. If the user wants
only one headline number, that is Open Decision D6b (section 21).

Placement (A2): the pre-paid value is added to the officer's personal tithing (the Officers-section total), not to
the Members tab, which holds the tithe he collects from members.

## 7. Capture flows (UI) in `src/components/CashbookForm.tsx`

### 7.1 Expenses capture bar (lines ~759-763)

Add a required two-choice control (radio group, no default): "Paid from congregation cash" / "Pre-paid by officer".
Selecting prepaid reveals the officer `<select>` using `pickerOfficers` (the same list as the Officers tab).
`addRow` (line ~314) validates: source chosen (R1.1), officer chosen when prepaid (R1.2), description, amount > 0, date
not in the future (existing). It passes `expense_payment_source` and `officer_id` to `capture.addLineItem`, which
adds them to `AddLineInput`.

When prepaid is not available on the server (capability flag false, R9.2) the control shows only "Paid from
congregation cash" with a one-line note.

Category control (R10.1, R10.9; section 27.5). Directly after the source control add a required category `<select>` with no
default, listing `resolveCategoryList(...)` (the list in force, then the built-in "Other" last). Choosing "Other" reveals a text input
(`maxLength` 60, hint "Never enter passwords, PINs or account numbers."). `expenseCaptureValidation` gains `category`, `categoryOther`
and `categoryLabels` and applies the rules of 27.6. The bar adds no Notes input (R11.1).

The Expenses notice (Spec 2 requirement 11) renders between the tab row and this capture bar. That slot and its component belong to
Spec 2 (task T7 there); this task adds no notice code and must leave the slot free (R11.3).

### 7.2 Officers tab action (R1.5)

In each officer group header add a small "Record pre-paid expense" button (visible when `canEdit`). It calls
`switchTab("Expenses")`, then sets source to prepaid and `officerId` to that officer. `switchTab` currently clears
`officerId` (line ~196); the new call sets it after the switch. One code path, one stored line.

### 7.3 Proof prompt after add (R5.2)

After `addLineItem` for an Expense, open `ProofModal` with `{ mode: "expense", localId }`. Cancel leaves the line with
"Proof required" in red. `needsProof` and `hasProofLocally` (lines 45-47) are replaced by a function that takes the
per-line proof count (loaded in `reload()` into a `Map<lineLocalId, number>`), so an Expense line has proof when
`count > 0`, or the legacy single-proof fields say so.

### 7.4 Forced proof independent of `proof_mandatory` (D1)

`missingProofs` (line ~212) becomes: `items.filter(i => (i.item_type === "Expense" || (proofMandatory && needsProof(i))) && !hasProof(i))`.
The Submit guard at lines ~504 and ~988 uses the same list, so the client blocks even when the congregation has
proof off. The server mirrors it in `cashbook_review_ready` (always-required expense attachment).

### 7.5 Delete dialog (lines ~629-637; R6)

`requestDelete` keeps both existing blocks (synced; `CashBanked`) and adds: a cash expense when cash is banked on the
period (R4.7). The dialog text is built from `deleteTarget`:

- Cash expense: "Delete this expense? R {amount} will no longer reduce the cash to bank. {n} attached proof(s) will be permanently removed from this device. This cannot be undone."
- Pre-paid: "Delete this pre-paid expense? The link to {officer} is removed: R {amount} stops counting toward {officer}'s tithing. {n} attached proof(s) will be permanently removed from this device. This cannot be undone."

`confirmDelete` calls `capture.deleteLineItem`, which in one Dexie transaction deletes the line and every
`lineProofs` row with that `lineLocalId` (R6.1). Because a synced line cannot reach the dialog, the proofs it deletes
are always unsynced local rows, so the warning is accurate.

## 8. Proofs

### 8.1 `ProofModal` (`src/capture/ProofModal.tsx`)

Add optional props: `referenceLabel?: string` (default `"Bank Ref"`), `dateLabel?: string` (default `"Date"`),
`showSupplier?: boolean`, `showDocumentAmount?: boolean`. `ProofResult` gains optional `supplier`, `documentAmount`.
For expenses the caller passes `referenceLabel="Invoice No."`, `dateLabel="Invoice date"`, `showSupplier`,
`showDocumentAmount`. The call sites for EFT, DirectDebit, Burial and the cash deposit slip pass nothing and keep
"Bank Ref". The capture-bar "Bank Ref" at `CashbookForm.tsx` line 778 is for EFT/DirectDebit tithe lines and does not
change. The labels come from a small pure function `proofFieldLabels(kind)` in `src/capture/proofLabels.ts` so the
label rule is unit-testable without a DOM (F19).

### 8.2 Repository

New functions in `captureRepo.ts`: `addExpenseProof(lineLocalId, proof)`, `listLineProofs(lineLocalId)`,
`countLineProofsByLine(periodLocalId)`, `removeUnsyncedLineProof(proofLocalId)` (rejects when `uploadedAt` is set),
`expenseProofSumMismatch(lineAmount, proofs)` (pure, for R5.6). `addExpenseProof` hashes the bytes, allocates
`objectKey` (`${uuid}-proof.${ext}`), and writes the row in a transaction that also calls `touchPeriod`, which marks the
period pending for sync. It does not touch the legacy single-proof fields. `attachProof` stays for the other types;
called with an Expense line it delegates to `addExpenseProof`.

### 8.3 Sync (`src/utils/syncEngine.ts`)

After the line upsert in `syncLineItem` (which now includes `expense_payment_source`), a new `syncLineProofs` handles
each `lineProofs` row with a blob, oldest first, using the same safety steps as today's single proof: bind the
fresh row (key, bytes, hash, size, metadata) in a transaction; `uploadProofStable` (duplicate object verified by
hash); select-then-insert into `cashbook_attachment` with `bank_reference = invoiceNo`, `supplier_name`,
`document_amount`, `entry_source`, `transaction_date = date`; set the line's `proof_status='Deposited'`; then in a
transaction clear the blob and set `uploadedAt` only if the row's `objectKey` still matches. `hasPendingProof` (line
~377) and the final `stillPending` check (~461) include `lineProofs` rows with a blob, so a period is never marked
synced with a proof local (R9.4). If the capability flag says the attachment columns are missing, `supplier_name`,
`document_amount` and `entry_source` are omitted from the insert (R9.2); the Invoice No. still goes to
`bank_reference`.

### 8.4 Dual read for legacy rows

`hasProof(line)` = `lineProofCount > 0 || !!line.proofBlob || line.proof_status === "Deposited" || line.proof_status === "Pending"`.
Existing local Expense rows with a single legacy proof keep working: their proof uploads through the existing
`syncLineItem` path; new proofs added to them go to `lineProofs`. No data conversion.

### 8.5 OCR readiness

Fields `invoiceNo`, `supplier`, `documentAmount` exist on `LocalLineProof` and as columns, with `entrySource`. A
later OCR step fills the same form fields before save and sets `entrySource='ocr'` for machine-filled values. No OCR
code, library or network call is added now.

## 9. Banking and the deposit slip

### 9.1 Confirmation (R4.1, R4.2)

The Banking tab "Mark Banked" button opens a confirmation dialog before the proof modal. It shows values from
`bankingView`: tithe cash available, burial cash, less cash expenses, pre-paid (not deducted), deposit amount. If `C > Ta` (entered tithe cash; a test against banked cash would block every first banking) the
button is disabled with the R3.7 message. If `C = 0` the dialog states "Deposit amount equals cash collected". The
confirmed `netToBank` is passed down.

### 9.2 `markCashBanked` (`captureRepo.ts` 515-585)

New option `expectedNetDeposit: number` (the physical deposit now, `netToBank` of 5.2/5.5, so a second banking passes
`cashPending`, not `cashPending - C`). Inside the existing transaction (Task 8 pattern) it recomputes
`netToBank` from the current rows. After flipping lines it recomputes the whole-period `Bg_total - C` from the rows and
overwrites `depositNetAmount` with it (not an increment), so repeating the call cannot drift (5.5). If it differs by more than one cent it returns `{ banked: 0, reason: "EXPENSES_CHANGED" }`
and writes nothing (R4.4). On success it flips the eligible lines as today and writes `depositNetAmount` on each period it banked: the period's OWN
whole-period net (for a combined slip the AM period's value is written in the same Dexie transaction, never summed onto
the PM period; R4.3). Each period is checked against its own `titheCashAvailable` before anything is written (R4.6); the
amount the dialog showed and `expectedNetDeposit` for a combined slip are the sum of both periods' deposits now.
The return type changes from `number` to `{ banked: number; reason?: string }`; the two call sites
(`CashbookForm.bankCash`, the banking tests) are updated in the same task.

When `expectedNetDeposit` is 0 the proof modal is skipped and `markCashBanked` accepts `deposit = null`: lines flip to
`CashBanked`, `depositBlob` stays null, `depositNetAmount = 0` (R4.5). `syncDepositSlip` is not invoked because
`depositBlob` is null. The server rule (net deposit > 0 needs a slip) matches.

### 9.3 Freeze after banking (R4.7)

A guard `assertCashExpenseEditable(periodLocalId)` throws `CASH_ALREADY_BANKED` when the period has any `CashBanked`
line. It is called by `addLineItem` (Expense with cash source), `updateLineItem` (when the row is a cash expense, or the
change touches `amount`, `expense_payment_source` or `officer_id` of an expense), and `deleteLineItem` (cash expense).
Pre-paid expenses are exempt unless the edit switches the source. The UI shows R4.7's message.

Known gap, flagged: the existing toasts say "Reverse the banking first" (`CashbookForm.tsx` lines 243, 414) but no
reverse-banking function exists (grep: none). A Rejected period with a wrong cash expense therefore cannot be fixed
until reverse banking exists. The server already allows deleting a slip while the period is Draft or Rejected
(`deposit_slip_delete_editable`, `20261105140000` section 4), so a follow-up is feasible. Not in scope (D13).

### 9.4 Slip sync (`syncDepositSlip`, `syncEngine.ts` ~614)

Add `amount` to the slip upsert, computed as the sum of `depositNetAmount` over every period the slip covers (the holding
PM period plus the AM period that has `coveredByDepositPeriodLocalId` pointing at it; a null counts as 0; if any covered
period still has a null `depositNetAmount` while the slip has a blob, send `amount: null` rather than a partial sum). The
server's `review_ready` compares it with the sum of the covered periods' server `net_deposit` (R4.8; migration lines
366-379, which already sums over `cashbook_deposit_slip_period`, so the migration needs no change for this finding). Legacy slips with `amount` null are not compared.

## 10. R500 governance (R7)

- `cacheLoader.ts` selects `expense_approval_threshold` with `proof_mandatory` (the column exists, F14).
- `captureRepo.getExpenseThreshold(congregationId)` returns `settings.expense_approval_threshold ?? 500`.
- `CashbookForm` replaces the constant `R500` with that value. The message becomes "Expenses exceed R {threshold}".
- `over500` uses `monthlyExpensesExceedThreshold(items, threshold)`, which sums both sources (D4). The panel adds a
  line "of which pre-paid by officers: R P".
- The per-period basis (F14) is not changed. A server check that the Elder comment exists when the threshold is
  exceeded would close a client-only control; it is listed as D4b, not built.

## 11. Server functions (summary; full SQL in the migration)

`cashbook_period_balance(p_period_id)` returns `{income_collected, electronic, cash_banked, tithe_cash_banked,
cash_pending, cash_expenses, prepaid, net_deposit, balanced}` with the same definitions as section 5. Money is rounded
to 2 decimals before comparing (N1). The function is revoked from every client role; only the definer functions
`cashbook_submit_period` and `cashbook_review_ready` call it. They run as the function owner, so no RLS applies
inside, and the callers already authorise the user (submit: capture role plus `get_my_hierarchy_ids()`; review: the
sign-off RPC's checks, unchanged).

Behaviour changes in `cashbook_review_ready` (all fail-closed): (i) re-check `balanced`; (ii) any Expenses line with no
attachment returns false even when `proof_mandatory` is false; (iii) with `proof_mandatory` true, a slip row is needed
only if `net_deposit > 0`; (iv) a slip `amount` that differs from the sum of covered periods' net deposits returns false.

## 12. Offline and rollout compatibility

- Dexie v5 adds only the `lineProofs` and `expenseCategories` stores (F16). Opening v4 data upgrades without touching rows. If Spec 2's notice store already took `version(5)`, this spec takes the next free number (each task reads `schema.ts` first).
- Capability probe: after the reference refresh, `cacheLoader` runs `select expense_payment_source from cashbook_line_item limit 0`
  , `select supplier_name from cashbook_attachment limit 0` and `select expense_category from cashbook_line_item limit 0`, each independently, and stores
  `syncMeta['serverCaps'] = { expensePaymentSource: boolean, attachmentMeta: boolean, expenseCategory: boolean }` (the third from `select expense_category from cashbook_line_item limit 0`). All probes are read only.
  The pure function `nextServerCaps(previous, probeResult)` (in `src/utils/serverCaps.ts`) owns the rules:
  1. **Default (flag never stored):** each capability is `false`. The UI shows the cash path only and the sync row omits
     the new fields. This covers a restored session where `refreshReferenceCache` never ran (it runs only from
     `LoginPage`, see `PROJECT-LOG.md`/findings section 2) and a device that has not been online since the upgrade.
  2. **Success** (no error): that capability becomes `true`.
  3. **Schema error:** only a PostgREST error whose `code` is `42703` (undefined column) or `PGRST204` (column not found
     in schema cache) sets that capability to `false`. **[UNVERIFIED]** The exact error shape PostgREST returns for a
     `limit 0` select of a missing column is not confirmed; the probe must be run once against the disposable stack and
     the code list adjusted. Until then the function treats those two codes as the only "missing" signals.
  4. **Any other error** (network failure, 401, 5xx, timeout, abort): the previous stored value is kept unchanged (or
     rule 1 applies if none). A transient failure never hides pre-paid on a migrated backend, and never enables it on an
     un-migrated one.
  5. Each capability is probed and stored independently; one failing probe does not discard the other, and a failing
     probe never aborts the rest of `refreshReferenceCache` (same `Promise.allSettled` pattern as `cacheLoader`).
  `CapturePage` reads the flags once on mount, through `getServerCaps()` which returns all three flags `false` when absent.
  Because a missing flag means "cash path only", a user who signs in on a restored session sees no pre-paid option until
  the next online login refreshes the flag (acceptable; recorded in risk R-8).
- Sync compatibility: when the flag is false the sync row omits `expense_payment_source` and the attachment metadata
  columns, so cash expenses sync to an un-migrated backend exactly as today. A pre-paid line cannot exist without the
  flag because the UI hides the option.
- Old clients on a migrated server keep working: the trigger defaults the source (R9.3) and old balance flags are
  ignored in favour of the server value.
- Service worker: `registerType: 'prompt'` (tech_old.md) means an old build can stay open on a device. Section 19 requires
  the migration to be applied before the new client is pushed, and the above makes either order safe for cash expenses.

## 13. Review and aggregate views

| Screen | Change |
|---|---|
| `AuditReviewPage.tsx` | Select `expense_payment_source` with the line items (line 142). Fetch attachments filtered to this period's line ids and extended columns (line 143 currently selects every visible attachment and filters in memory by id). Expense panel (lines ~578-606): source badge, officer, category and Other description (R10.12), all proofs with Invoice No., supplier, date, amount, and the R5.6 warning. "Grand Total" (line 614) becomes `income - cashExpenses`, with a separate "Pre-paid by officers" line. `reviewReadiness` uses `balanceBreakdown` through `computeReviewReadiness`. Expense lines are always proof-required in `computeReviewReadiness` (mirror of the server rule). |
| `ChairpersonDashboard.tsx` | Select the new field (line 183). `govTotal` (line 256) becomes `fundsKept` (`Members + Officers + Burial - cashExpenses`); add "Total tithing recorded" (`tithingRecorded`) and a pre-paid line. Tithing review uses `officerTithingTotals` (F18). |
| `ElderDashboard.tsx` | Same changes (lines 201, 356-359). |
| `OverseerReview.tsx`, `HOReview.tsx` | Select the new field (lines 211, 207); totals through `balanceBreakdown`. **[UNVERIFIED]** their exact aggregation code was not read; task T15 reads it first. |
| `SecretaryReview.tsx` | Select `expense_payment_source` (line 136); totals only, split "paid from cash" and "pre-paid". No proof, no line detail (R2.6, steering invariant 7). |
| `src/lib/supabase/queries.ts` 108-158 | Legacy R500 helper reading `section, amount`; confirm whether it is reachable. **[UNVERIFIED]** If it is, it must read the source and use the same basis. |

All of them read `expense_payment_source` as optional and treat a missing value as `CongregationCash`, so they
continue to work against an un-migrated backend.

## 14. Self-dealing risk (flag, not a code gate)

A Chairperson (a priest) can submit a period that contains a pre-paid expense in his own name, which raises his own
recorded tithing. The code cannot detect this: `officers` has no link to a user (F15). Mitigations in this design:

1. Two-person sign-off is already required and the submitter cannot sign (`20261105120000_two_person_signoff.sql`,
   verified in `PROJECT-LOG.md` UAT notes). A second and third person see the expense.
2. A visible "Pre-paid by officer" badge on the Audit page (R8.4), with proofs always required (R5.1).
3. Pre-paid value counts toward the R500 total (R7), so a large amount needs an Elder comment.
4. Optional later: add `officers.user_id` and block or flag a match with `submitted_by`. Listed as D9.

Residual risk accepted for pre-production: a colluding submitter and auditors, or forged receipts. The proof photo
and its Invoice No. and supplier are the audit trail.

## 15. Error handling

| Operation | Failure | Class | Caller sees | Log |
|---|---|---|---|---|
| Add expense, no source / no officer when prepaid / amount <= 0 / future date | validation | recoverable | inline error text under the capture bar (R1.6) | none |
| Add or edit a cash expense after cash is banked | `CASH_ALREADY_BANKED` | recoverable | R4.7 message in a toast | none |
| Prepaid selected but server lacks the column (capability false) | option hidden | n/a | one-line note | none |
| Mark Banked, expenses changed since the dialog | `EXPENSES_CHANGED` | recoverable | toast "Expenses changed; review the deposit amount and try again"; nothing written | none |
| Mark Banked, `C > Ta` | validation | recoverable | button disabled with R3.7 text | none |
| Delete, synced or banked line | blocked | recoverable | existing toast | none |
| Local proof write fails (Dexie quota, blob) | exception | recoverable | toast "Could not save the proof on this device" and the expense stays "Proof required" | `console.error` with line id only |
| Sync: line upsert fails (including 23514 from the guard trigger) | `Error` thrown | retryable | period shows failed with `lastError`; retained and backed off (existing) | existing `recordFailure` |
| Sync: proof upload or attachment insert fails | `Error` thrown | retryable | same; blob retained | existing |
| Sync: attachment column missing (PGRST204 / 42703) | detected by capability flag | recoverable | metadata omitted; Invoice No. still stored | none |
| Server `cashbook_submit_period` computes unbalanced while client said balanced | stored `balanced=false` | fatal for that revision | Audit page shows "does not balance"; auditor rejects, treasurer recaptures | result JSON carries `client_balanced` |
| Server `review_ready` false | returns false | n/a | existing "not yet ready for audit" banner | none |
| Pre-paid officer wrong congregation or inactive | SQLSTATE 23514 | fatal for that line until corrected | sync error text on the period | existing |

No new secret or personal data is logged (N3).

## 16. Validation rules (external inputs)

| Input | Rule | On failure |
|---|---|---|
| `expense_payment_source` | required for Expenses; one of two values | block save (client), 23514 (server) |
| prepaid `officer_id` | required if prepaid; must be in the loaded officer list for the congregation; absent if cash | block save; server trigger rejects mismatch |
| Expense amount | number > 0, at most 2 decimals after rounding | block save |
| Expense description | required, trimmed, 1-200 chars (limit new; existing is required only) **[UNVERIFIED]** server length | block save |
| Expense category | required for new expenses (D20); one of the labels in the list in force, or the built-in `Other`; trimmed, 1-40 chars | block save (client); server CHECK checks format only (23514) |
| Other description | required iff category is `Other`; trimmed, 1-60 chars, no control characters, no run of 9 or more digits (D19, client only); absent otherwise | block save (client); server CHECK 23514 on missing, empty, over-long or control characters |
| Category list (HO form) | 1-8 labels; each trimmed, 1-40 chars, no control characters, unique ignoring case, not `Other` | 400 (22023) from `expense_category_publish`; the client validator rejects first |
| Category scope node | District or Apostleship only; node exists, level matches, chain reaches a District; district assigned to the HO | 400 / 403 |
| Expense date | optional; default today; not in the future | block save (existing) |
| Proof photo | required; image file; compressed by `compressImage` (existing) | Save disabled |
| Proof date | required for expense proofs (existing `requireDate` default); not in the future | Save disabled |
| Invoice No. | optional, trimmed, 0-60 chars | truncate not allowed; inline error |
| Supplier | optional, trimmed, 0-100 chars | inline error |
| Document amount | optional, number >= 0, 2 decimals | inline error |
| Deposit confirmation | amount must equal recomputed `netToBank` within 1 cent | `EXPENSES_CHANGED` |

## 17. Invariants and who enforces them

| Invariant | Owner | Reason |
|---|---|---|
| Exactly one valid source per Expenses row; prepaid iff officer | Postgres CHECK + trigger | Data integrity must hold for every writer, including old clients |
| Prepaid officer belongs to the congregation and is active | Postgres trigger | RLS cannot express it; client list is only a convenience |
| Balance verdict used for review | Server (`cashbook_period_balance` in submit and review_ready) | Client flag is untrusted (F10) |
| Balance verdict shown while capturing | Client `balanceBreakdown` | Offline-first capture must work without the network |
| Expense proof exists before review | Server `review_ready`; client Submit guard | Server is the authority; client avoids a wasted round trip |
| Cash expense frozen after banking | Client repo guard | The deposit photo is a client artefact; the server sees the mismatch through `slip.amount` (R4.8) |
| Officer total = tithe + prepaid | Shared pure function | Single definition, used by all readers |
| Category list writes: HO only, assigned districts, District or Apostleship scope | `expense_category_publish` / `expense_category_clear` (service_role only) + `admin-write` gate, via the shared helpers `scope_resolve_district` and `scope_assert_ho` | One checked path for all HO configuration writes; no browser write grant |
| Every role reads category lists | `scope_district_readable` (no role term), shared with notices | RD1 of Spec 2 applies to categories too; offline cache is the working copy |
| Category label and Other text format | Postgres CHECK `cashbook_line_item_expense_category_check` + client validators | Format holds for every writer; membership in the current list is deliberately not enforced (offline capture) |
| HO-only admin, Secretary totals only, permission gate | Unchanged (`permissions.ts`; steering invariants 1, 2, 7) | Nothing here widens any role. Expense capture uses the existing `expenses.create` / `capture.create` checks. |

## 18. Test plan

Unit (vitest, no network):

- `captureTotals.balanceBreakdown.test.ts`: Appendix A vectors V1-V9 as table tests.
- Property tests with fast-check (`fast-check` is already a dependency):
  - **P1 neutral pre-paid:** for any generated ledger, adding or removing `OfficerPrepaid` expenses does not change `balanced`, `netDeposit`, `bankedTotal`.
  - **P2 netting:** for a balanced ledger, adding a cash expense `a <= Tb - C` reduces `netDeposit` by exactly `a` and keeps `balanced`; `a > Tb - C` makes `balanced` false.
  - **P3 legacy equality:** with no expenses, `isBalanced_new(items) === isBalanced_legacy(items)` for all generated ledgers (legacy function copied into the test as the oracle).
  - **P4 totals identity:** `sum over officers of total = tithe lines with officer_id + prepaid lines`.
  - **P5 rounding:** random amounts in cents; the verdict equals the integer-cent computation.
  - **P6 amber vs red:** `awaitingBanking` is true only when the shortfall equals pending cash including unbanked burial.
- Update `captureTotals.test.ts` Property 3 (it asserts that an unoffset expense is unbalanced) and `captureTotals.characterization.test.ts` line 24-27 text; they pin the old behaviour deliberately. `futureDateAndBanking.test.ts` and `completeCapture*.test.ts` get new cases.
- `officerTithing.test.ts`: derived totals, payment type untouched (R2.2), pre-paid never in `bankedTotal`.
- `captureRepo.expense.test.ts` (fake-indexeddb): add validation (R1.1-1.6); `deleteLineItem` removes proofs in one transaction (R6.1); freeze after banking (R4.7); `markCashBanked` nets, stores `depositNetAmount`, returns `EXPENSES_CHANGED` on a stale amount, zero-deposit path, combined slip sum.
- `proofLabels.test.ts`: Expense shows "Invoice No."; EFT, DirectDebit, Burial and deposit show "Bank Ref".
- `syncEngine.expense.test.ts` (mocked Supabase): upsert row contains the source; omitted when the capability is false; many proofs upload in order; retry reuses `objectKey`; a period with a local proof is never marked synced; slip upsert carries `amount`.
- Dexie: opening a v4 database at v5 keeps `lineItems` and `periods` rows.

Server (SQL under `supabase/tests/expense_payment_source.test.sql`, **unexecuted in this pass**, needs a disposable stack):
CHECK and trigger cases; old-client insert; foreign-congregation and inactive officer; proof-status update after officer deactivation;
Appendix A vectors against `cashbook_period_balance` (called as the owner role); submit stores the server balance;
`review_ready` expense proof with `proof_mandatory=false`, net deposit 0 with no slip, slip amount mismatch; `cashbook_period_balance` not executable by `authenticated`; the existing `two_person_signoff_rls.test.sql` and `tranche4_proof_rls.test.sql` still pass.

Additional unit tests added in this revision:

- `serverCaps.test.ts` (`nextServerCaps`, section 12): no stored flag gives `false`; success gives `true`; error code `42703` gives `false`; `PGRST204` gives `false`; a network error, a 401 and a 500 keep the previous value (tested with previous `true` and previous `false`); one capability failing does not change the other; "no flag stored" through `getServerCaps()` returns `{false,false}`.
- Second banking (5.5): `bankingView.netToBank` and `markCashBanked` with vectors V11 and V12; property P7 below.
- Ceilings (finding 1): V14 gives `cashShortfall` true, `awaiting` false, Mark Banked blocked; V10 gives amber with Mark Banked enabled; property P8 below.
- Combined slip (finding 2): V13 through `markCashBanked` (fake-indexeddb) gives AM 80, PM 200; `syncDepositSlip` (mocked Supabase) sends `amount` 280; a covered period with a null `depositNetAmount` sends `amount: null`.
- Period totals (finding 3): `balanceBreakdown` on V1 and V2 returns `tithingRecorded` 300 and 820, `fundsKept` 310 and 700; each `*Totals` helper returns both.
- **P8 ceiling consistency:** for any ledger where no line is `CashBanked`, after simulating banking all eligible lines, `titheCashBanked(after) === titheCashAvailable(before)`, and `C <= titheCashAvailable(before)` implies the post-banking `cashExpensesExceedCash` is false.
- **P7 repeat-banking consistency:** for any ledger, banking in one step or in two steps (cash split at any point) ends with the same `depositNetAmount` (`Bg - C`), and the sum of the physical deposits equals that amount.

Category tests (section 27.8), added in revision 6:

- `expenseCategories.test.ts`: `resolveCategoryList` for vectors CV1-CV8 (Appendix C) under REPLACE, and under MERGE through a second table so D18's alternative is pinned; the built-in default list has six labels, each valid under the label rules, none equal to "Other"; `validateCategoryList` rejects 0, 9, duplicate (any case), "other", 41 characters, control characters and untrimmed labels.
- `expenseCaptureValidation` extension: no category fails with field `category`; Other with empty, 61-character, control-character and 9-digit descriptions fails with field `categoryOther`; Other with "Gas bottle" passes; a non-Other category with a description present is rejected (the description is cleared); labels not in the list are rejected on the client even though the server would accept the format.
- Property P9 (category format): for any generated (label, other) pair, the client validator accepts it iff the pure re-statement of the server CHECK accepts it (the CHECK is restated as a TypeScript predicate in the test and pinned to the SQL text by a comment).
- `serverCaps.test.ts` extended: three flags; `expenseCategory` follows the same rules per branch and does not disturb the other two.
- `cacheLoader` test: the category query is in the same `allSettled` pass; failure keeps the cached rows; success replaces; a missing table logs one warning and the default list shows.
- `syncEngine.expense.test.ts` extended: the sync row carries `expense_category` and `expense_category_other` when `expenseCategory` is true and omits both when false; a line captured under a list that was later replaced still syncs.
- Server (`supabase/tests/expense_category.test.sql`, unexecuted here): the cases listed at the end of `20261124115000_expense_category.sql`.

Pure view-model helpers (so the UI tasks are verifiable in the node-only test environment, F19). Each is a
side-effect-free function in `src/capture/` or `src/lib/`, unit tested before the component uses it:

| Helper | Returns | Used by |
|---|---|---|
| `expenseCaptureValidation({source, officerId, amount, date, description, officerIds, category, categoryOther, categoryLabels})` | `{ok:true}` or `{ok:false, field, message}` | Expenses capture bar (R1.1-1.6, R10.1, R10.9) |
| `resolveCategoryList(rows, ids)` and `categoryListView(rows, ids)` | ordered labels plus the built-in "Other", and a source note ("Apostleship list", "District list", "Standard categories") | Expenses capture bar, HO category screen preview (R10.4, R10.5) |
| `validateCategoryList(labels)` | `{ok:true}` or `{ok:false, index, message}` | HO category screen (R10.2) |
| `deleteDialogText({kind, officerName, amount, proofCount})` | dialog string (R6.2) | delete dialog |
| `bankingConfirmationModel(view, isLaterBanking)` | rows and deposit amount, `blocked` reason (R4.1, R4.2, R3.7) | Mark Banked dialog |
| `capturePanelModel(breakdown)` | rows, verdict (`balanced`/`awaiting`/`notBalanced`/`cashShortfall`), message | right-hand balance card (R3.6, R3.7) |
| `expenseProofState(lineProofCount, legacyFields)` | `"ok"` or `"proofRequired"` (R5.1, R5.2) | expense rows, Submit guard |
| `auditExpenseRows(lines, attachments)` | rows with badge, officer, proofs, mismatch warning (R8.1, R5.6) | Audit page |
| `chairpersonTotals(lines)`, `elderTotals(lines)`, `overseerTotals(lines)`, `hoTotals(lines)`, `secretaryTotals(lines)` | the numbers each screen shows, all built from `balanceBreakdown` and `officerTithingTotals` (R8.2) | the five review screens |

Not testable here: React rendering (no jsdom, F19; adding jsdom is not part of this spec). UI behaviour is covered by the pure helpers above plus a manual UAT script in `tasks.md` T28.

## 19. Rollout order

1. Land the migration file in git (it is inert) and the spec. Nothing runs.
2. Decide the open decisions (section 21). D8 is answered first: it decides whether `20261124095000_payment_type_cashbanked.sql` exists (T13) or the widening stays as section 5 of the main migration. When separate, it is applied and verified before `20261124100000_expense_payment_source.sql`.
3. Client library and tests (balance, tithing, repo, Dexie v5), behind the capability flag so a pre-paid UI is hidden.
4. Test the migration on a disposable stack with the SQL suite. This needs Docker or a disposable project the user names.
5. The user explicitly authorises applying to `cwdyixafvylzgtpsfmwr`. Apply (the user runs the DROP statements in the SQL Editor), then verify read-only.
6. Push the client. Because the capability probe only enables pre-paid once the columns exist, step 5 before step 6 is the safe order; the reverse order still works for cash expenses.
7. Full UAT of the Treasurer, Auditor and Chairperson flows with test data; then the demo data preparation.

Vercel previews deploy from the branch and point at the dev/demo backend, so a push of client code that sends the new
columns before step 5 would break line sync on the preview. The omit-when-capability-false rule (section 12) prevents that.

## 20. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| R-1 Reader omission: a screen sums Expenses or tithing without the new rule | Wrong totals shown to an Elder or HO | One shared module; all readers listed in F17 changed; tests; T15 reads unverified readers |
| R-2 `CashBanked` fails the `payment_type` CHECK (F7) | Banked periods never reach the server; balance function sees no `CashBanked` | D8: widen in this migration or fix first; disposable-stack test of a banked period |
| R-3 Cash expense frozen after banking, no reverse banking | A rejected period with a wrong cash expense cannot be corrected | Flag (D13); follow-up spec; server already allows slip delete while editable |
| R-4 Server recompute differs from the client for edge data (rounding, legacy rows) | A period submitted balanced shows unbalanced to the auditor | Shared golden vectors; cent rounding on both sides; `client_balanced` echoed for diagnosis |
| R-5 Per-period cash ceiling when AM cash funded a PM expense | A legitimate PM cash expense is blocked | Rule is per period; record the expense as pre-paid or in the AM period; revisit with the user (D3) |
| R-6 Self-dealing (section 14) | Inflated officer tithing | Visibility, forced proof, two-person sign-off, optional later mapping |
| R-7 IndexedDB growth with many photo blobs | Device storage pressure | Blobs are cleared after upload (existing pattern); images compressed (existing) |
| R-8 Capability flag absent or wrongly false | Prepaid hidden on a migrated backend (restored session, never probed) | Absent = false is fail-safe; only `42703`/`PGRST204` set false; other errors keep the previous value; re-probed on every online login (`nextServerCaps` unit-tested per branch); error shape marked UNVERIFIED and confirmed on the stack |
| R-10 Second banking replaces the slip photo | Auditor sees only the latest deposit photo, while the amount is the sum | Documented simplification (5.5); amount is the whole-period net; D16 offers the block-after-banking alternative |
| R-11 Interim officer rejected by HO after a pre-paid expense | A later edit changing the officer fails 23514; existing rows stay valid | Trigger tests officer only on insert or when officer/source changes (4.1); accepted, revisit with HO officer-approval workflow |
| R-12 Category lists drift between scopes (merge versus replace unclear, or a congregation sees an unexpected list) | Inconsistent labels in reports | D18 recorded with a recommendation; the HO screen shows which list is in force and from which scope; one pure resolver; vectors CV1-CV8 |
| R-13 Free text in "Other" holds sensitive data (an account number, a password) | Sensitive data stored and shown to reviewers | 60-character limit, control characters rejected, digit-run guard (D19), explicit hint, never logged; residual: a short secret in words cannot be detected |
| R-14 A congregation captures an expense offline under a list that is replaced before it syncs | Line label not in the current list | Snapshot label; server checks format only (10.8); reports group by label text |
| R-9 Old PWA build open during rollout | Old build omits the field | Trigger defaults it (R9.3) |

## 21. Open decisions (the user must answer)

| # | Decision | Recommendation | Trade-off |
|---|---|---|---|
| D1 | Is expense proof forced even when the congregation's `proof_mandatory` is false (the demo setting)? | Yes, for both sources (matches "proof is forced for both") | Demo capture needs a photo for every expense; EFT and DirectDebit proofs stay governed by the setting (Burial proof is exempt under the burial-notice-and-trend spec) |
| D2 | May cash expenses be paid from burial cash, or only tithe cash? | Tithe cash only | Burial is district money; stricter, but a congregation that spends burial cash must record the expense as pre-paid |
| D3 | Cash ceiling per period or per week (AM+PM combined)? | Per period | Simple and matches banking per period; a PM expense paid from AM cash must be entered as pre-paid or in the AM period |
| D4 | Does the R500 threshold count both sources? | Yes, total of all expenses | Elder sees all spending; counts officer-funded purchases too. Alternative: cash only |
| D4b | Enforce the Elder comment on the server too? | Yes, in a follow-up | Closes a client-only control; risks blocking old data if added carelessly |
| D5 | Derived officer total (recommended) or a materialised offset line? | Derived | See section 3.2 |
| D6 | Does a pre-paid expense count toward the officer's faithfulness reading, and belong to his Officers total? | Yes to both (A2, A3) | If the Members tab should hold it instead, change one filter in `officerTithing.ts` |
| D6b | Period-level headline: show "Total tithing recorded" (income lines + pre-paid, V2 = 820) alongside "Funds banked or kept" (V2 = 700), or only one? | Show both, named as in requirement 2.8 | Two numbers need a caption each; showing only 820 would overstate what was banked, only 700 would contradict "tithing must be increased" |
| D7 | Which officers are selectable? The Elder is excluded from the cache today (rank filter in `cacheLoader.ts` 56-58). | Same list as the Officers tab (priests and underdeacons, interim included); Elder excluded | If an Elder pre-pays, the cache filter and officer rank rules need a change |
| D8 | Widen the `payment_type` CHECK (add `CashBanked`, `CashPending`) inside this migration, or as an earlier bugfix? **Must be answered in T0**, because it decides the migration file set. | Separate bugfix migration `20261124095000_payment_type_cashbanked.sql`, authored by T13; section 5 is then removed from the main migration | Same SQL either way; a separate file makes the defect visible and independently testable. "Inside" skips T13 |
| D17 | Periods whose manifest was frozen before the migration: keep the legacy review-ready result, or judge them by the new rule? | Keep legacy (`balance_rule = 1`, migration section 7a) | A few old manifests are judged by a rule that cannot balance cash expenses; but nothing already submitted is blocked. Alternative: new rule for all, and affected periods must be re-captured. Today 0 manifests exist, so the choice is free now and costs more later |
| D16 | Second banking on the same period: allow (recommended, rule 5.5) or block cash lines once cash is banked? | Allow; `depositNetAmount` is overwritten with the whole-period net; latest slip photo | One slip record covers two physical deposits. Block option is simpler but leaves late cash with nowhere to go |
| D9 | Self-dealing: accept visibility plus two-person sign-off, or add an officer-to-user mapping now? | Accept now; add `officers.user_id` later | Mapping needs data entry for every officer |
| D10 | Store Invoice No. in `bank_reference` or a new column? | Reuse `bank_reference` | Name mismatch vs one more column |
| D11 | Supplier and document amount fields: add now (optional)? | Yes, optional | Slightly longer proof dialog; ready for OCR |
| D12 | Server recomputes balance, ignoring the client flag? | Yes | A client/server mismatch shows as "does not balance" at audit |
| D13 | Cash expenses frozen once cash is banked; build "reverse banking" later? | Freeze now; reverse-banking spec next | Without it, a Rejected period with a wrong cash expense is stuck |
| D14 | A purchase paid partly from cash and partly by an officer: two lines (A4)? | Two lines | One line with two sources would need a split table |
| D15 | Net deposit of R0: allow marking banked with no slip photo? | Yes | Otherwise the treasurer would have to photograph nothing |
| D18 | When an Apostleship has its own category list and its District has one too, does the more specific list REPLACE the broader one, or MERGE with it? (Open; the build default until answered is REPLACE. Answer together with Spec 2 O1, the same question for notices.) | REPLACE: the most specific list in force applies entirely | Replace: the DHO of an apostleship controls the whole list, no duplicates, always at most 8 labels. Merge: a district-wide list always shows and apostleships only add, but the list can exceed 8, labels can duplicate and an apostleship cannot drop a district label |
| D19 | Digit-run guard on the "Other" description: reject a run of 9 or more consecutive digits? | Yes (client side; the server stays format-only) | Blocks an accidental account or ID number; also blocks a legitimate long invoice number typed into the description (the Invoice No. field on the proof is the right place for it) |
| D20 | Is a category required on every NEW expense? | Yes, with "Other" as the escape | Forces data quality; a Treasurer who finds no fit picks Other and describes it. Alternative: optional, which leaves most lines "Uncategorised" |
| D21 | Category subtotals or reports (per category totals on review screens)? | Not now | Out of scope; the stored label snapshot makes it a later read-only addition |

### 21.1 If the answer differs from the recommendation

Requirements that depend on a decision carry a tag such as `[D2]` (see `requirements.md`). Change set per decision:

| Decision | If answered differently | Files and functions that change | Vectors that change |
|---|---|---|---|
| D1 (forced proof) = "follow `proof_mandatory`" | R5.1 and R5.9 become conditional on the setting | `missingProofs` in `CashbookForm.tsx`; `computeReviewReadiness` in `completeCapture.ts`; item (ii) of `cashbook_review_ready` in the migration | none (proof, not money) |
| D2 (tithe cash only) = "any cash" | R3.1(b) and R3.7 ceilings use all cash | `titheCashBanked` becomes `cashBanked` and `titheCashAvailable` becomes all cash (incl. burial) in `balanceBreakdown`; `tithe_cash_banked` filter in `cashbook_period_balance`; R3.7 message and R4.6 | V5 becomes balanced (net deposit 30); V3 unchanged |
| D3 (per period) = "per week" | Ceiling sums AM and PM of the week | `balanceBreakdown` gains a week-level variant; server function takes the week's periods; R4.6 | V3-V5 unchanged; add a week vector |
| D4 (both sources) = "cash only" | R7.2 counts `C` only | `monthlyExpensesExceedThreshold` input filter; R7.3 and R7.4 text | none (threshold vectors only) |
| D5 (derived) = "materialised" | Replace section 6 with an offset line and widen `payment_type` further | Large: new item type excluded from every banked/pending/cash sum, CHECK widened, atomic two-row create/delete; R2.1-2.5 rewritten | V2 changes (extra Officers line) |
| D6 (counts toward faithfulness, Officers total) = "Members tab" | R2.4 placement and R2.5 | one filter in `officerTithing.ts`; Officers/Members tab rendering | none |
| D7 (same officer list) = "include Elders" | R1.2 list | rank filter in `cacheLoader.ts` 56-58 and the officer rank rules | none |
| D15 (R0 net deposit without slip) = "slip always" | R4.5 removed | `markCashBanked` zero path; item (iii) of `cashbook_review_ready` | V4 deposit step |
| D17 (legacy manifests keep old rule) = "new rule for all" | R3.11 removed | Drop migration section 7a, the `balance_rule = 1` branch of `cashbook_review_ready`, and the `balance_rule` column; any period flagged by the pre-apply check must be re-captured | none |
| D18 (replace) = "merge" | R10.4 resolves to the union of the District and Apostleship lists, de-duplicated case-insensitively, District labels first, then the Apostleship labels; the 8-label cap applies per list, not to the union | `resolveCategoryList` in `src/lib/expenseCategories.ts` (one function); the HO screen preview text; vectors CV3, CV4, CV6 change (Appendix C); no SQL change (the SQL stores lists per scope either way) | CV3, CV4, CV6 |
| D19 (digit-run guard) = "no guard" | R10.9 loses the 9-digit rule | `validateOtherDescription` in `expenseCategories.ts` and its test; no SQL change | none |
| D20 (required) = "optional" | R10.1 allows saving with no category | `expenseCaptureValidation` rule; `expenseProofState` unaffected; "Uncategorised" appears on new lines too | none |
| D16 (allow second banking) = "block" | R4.9 replaced by a block rule | `assertCashLinesEditable` also guards Members/Officers/Burial cash adds | V11, V12 removed |

## 22. Assumptions and unverified items

- (Revision 6) Where today's Burial capture bar offers an officer picker was not read; requirement 1.10 holds either way and T9 reads it. `SecretaryReview.tsx` was not read for the category display; the Secretary shows no category detail (R10.12).
- (Revision 6) The SQL in `20261124115000_expense_category.sql` has never been parsed by Postgres. It calls the three shared helpers defined in `20261124110000_scope_notice.sql`, also unparsed. Both are checked only on a disposable stack (T27).
- (Revision 6) The Secretary read path for category rows is proven only on a stack (no Secretary access row exists in the test data, Spec 2 F27).

- The Chair/Elder/Overseer/HO/Secretary screens (F17) were read only where cited. T15 reads each fully before editing.
- Existing triggers on `cashbook_line_item` and the exact UPDATE RLS for locked periods were not read. The trigger name and
  order are confirmed on the disposable stack.
- `amount` precision on the server is plain `numeric`; the design rounds to 2 decimals.
- `CapturePage.tsx` was not re-read for this spec beyond findings section 2.4; the capability flag read follows its
  existing `getProofMandatory` pattern.
- The two live NULL `payment_type` Expense rows are covered by the CHECK (NULL passes).

## Appendix C: Category resolution vectors (client; the server stores lists per scope only)

Congregation ids: district D1, apostleship A1. Default list = `EXPENSE_CATEGORY_DEFAULTS` (six labels, 27.3). "Other" is always appended and is omitted from the Result column. Build default = REPLACE.

| Case | Configured lists | Result (REPLACE) | Result (MERGE, if D18 changes) |
|---|---|---|---|
| CV1 | none | the six defaults | the six defaults |
| CV2 | D1 list: Cleaning, Repairs | Cleaning, Repairs | Cleaning, Repairs |
| CV3 | D1 list: Cleaning, Repairs; A1 list: Repairs, Transport | Repairs, Transport | Cleaning, Repairs, Transport |
| CV4 | A1 list only: Transport | Transport | Transport |
| CV5 | A2 list (another apostleship) only | the six defaults | the six defaults |
| CV6 | D1 list: Cleaning; A1 list: cleaning (lower case) | cleaning | Cleaning |
| CV7 | D1 list retired (cleared); A1 list: Transport | Transport | Transport |
| CV8 | rows for a different district only | the six defaults | the six defaults |

## Appendix A: Golden vectors (client and server must agree)

Amounts in rand. `CB` = `CashBanked`, `Cash` = unbanked cash, `Bur` = unbanked Burial line, `CBur` = banked burial cash.

In this table `titheCash` is `titheCashBanked` (the post-banking ceiling). Pre-banking vectors (V6, V10, V14) are judged by `titheCashAvailable`, listed in their rows.

| Vector | Lines | income | electronic | cashBanked | titheCash | cashExp | prepaid | netDeposit | balanced |
|---|---|---|---|---|---|---|---|---|---|
| V1 | Members CB 300; Burial CB 50; Expense cash 40 | 350 | 0 | 350 | 300 | 40 | 0 | 310 | true |
| V2 | Officers EFT 500; Members CB 200; Expense prepaid 120 (X) | 700 | 500 | 200 | 200 | 0 | 120 | 200 | true (tithingRecorded 820, fundsKept 700) |
| V3 | Members EFT 100; Expense cash 20 | 100 | 100 | 0 | 0 | 20 | 0 | -20 | false |
| V4 | Members CB 100; Expense cash 100 | 100 | 0 | 100 | 100 | 100 | 0 | 0 | true |
| V5 | Members CB 100; Burial CB 50; Expense cash 120 | 150 | 0 | 150 | 100 | 120 | 0 | 30 | false |
| V6 | Members Cash 100 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | false (awaiting) |
| V7 | Members EFT 100 | 100 | 100 | 0 | 0 | 0 | 0 | 0 | true |
| V8 | Members EFT 100; Expense prepaid 80 (Y) | 100 | 100 | 0 | 0 | 0 | 80 | 0 | true |
| V9 | Members CB 0.10; Members CB 0.20; Expense cash 0.30 | 0.30 | 0 | 0.30 | 0.30 | 0.30 | 0 | 0 | true |
| V10 | Members Cash 100; Bur 50; Expense cash 40 | 150 | 0 | 0 | 0 | 40 | 0 | n/a | false (awaiting; pending 150 includes burial) |

Banking sequence vectors (rule 5.5). `Dep` = physical deposit at that step, `depositNetAmount` = stored after that step:

| Vector | Steps | Expected |
|---|---|---|
| V11 | Members Cash 300; cash expense 40. Bank (1). Add Members Cash 50. Bank (2). | Step 1: `netToBank` = 300 - 40 = 260, Dep 260, `depositNetAmount` 260 (Bg 300, C 40). Step 2: `netToBank` = 50 (C not subtracted again), Dep 50, `depositNetAmount` = 350 - 40 = 310 (overwritten, not 260+50-40). Final: balanced, `netDeposit` 310, total physical deposits 310. |
| V12 | Members Cash 100; Burial Cash 50; cash expense 20. Bank (1). Add Burial Cash 30. Bank (2). | Step 1: `netToBank` 150 - 20 = 130, `depositNetAmount` 130. Step 2: `netToBank` 30, `depositNetAmount` 180 - 20 = 160. Server: `net_deposit` 160 = slip amount; balanced. |

| V13 | Combined AM+PM slip. AM: Members Cash 100 and cash expense 20. PM: Members Cash 200. Bank combined from PM. | AM `depositNetAmount` 80 (Bg 100 - C 20), PM `depositNetAmount` 200, both written in the one Dexie transaction. `syncDepositSlip` amount = 80 + 200 = 280. Dialog shows 280 to deposit. Server `net_deposit` AM 80 + PM 200 = 280 = slip amount, `review_ready` true for both. Each period is judged against its own ceiling (AM: C 20 <= Ta 100). |
| V14 | Blocked first banking. Members Cash 100; Burial Cash 50; cash expense 120; nothing banked yet. | Ta = 100 (burial excluded, D2), Tb = 0, C 120 > Ta 100: `cashShortfall` true, Mark Banked blocked with the R3.7 message, `awaiting` false, `balanced` false. Contrast V10 (C 40 <= Ta, so amber and Mark Banked enabled). Banking would only become possible after the expense is corrected or re-entered as pre-paid. |

Officer totals: V2 officer X paid-in 500 (EFT, payment type unchanged), prepaid 120, total 620. Period totals for V2: `tithingRecorded` = 500 + 200 + 120 = 820, `fundsKept` = 700 - 0 = 700. V1: `tithingRecorded` 300 (Members only; burial is not tithing), `fundsKept` 350 - 40 = 310.

## 23. Responses to design review (review.json, revision 2)

Only findings addressed to this spec are listed; findings 1, 6-9, 11, 12 and 14 belong to `burial-notice-and-trend`.

| # | Severity | Response | Where |
|---|---|---|---|
| 2 | MEDIUM | Addressed. Absent flag = `false`; only `42703` or `PGRST204` sets `false`; any other error keeps the previous value; success sets `true`; the `limit 0` PostgREST error shape is marked UNVERIFIED with a confirm-on-stack step; one unit test per branch plus "no flag stored". Logic lives in the pure `nextServerCaps`. | section 12, section 18, R-8, requirement 9.5, task T7 and T12 |
| 3 | MEDIUM | Addressed with the recommended rule. A later banking deposits `cashPending` (C not subtracted twice); `depositNetAmount` is overwritten with the whole-period `Bg_total - C`; the slip photo is replaced as today; combined AM+PM sums the periods. Vectors V11, V12 and property P7 added. Alternative (block cash lines after banking) recorded as D16. | section 5.2, 5.5, 9.2, Appendix A, requirement 4.9, task T11 |
| 4 | MEDIUM | Addressed. Task T13 authors `20261124095000_payment_type_cashbanked.sql` (widening only, NOT APPLIED header, SQL assertions for `CashBanked` and `CashPending`) and removes section 5 from the main migration; T0 requires D8 first; if D8 = "inside", T13 is skipped. Section 4.1 and D8 now state one consistent file set. | section 4.1, 19, 21 (D8), tasks T0, T13 |
| 5 | MEDIUM | Addressed. T18 is split per screen (T21 Audit, T22 Chairperson, T23 Elder, T24 Overseer, T25 HO, T26 Secretary), each with a pure aggregation function unit-tested on Appendix A vectors before the UI edit. The UI tasks (T18-T20) each have a pure-helper verification (`expenseCaptureValidation`, `deleteDialogText`, `bankingConfirmationModel`, `capturePanelModel`, `expenseProofState`); the manual script now only covers rendering. | section 18 helper table, tasks T17-T26 |
| 10 | MEDIUM | Addressed. Criteria depending on D1-D7, D15, D16 are tagged `[Dn]` in `requirements.md`; section 21.1 lists, per decision, the files, functions and vectors that change if the answer differs. | requirements.md, section 21.1 |
| 13 | NIT | Addressed. F1 now cites lines 54, 58, 72, 90. | section 2 (F1) |

## 24. Responses to design review (review.json, revision 3)

Findings 6-14 belong to `burial-notice-and-trend` and are not answered here.

| # | Severity | Response | Where |
|---|---|---|---|
| 1 | MEDIUM | Addressed. Two named quantities: `titheCashAvailable` (entered, used before banking for the Mark Banked block and the amber test) and `titheCashBanked` (used for the post-banking `balanced` test and the server). Mark Banked is blocked by `C > titheCashAvailable`; because `markCashBanked` banks all eligible lines at once (`captureRepo.ts` 515-585) the two are equal after banking. Vector V14 (Members Cash 100, Burial Cash 50, cash expense 120) is the blocked case; property P8 added. The glossary no longer has a third reading. | requirements glossary, 3.1(b), 3.7, 4.1, 4.6; design 5.1, 5.2, 9.1, Appendix A, section 18 |
| 2 | MEDIUM | Addressed with the recommended rule. `depositNetAmount` is always the period's own whole-period net; the AM value is written in the same Dexie transaction; `syncDepositSlip` sends the sum over covered periods (null if any covered value is missing); requirements 4.3 and 4.6 and design 5.5, 9.2, 9.4 now agree. Vector V13 (AM 80, PM 200, slip 280) added. The migration already sums `net_deposit` over `cashbook_deposit_slip_period` (lines 366-379), so it needs no change. | requirements 4.3, 4.6; design 5.5, 9.2, 9.4, Appendix A |
| 3 | MEDIUM | Addressed. Two named period-level numbers: `tithingRecorded` = Members + Officers + pre-paid (V2: 820) and `fundsKept` = income - cash expenses (V2: 700). Both are returned by `balanceBreakdown`, shown by every review screen and returned by each `*Totals` helper; neither is swapped for the other. Requirement 2.8 added. The user answer needed is recorded as D6b (recommend both). | requirements 2.8, 8.2; design 5.1, 6, 13, section 18, D6b, Appendix A |
| 4 | MEDIUM | Addressed. Verified in code: the interim insert sets `is_active: true` (`CashbookForm.tsx` 158), so interim officers pass the trigger and stay in R1.2. The live column default of `officers.is_active` was not read and is marked UNVERIFIED, because the form path does not depend on it. Residual risk of HO later rejecting an interim officer recorded as R-11. | requirements 1.2; design 4.1, R-11 |
| 5 | NIT | Addressed. 4.8 now precedes 4.9, 9.3 precedes 9.4 and 9.5. F11 states the slip rule sits inside the `proof_mandatory = true` branch and that the new expense-proof and balance checks sit outside it. | requirements 4, 9; design F11 |

## 25. Responses to design review (review.json, revision 4)

Findings 1, 2, 4 and 7-10 belong to `burial-notice-and-trend` and are not answered here.

| # | Severity | Response | Where |
|---|---|---|---|
| 3 | MEDIUM | Addressed. Read-only aggregate query on the dev/demo backend: 14 periods, 7 with Expenses rows, 0 rows in `cashbook_submission_manifest`, so no period flips today (F21). The migration header now carries an id-level PRE-APPLY IMPACT CHECK (SELECT only) to re-run before applying. Rule chosen: a manifest frozen before the migration keeps the legacy review-ready semantics through a new `balance_rule` column (1 = legacy, 2 = new, default 2 for new rows); `cashbook_review_ready` has a verbatim legacy branch for rule 1. Recorded as D17 with the alternative and its change set. | requirements 3.10, 3.11; design F21, 4.1, D17, 21.1; migration 7a, 8, header; task T27 |
| 5 | NIT | Addressed. Citations corrected to `CashbookForm.tsx` 158 and `cacheLoader.ts` 56-58. | requirements 1.2; design 21, 24 |
| 6 | NIT | Addressed. R9.1 reads "next free version (5 at the time of writing)". | requirements 9.1 |

## 26. Responses to design review (specs-expense-burial-2026-11/review.json, revision 5)

Findings 3, 4, 5, 8 and 9 belong to `burial-notice-and-trend` and are not answered here.

| # | Severity | Response | Where |
|---|---|---|---|
| 1 | MEDIUM | Addressed with the recommended fix. R3.1(c) deleted; R3.1 now says "both hold" and states that the CHECK constraint and guard trigger guarantee a valid officer, so the balance function has no officer term (consistent with 5.1, V1-V14, `cashbook_period_balance` and R3.4). | requirements 3.1 |
| 2 | MEDIUM | Addressed for this spec. R3.11 now states that the Burial proof exemption of `burial-notice-and-trend` applies to both the rule-1 legacy branch and the rule-2 block, so that spec's diff expects two identical edits. The choice (both branches) is the reviewer's recommendation; it only relaxes a check and 0 manifests exist. | requirements 3.11 |
| 6 | NIT | Addressed. `supabase/migrations/20261124095000_payment_type_cashbanked.sql` is authored (NOT APPLIED). Section 5 of the main migration is a pointer comment and its header says to apply the separate file first. T13 is now "review and test". D8 stays an open decision: if the user answers "inside", the statements move back. | design 4.1, D8; tasks T13; both migration files |
| 7 | NIT | Addressed. D1 now reads "EFT and DirectDebit proofs stay governed by the setting (Burial proof is exempt under the burial-notice-and-trend spec)". | design D1 |

## 27. Expense categories (configuration, scope, line columns, capture control)

Owner: this spec (requirement 10). Reused from `burial-notice-and-trend` (Spec 2), not copied: the SQL helpers `scope_resolve_district`, `scope_assert_ho` and `scope_district_readable` (migration `20261124110000_scope_notice.sql`), the `admin-write` gate block and error mapper, `adminApi.invoke`, the HO `ScopePicker` and the offline-block pattern. This spec adds only what is category-specific.

### 27.1 Model

A category list is a small ordered set of labels at one scope node (District or Apostleship). A congregation sees one list: the most specific scope that has a list (open decision D18 decides replace versus merge; build default REPLACE), else the built-in default. "Other" is built in, always last, never stored in the configuration. Each expense line stores the chosen label as a snapshot plus, for Other, a short description. Labels are plain text; there is no category id on the line, so renaming a configured category later does not rewrite history, and the server never has to join to a list at sync time (the offline device may be using a list the server has since replaced).

Alternatives considered for the line reference: (a) a foreign key to the config row, rejected because lists are replaced wholesale (retire and insert), because an offline device can hold a retired row id, and because a FK would make an old line unsyncable; (b) a stable category code per label, rejected as extra configuration for no reader that needs it today (D21 defers reports). Chosen: label snapshot.

### 27.2 Server (migration `20261124115000_expense_category.sql`, authored, NOT APPLIED)

| Piece | Detail |
|---|---|
| Line columns | `expense_category text`, `expense_category_other text`, both NULL by default and on every non-Expenses row. |
| CHECK | Either both NULL, or an Expenses row with a trimmed 1-40 character label free of control characters, and: label `Other` needs a trimmed 1-60 character description free of control characters; any other label needs the description NULL. `is not null` guards prevent a NULL in the expression from letting a bad row pass. |
| Config table | `expense_category_config(id, scope_level in ('District','Apostleship'), scope_id, district_id, label, sort_order 1-8, is_active, retired_at, retired_by, created_by, created_at)`; label CHECKs (trimmed, 1-40, no control characters, not `other`); unique active `(scope, lower(label))` and `(scope, sort_order)`. |
| RLS | SELECT only for `authenticated`, policy `is_active and public.scope_district_readable(district_id)`: every role, same rule as notices. No write grant. |
| `expense_category_publish(p_actor, p_scope_level, p_scope_id, p_labels jsonb)` | `service_role` only. `scope_assert_ho(actor, null)` -> validate 1-8 string labels (trim, length, control characters, not `Other`, unique ignoring case) -> `scope_resolve_district(level, id, ['District','Apostleship'])` -> `scope_assert_ho(actor, district)` -> advisory lock on the scope -> retire the scope's active rows -> insert the new rows in order. One transaction. 22023 / 42501. |
| `expense_category_clear(p_actor, p_scope_level, p_scope_id)` | Same checks, retires the scope's active rows; idempotent. |

There is no date range, no overwrite prompt and no conflict result: the HO screen loads the current list and edits it, and publish replaces it atomically. History stays in the retired rows.

### 27.3 The built-in default list (synthetic)

```ts
export const EXPENSE_CATEGORY_DEFAULTS = [
  "Cleaning and hygiene",
  "Maintenance and repairs",
  "Utilities",
  "Stationery and printing",
  "Communion supplies",
  "Transport",
] as const;
export const OTHER_CATEGORY = "Other";   // built in, always last, reserved
```

These are placeholders for the demo, not a decision about what the church actually uses; the HO replaces them through the configuration screen. A unit test asserts each default is a valid label under 10.2.

### 27.4 Client

- Dexie store `expenseCategories: "id, district_id, scope_id"` in the same additive version as `lineProofs` (4.3). Row: `{ id, scope_level, scope_id, district_id, label, sort_order }`.
- `cacheLoader.ts`: add `supabase.from("expense_category_config").select("id, scope_level, scope_id, district_id, label, sort_order")` to the existing `Promise.allSettled` pass (Spec 2 adds the notice query to the same array); replace the store only when its own query succeeded; log one warning when the table is missing. Export `refreshExpenseCategories()` (one query, never throws), called when the Expenses tab mounts while online.
- `src/lib/expenseCategories.ts` (pure, no React, Dexie or Supabase): `EXPENSE_CATEGORY_DEFAULTS`, `OTHER_CATEGORY`, `resolveCategoryList(rows, { apostleship_id, district_id }, mode = "replace")` returning labels in order, `categoryListView` (labels plus source note), `validateCategoryLabel`, `validateCategoryList`, `validateOtherDescription` (length, control characters, digit-run guard per D19).
- `captureRepo.addLineItem` and `updateLineItem` accept `expense_category` and `expense_category_other`; both repo functions reject a missing category on a new expense (D20), an Other with no description, and a description with a non-Other category (the description is cleared on the client before the call). `MUTABLE_LINE_FIELDS` gains both fields. `syncLineItem` sends them only when `getServerCaps().expenseCategory` is true.
- Editing category or description after cash is banked is allowed (R10.10): the freeze guard `assertCashExpenseEditable` is not called for a change that touches only these two fields.

### 27.5 Capture control

A required `<select>` below the source control, no default option, listing the resolved labels then "Other". Choosing "Other" shows a single-line input with `maxLength` 60 and the hint "Never enter passwords, PINs or account numbers."; choosing anything else hides and clears it. Validation runs through `expenseCaptureValidation` (section 18) and shows an inline error naming the field (`category` or `categoryOther`). The capture row and the Audit page show "Category" and, for Other, the description.

### 27.6 Rules (single statement)

| Rule | Client | Server |
|---|---|---|
| Label trimmed, 1-40, no control characters | `validateCategoryLabel` | CHECK + publish function |
| 1-8 labels per list, unique ignoring case, not "Other" | `validateCategoryList` | publish function |
| Other needs a description, 1-60, no control characters | `validateOtherDescription` | CHECK |
| No 9-digit run in the description (D19) | `validateOtherDescription` | not enforced |
| Label is in the list in force | `expenseCaptureValidation` | not enforced (offline) |
| Scope is District or Apostleship, in the HO's districts | `ScopePicker` | `scope_resolve_district`, `scope_assert_ho` |

### 27.7 Administration (reuse)

`admin-write` gets two actions, `publish_expense_categories` and `clear_expense_categories`, in the same gate block as the notice actions. The entry validator is generalised by one dispatching function, `validateConfigRequest(payload)`, which calls the notice validator or `validateExpenseCategoryRequest` (added to the same self-contained module `supabase/functions/admin-write/scopeNotice.ts` and its byte-identical copy `src/lib/scopeNoticeRequest.ts`, so one copy test covers both and the SQLSTATE mapper is shared; the file name is historical). The gate order, the rpc call, the fixed error text per SQLSTATE and the rule "raw `error.message` never returned" are Spec 2's and are not repeated. Permission row `expense_categories.manage` (`HO: "M"`, every other role `-`). One screen `src/ho/ExpenseCategoriesScreen.tsx` at `/ho/expense-categories` (nav entry gated through `hasPermission`) with `ScopePicker` limited to District and Apostleship, an ordered editable list of 1-8 labels (add, remove, move up and down), Save and "Clear list", an inline error block with `role="alert"`, and the offline-unavailable block. All decisions come from the pure `src/ho/expenseCategoryForm.ts` (`validateCategoryForm`, `categoryEditorState`).

### 27.8 Tests

Listed in section 18 (category tests) and in the SQL file footer. Property P9 pins client and server format rules together.

### 27.9 Rollout

Client works before any SQL is applied: no config rows are read (query error logged once), the six defaults and "Other" show, categories are captured locally, and the sync row omits the category fields until the capability probe sees the columns. Apply order: `20261124095000`, `20261124100000`, `20261124110000` (Spec 2), then `20261124115000`, only after the SQL tests pass on a disposable stack and with explicit user authorisation. Nothing is applied by this spec.

## 28. The Expenses notice and the absence of a Notes column

The user first asked for "a small notes write-up" on expenses, then clarified that it should sit above the expense capture line, hold information about expenses, and follow exactly the process of the DHO-managed Burial notice. Design consequence: there is no per-line Notes field anywhere (requirement 11.1), and the notice is Spec 2's generalised notice with notice type `Expenses` (Spec 2 design 3.11 and requirement 11). This spec contributes only (a) the placement constraint on the Expenses tab (7.1) and (b) a task ordering dependency (the capture UI task runs after Spec 2's notice component exists). The existing required Description of an expense is unchanged and is the only free text on a line besides the category's Other description.

## 29. Responses to the 2026-11-27 additions and the carried NITs (revision 6)

Source of the NITs: `.agents/tasks/specs-expense-burial-2026-11/review.md` (APPROVED against the older scope, 5 NITs). NITs 4 and 5 concern Spec 2 and are answered there (Spec 2 design 19.5).

| # | Item | Response | Where |
|---|---|---|---|
| U1 | Exactly two sources; no bank-account or other option | Requirement 1.9 states the two-value rule and that no third source exists; 1.10 states Burial carries no officer. A grep of both specs and all authored SQL for a bank-account-style source found nothing to remove (recorded in the commit message). | requirements 1.9, 1.10, A9, A11 |
| U2 | No per-line Notes; Expenses notice above the expense line | Requirement 11; design 28; the notice is Spec 2 requirement 11 and the generalised mechanism | requirements 11; design 7.1, 28 |
| U3 | Expense categories as HO/DHO configuration with "Other" | Requirement 10; design 27; migration `20261124115000_expense_category.sql`; Dexie v5 gains `expenseCategories`; capture control; tests; reuse of Spec 2 helpers | requirements 10; design 4.1, 4.3, 12, 16-18, 27 |
| U4 | Replace versus merge, and notice precedence, stay open | D18 (replace recommended, build default replace) answered together with Spec 2 O1 (unchanged, still open) | design 21, 21.1, Appendix C |
| N1 | NIT: requirements status said "revision 3" while the design was 5 | Both documents now say revision 6 | requirements line 3; design line 3 |
| N3 | NIT: response sections out of order (26 before 25) | Sections 23 to 26 are ascending with an index line | design section 23 |

## 30. Index of response sections

23 (review round 2), 24 (round 3), 25 (round 4), 26 (round 5), then 27 to 29 (revision 6). Ascending by number. Section 29 is the newest. Appendices follow the sections in file order: Appendix C (category resolution vectors, section 27) first, then Appendix A (golden balance vectors, section 5.4); the letters were assigned in the order the appendices were first needed, and each is referenced by its letter.
