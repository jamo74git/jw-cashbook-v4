# Implementation Plan: Expense Payment Source, Officer Pre-paid Expenses, Multi-proof and Balance Rule

> DRAFT, revision 3. Do not start until the user approves `requirements.md` and `design.md` and answers the Open Decisions
> (design.md section 21). No task here applies a migration to `cwdyixafvylzgtpsfmwr`, deploys, commits or pushes unless a
> task says so and the user has authorised it.
>
> Baselines to hold after every task (from `PROJECT-LOG.md`): `tsc --noEmit` 0 errors; vitest all passing (about 237 at
> c98feafd); lint = 1 known error (`_params` in `captureRepo.ts`) + 6 warnings, no new ones; `vite build` passes.
>
> Test environment: vitest runs in node (`include: src/**/*.test.ts`), with fast-check and fake-indexeddb, and no jsdom.
> UI tasks are therefore verified by pure view-model helpers tested first (T17, and one aggregation function per review
> screen), plus the manual UAT script in T28 for rendering only.

## Phase 0: Gate

- [ ] T0. Record decisions
  - Get the user's answers to D1-D17 and write them into `design.md` section 21 (a "Decision" column). **D8 is answered first**: it decides whether T13 runs.
  - Verification: every row has an answer; if an answer differs from the recommendation, the change set in section 21.1 has been applied to requirements, design and these tasks; D8, D16 and D17 are reflected in sections 4.1, 5.5 and 19 and in the migration file set.

## Phase 1: Pure logic and tests (no UI, no backend)

- [ ] T1. Capture the legacy oracle
  - Copy the current `isBalanced` into `src/lib/__fixtures__/legacyBalance.ts` (test-only) for property P3.
  - Verification: the file imports only `CaptureItem`; `vitest run` unchanged.

- [ ] T2. `balanceBreakdown` and delegates (R3.1-3.8, R4.9)
  - `src/lib/captureTotals.ts`: add optional `expense_payment_source` and `officer_id` to `CaptureItem`; add `balanceBreakdown` (returning `titheCashAvailable`, `titheCashBanked`, `tithingRecorded`, `fundsKept`, `cashExpensesExceedCash = C > titheCashAvailable`), `cashExpensesTotal`, `prepaidExpensesTotal`, `netDeposit`; make `isBalanced` delegate (post-banking test against `titheCashBanked`); extend `bankingView` (`cashExpenses`, `prepaid`, `netDeposit`, `netToBank` per design 5.2/5.5, `cashPending` now includes unbanked Burial). `src/lib/balanceState.ts` delegates to `awaitingBanking`.
  - Verification: new `captureTotals.balanceBreakdown.test.ts` passes vectors V1-V12 and V14 (Appendix A; V11/V12 for `netToBank` in first and later banking; V14 asserts `cashShortfall` true, `awaiting` false, and that a ledger with C <= `titheCashAvailable` is not shortfall, V10); V1 and V2 return `tithingRecorded` 300 and 820 and `fundsKept` 310 and 700; properties P1-P6 and P8 pass with 200 runs each; P3 (legacy equality with no expenses) passes.

- [ ] T3. Update tests that pin the old behaviour
  - `captureTotals.test.ts` Property 3 and `captureTotals.characterization.test.ts` lines 24-27: keep the legacy cases that are still true, replace the "unoffset expense is unbalanced" case with the cash-ceiling cases. Leave the R500 per-period defect characterization as is.
  - Verification: `vitest run` all green; a diff review shows only intended assertions changed.

- [ ] T4. `officerTithing.ts` (R2.1-2.3)
  - Add `officerTithingTotals` and `officerTithingByOfficer`.
  - Verification: `officerTithing.test.ts`: V2 gives paid-in 500, prepaid 120, total 620; tithe line payment types unchanged; P4 passes.

- [ ] T5. Manifest and readiness mirror (R3.8, R5.1)
  - `src/lib/completeCapture.ts`: carry `expense_payment_source` into the `CaptureItem` built in `computeRequiredManifest` and `computeReviewReadiness`; Expense lines are always proof-required in `computeReviewReadiness` regardless of `proofMandatory` (tag D1); `proofPresent` accepts a proof count.
  - Verification: extend `completeCapture.test.ts` and `completeCapture.reviewReady.test.ts`: a period with a cash expense and banked cash is ready; an expense with no proof is not ready even when `proofMandatory=false`.

- [ ] T6. Proof label helper (R5.4)
  - Add `src/capture/proofLabels.ts` with `proofFieldLabels(kind)`.
  - Verification: `proofLabels.test.ts`: expense returns "Invoice No."; eft, directDebit, burial, deposit return "Bank Ref".

- [ ] T7. Capability flag logic (R9.2, R9.5)
  - Add `src/utils/serverCaps.ts`: pure `nextServerCaps(previous, probeResult)` and `getServerCaps()` (reads `syncMeta['serverCaps']`, returns `{false,false}` when absent).
  - Verification: `serverCaps.test.ts` has one case per branch: nothing stored gives false; success gives true; code `42703` gives false; code `PGRST204` gives false; network error, 401 and 500 keep the previous value (run with previous true and previous false); one capability failing leaves the other unchanged.

## Phase 2: Local data layer (Dexie, repository)

- [ ] T8. Dexie v5 and types (R9.1)
  - `src/db/schema.ts`: add `expense_payment_source?` to `LocalLineItem`, `depositNetAmount?` to `LocalPeriod`, `LocalLineProof`, the `lineProofs` table and `version(5).stores({ lineProofs: "localId, lineLocalId, periodLocalId" })`. No `.upgrade()`. Read `schema.ts` first: if another spec already took version 5, use the next number and update R9.1.
  - Verification: new test seeds a v4 database (fake-indexeddb), opens v5, and all `lineItems`/`periods` rows are intact.

- [ ] T9. Expense add/edit validation and freeze (R1.1-1.7, R4.7)
  - Add pure `expenseCaptureValidation` (design section 18 helper table). `captureRepo.ts`: `addLineItem` accepts `expense_payment_source`; rejects missing source, prepaid without officer, cash with officer; `assertCashExpenseEditable` called from add, update and delete. Add `expense_payment_source` to `MUTABLE_LINE_FIELDS` in `syncEngine.ts`.
  - Verification: `expenseCaptureValidation.test.ts` (every rejection with its field name); `captureRepo.expense.test.ts` covers each repo rejection and the `CASH_ALREADY_BANKED` case; pre-paid edit after banking still works; a pre-paid expense for an interim officer record (`is_interim: true`, `is_active: true`) is accepted by `expenseCaptureValidation`. T27 adds the server case: insert for a pending interim officer passes the guard, and for an `is_active = false` officer fails 23514.

- [ ] T10. Multi-proof repo and delete cascade (R5.3, R5.7, R6.1)
  - `addExpenseProof`, `listLineProofs`, `countLineProofsByLine`, `removeUnsyncedLineProof`, `expenseProofSumMismatch`; `deleteLineItem` removes `lineProofs` rows in one transaction; `attachProof` delegates for Expense lines.
  - Verification: tests: three proofs on one line count 3; deleting the line leaves zero `lineProofs` rows for it; removing an uploaded proof is rejected; a failed transaction leaves both line and proofs; `expenseProofSumMismatch` table test.

- [ ] T11. Net-deposit banking including second banking (R4.3-4.6, R4.9)
  - `markCashBanked`: `expectedNetDeposit` option (physical deposit now), in-transaction recompute, `EXPENSES_CHANGED`, block when `C > titheCashAvailable` for any banked period, overwrite each banked period's own `depositNetAmount` with its whole-period `Bg_total - C` (AM written in the same transaction for a combined slip), zero-deposit path with no blob. Update its return type and callers.
  - Verification: extend `captureRepo.banking.test.ts`: V1 deposits 310; V11 (bank, add cash 50, bank again) gives deposits 260 then 50 and `depositNetAmount` 310; V12 gives 130 then 30 and 160; stale amount returns `EXPENSES_CHANGED` and writes nothing; net 0 banks without a blob; V13 (combined AM+PM) stores AM 80 and PM 200 as each period's own net, and V14 returns the blocked result with nothing written; property P7 (one-step and two-step banking end with the same `depositNetAmount`).

- [ ] T12. Threshold and capability probe (R7.1, R9.5)
  - `cacheLoader.ts`: select `expense_approval_threshold`; `captureRepo.getExpenseThreshold`. Add the probe that feeds `nextServerCaps` (read-only `limit 0` selects, each in `Promise.allSettled`).
  - Verification: `cacheLoader` test with a mocked client: threshold cached; probe success stores true; a schema-error probe stores false; a network-error probe leaves the stored value; a failing probe does not abort the reference refresh. Record in `PROJECT-LOG.md` that the PostgREST `limit 0` error shape remains UNVERIFIED until T27.

## Phase 3: Server migration authoring (no execution)

- [ ] T13. Review and test the separate `payment_type` migration (only if D8 = separate)
  - `supabase/migrations/20261124095000_payment_type_cashbanked.sql` is already authored (widening of the `payment_type` CHECK only, adds `CashPending` and `CashBanked`, NULL stays allowed, NOT APPLIED header), and section 5 of `20261124100000_expense_payment_source.sql` is already replaced by a pointer comment. If D8 = "inside", move the `ALTER TABLE` statements back into section 5 and delete the separate file. Add `supabase/tests/payment_type_cashbanked.test.sql` (insert of `CashBanked` and `CashPending` passes; an unknown type fails with 23514).
  - Verification: `Select-String` shows the `CashBanked` CHECK text in exactly one migration file; the migration timestamps sort `20261124095000` before `20261124100000`; both files carry the NOT APPLIED header; no statement was executed against any database. If D8 = "inside", record "skipped" in T0.

## Phase 4: Sync

- [ ] T14. Sync engine (R5.8, R9.2-9.4, R4.3)
  - `syncLineItem`: send `expense_payment_source` when `getServerCaps().expensePaymentSource` is true; add `syncLineProofs` (metadata columns only when `attachmentMeta` is true); `hasPendingProof` and final `stillPending` include `lineProofs`; `syncDepositSlip` sends `amount` = sum of `depositNetAmount` over every period the slip covers (null if any covered value is missing).
  - Verification: `syncEngine.expense.test.ts` (mocked Supabase): row contains the source; omitted with caps false (including when no flag is stored); three proofs upload in createdAt order with distinct object keys; retry reuses keys; a period with a local proof is not marked synced; slip upsert has `amount`, after V11 the amount is the whole-period 310, and for V13 (AM 80, PM 200) the amount is 280.

## Phase 5: UI

- [ ] T15. Read the unverified review screens
  - Read `OverseerReview.tsx`, `HOReview.tsx`, `SecretaryReview.tsx`, `src/lib/supabase/queries.ts` 100-215 and `CapturePage.tsx`; list every place that sums Expenses or tithing; update design.md section 13 accordingly.
  - Verification: section 13 has no **[UNVERIFIED]** tag left for these files.

- [ ] T16. `ProofModal` props (R5.3-5.5)
  - `referenceLabel`, `dateLabel`, `showSupplier`, `showDocumentAmount`; `ProofResult` gains `supplier` and `documentAmount`. Existing callers unchanged; labels come from `proofFieldLabels` (T6).
  - Verification: typecheck passes; grep shows "Bank Ref" still used by EFT/DD/Burial/deposit call sites and "Invoice No." only through `proofFieldLabels("expense")`.

- [ ] T17. Pure view-model helpers for the capture UI
  - Add `deleteDialogText`, `bankingConfirmationModel`, `capturePanelModel`, `expenseProofState` (design section 18 table) with no React imports.
  - Verification: `captureViewModels.test.ts`: delete text for a cash expense with 0, 1 and 3 proofs and for a pre-paid expense (names the officer and amount); confirmation model for V1, V4 (zero deposit), V11 step 2 (later banking text), `C > T` (blocked with the R3.7 message); panel model returns `balanced`, `awaiting`, `notBalanced` and `cashShortfall` for V7, V6, V3, V5; `expenseProofState` rule is independent of `proof_mandatory`.

- [ ] T18. Capture UI: source control, officer picker, Officers tab action (R1.1-1.6, R2.4)
  - `CashbookForm.tsx` Expenses bar uses `expenseCaptureValidation`; Officers tab "Record pre-paid expense" button and derived read-only rows (from `officerTithingByOfficer`); option gated by `getServerCaps()`.
  - Verification: typecheck and lint baselines hold; the validation and tithing helpers already pass (T4, T9); manual UAT T28 steps 1-4 (rendering only).

- [ ] T19. Proof list, forced proof, warnings (R5.1, R5.2, R5.6, R5.7)
  - Expense rows list proofs, "+ Add proof", "Proof required" marker via `expenseProofState`, auto-open modal after add, `missingProofs` independent of `proofMandatory`, R5.6 warning via `expenseProofSumMismatch`.
  - Verification: typecheck and lint baselines hold; T10 and T17 helper tests pass; manual UAT steps 5-7.

- [ ] T20. Balance panel, Banking tab, confirmation dialog, delete dialog (R3.6, R3.7, R4.1, R4.2, R4.9, R6.2, R7)
  - Right-hand panel from `capturePanelModel`, Mark Banked confirmation from `bankingConfirmationModel`, delete text from `deleteDialogText`, threshold from settings, pre-paid share line.
  - Verification: typecheck and lint baselines hold; T2 and T17 tests pass; a grep shows `R500` no longer used as a constant in `CashbookForm.tsx`; manual UAT steps 8-12.

## Phase 6: Review views (one screen per task; the pure aggregation function and its test come first in each)

- [ ] T21. Audit page (R8.1, R8.2, R8.4, R5.6)
  - Add `auditExpenseRows` and `auditTotals` (pure); then edit `AuditReviewPage.tsx`: select the new field, filter attachments by this period's line ids, badge, officer, all proofs, "Grand Total" = income minus cash expenses, separate pre-paid line.
  - Verification: unit tests on V1, V2, V8 (totals; V2 returns `tithingRecorded` 820 and `fundsKept` 700) and a 3-proof expense (rows and mismatch warning); typecheck; grep shows no remaining subtraction of total expenses in the file; UAT step 13.

- [ ] T22. Chairperson dashboard (R2.5, R8.2, R8.3)
  - Add `chairpersonTotals` (pure, uses `balanceBreakdown`, `officerTithingTotals`); edit `ChairpersonDashboard.tsx` select (line 183), `govTotal` (line 256) and tithing review (lines 261-267).
  - Verification: unit tests on V2 (officer X paid-in 500, prepaid 120, total 620; period `tithingRecorded` 820, `fundsKept` 700) and V8; typecheck; UAT step 14.

- [ ] T23. Elder dashboard (R2.5, R7.3, R8.2, R8.3)
  - Add `elderTotals` (pure; reuses the T22 helper where identical); edit `ElderDashboard.tsx` lines 201 and 356-359; threshold and pre-paid share line.
  - Verification: unit tests on V2 (820 and 700), V8 and a total above a custom threshold; typecheck; UAT steps 14 and 16.

- [ ] T24. Overseer review (R8.2, R8.3)
  - Add `overseerTotals` (pure) using what T15 recorded; edit `OverseerReview.tsx` line 211 select and totals.
  - Verification: unit tests on V1 and V8 (each returns `tithingRecorded` and `fundsKept`); typecheck.

- [ ] T25. HO review (R8.2, R8.3)
  - Add `hoTotals` (pure) using what T15 recorded; edit `HOReview.tsx` line 207 select and totals. HO district segregation untouched (steering invariant 3).
  - Verification: unit tests on V1 and V8 (each returns `tithingRecorded` and `fundsKept`); typecheck; grep confirms no new query bypasses RLS.

- [ ] T26. Secretary review (R2.6, R8.2; steering invariant 7)
  - Add `secretaryTotals` (pure, returns totals only: cash expenses, pre-paid, income, no officer or line detail); edit `SecretaryReview.tsx` line 136 select.
  - Verification: unit test asserts the returned object has no `officer`, `lines` or `proof` keys; typecheck; UAT step 15.

## Phase 7: Server verification (executed only on a disposable stack)

- [ ] T27. SQL tests and disposable-stack run
  - Write `supabase/tests/expense_payment_source.test.sql` with the cases in design.md section 18 (including Appendix A vectors V1-V14 against `cashbook_period_balance`, and the slip amount after a second banking). Confirm the PostgREST error shape for a `limit 0` select of a missing column and adjust `nextServerCaps` codes if needed. Add the D17 cases: a manifest with `balance_rule = 1`, `balanced = true`, on a period with a cash expense and no banked cash is review-ready (legacy path); the same period re-submitted gets `balance_rule = 2` and is not review-ready; the pre-apply impact check (migration header) runs and its result is recorded.
  - Run the migration header's PRE-APPLY IMPACT CHECK (SELECT only) against the target before applying; record the count of rows with `stored_balanced = true` and `new_rule_balanced = false` (0 expected; 0 manifests existed on 2026-11-24).
  - Verification: the user names the disposable target; on it the migration(s) apply cleanly in order (T13 file first when it exists) and every assertion passes, including the existing `two_person_signoff_rls.test.sql` and `tranche4_proof_rls.test.sql`. Record the result in `PROJECT-LOG.md`. Without a named target this task stays open and nothing is executed.

## Phase 8: Acceptance

- [ ] T28. UAT script (manual, on the Vercel preview after T27 and the user's authorisation to apply). Rendering and flow only; the arithmetic is already covered by T2, T11, T17 and T21-T26.
  1. Treasurer: add a cash expense without choosing a source. Expect a blocking inline error.
  2. Add a pre-paid expense without an officer. Expect a blocking inline error.
  3. Add a pre-paid expense R200 for a priest. Expect it in Expenses and as a read-only row on his Officers group; the tithe line unchanged.
  4. From the Officers tab, "Record pre-paid expense" for another officer. Expect one expense line.
  5. Proof dialog opens after add; cancel; expense shows "Proof required" and Submit is disabled with `proof_mandatory=false`.
  6. Add two proofs on one expense with different Invoice No. and supplier; labels read "Invoice No." (and "Bank Ref" on an EFT proof).
  7. Enter document amounts that do not sum to the expense; see the warning; Submit not blocked by it.
  8. Capture Members Cash R300 and a cash expense R40; panel shows awaiting banking (amber).
  9. Mark Banked: dialog shows deposit R260 (tithe 300 less 40); confirm; period balanced. Before that, on a fresh period enter a cash expense larger than the tithe cash and confirm Mark Banked is blocked with the shortfall message (V14).
  10. Try to edit the R40 expense: blocked with the banked message. Edit the pre-paid expense: allowed.
  11. Delete an unsynced pre-paid expense: dialog names the officer, amount and proof count; after delete the panel is correct.
  12. A cash expense above the tithe cash: red message and disabled Submit.
  13. Add Members Cash R50 after banking and Mark Banked again: dialog shows deposit R50 and total R310; period balanced.
  14. Submit; Auditor page shows source badge, officer, all proofs, totals matching the capture panel.
  15. Chairperson and Elder tithing review show paid-in, pre-paid and total for the officer.
  16. Secretary sees totals only.
  17. Total expenses above the threshold require the Elder comment; the pre-paid share is shown.
  - Verification: user signs off each step; failures become bugfix specs, not silent edits.

- [ ] T29. Update steering and the project log
  - After T28 passes: update `tech_old.md`/`steering_old.md` (balance rule, new column, new store, second-banking rule) and `PROJECT-LOG.md` CURRENT STATE and journal.
  - Verification: steering describes only landed and verified behaviour.

## Dependency order

T0 -> T1 -> T2 -> T3, T4, T5, T6, T7 (parallel) -> T8 -> T9 -> T10 -> T11 -> T12 -> T13 (if D8 = separate; may run any time after T0) -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20 -> T21 -> T22 -> T23 -> T24 -> T25 -> T26 -> T27 -> T28 -> T29.
T24, T25 need T15. T27 can start after T2 (it only needs the vectors) and must finish before the client is pushed with caps enabled.
