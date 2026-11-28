# Requirements Document: Expense Payment Source, Officer Pre-paid Expenses, Multi-proof and Balance Rule

Spec 1 of the expense/burial track. Status: DRAFT for user approval, revision 6, 2026-11-27 (revision 3 on 2026-11-24 answered the second review; this revision adds the user's additions of 2026-11-27: exactly two expense sources, no per-line Notes, the Expenses notice, and configurable expense categories with an "Other" description; it matches `design.md` revision 6).
Branch `feat/treasurer-dashboard-v1`. Documentation only: no code, no migration applied, no backend write. Document changes are committed locally and not pushed.
Fact base: `.agents/tasks/uat-treasurer-findings-2026-11-23.md` (sections 5, 7, 8, 9, 10, 11) and the code and
read-only schema checks cited in `design.md`. Anything not verified is marked **[UNVERIFIED]**.

## Introduction

The Treasurer UAT (2026-11-23) found that an expense has no recorded source of money, that the app cannot
represent an officer buying goods for the congregation and submitting the receipt, and that any period
containing a cash expense can never balance, so Submit stays disabled. This spec adds a payment source to
every expense, defines the officer's tithing as paid-in tithe plus the value of the expense he pre-bought, defines a
new balance rule that works with both sources, supports several proofs per expense, relabels the expense proof
reference to "Invoice No.", and carries the new rule through the client, the sync engine, the server
functions, the deposit slip and the review views.

## Glossary

- **Expense category**: the label that says what an expense was for (for example "Maintenance and repairs"). A congregation picks one from the list in force for it. The list always ends with the built-in **Other**.
- **Category list**: 1 to 8 named categories configured by the HO at one District or one Apostleship, or, when none is configured, the built-in default list of six synthetic categories.
- **Other**: the built-in last category. Choosing it requires a short description (`expense_category_other`).
- **Expenses notice**: a dated message of notice type `Expenses`, managed by the HO and shown above the expense capture line. Defined in `burial-notice-and-trend` requirement 11; this spec only consumes it.

- **Cash expense**: an expense with source `CongregationCash` (paid from the congregation's cash collections).
- **Pre-paid expense**: an expense with source `OfficerPrepaid` (an officer bought the goods with his own
  money and submits the receipt). The officer is any selectable officer, typically the chairperson.
- **Tithe cash available** (`titheCashAvailable`): the sum of cash lines entered in the Members and Officers sections, banked or not (`Cash`, `CashPending`, `CashBanked`). Burial cash is not tithe cash. Used before banking (the Mark Banked block and the amber "Awaiting banking" test).
- **Tithe cash banked** (`titheCashBanked`): the `CashBanked` lines in Members and Officers. Used after banking (the `balanced` test and the server function). `markCashBanked` banks every eligible line in one step (`src/db/captureRepo.ts` 515-585), so `titheCashBanked` equals `titheCashAvailable` once banking has happened.
- **Gross cash**: the sum of cash lines (Members, Officers, Burial) before any cash expense is deducted.
- **Net deposit**: gross cash banked minus cash expenses. This is what physically goes to the bank.
- **Paid-in tithe**: the officer's own tithe lines (EFT, DirectDebit or Cash). Their payment type never changes.
- **Officer total tithing**: paid-in tithe plus the sum of that officer's pre-paid expenses.
- **Total tithing recorded** (period level): Members lines + Officers lines + all pre-paid expenses. It is the figure that answers 'how much tithing did the congregation record', and includes the value officers pre-bought.
- **Funds banked or kept** (period level): income (Members + Officers + Burial) minus cash expenses. Pre-paid expenses are not part of it because no congregation money moved.
- **Invoice No.**: the optional reference typed on an Expense proof. Stored in the existing
  `cashbook_attachment.bank_reference` column.
- **Submitter**: the signed-in user who completes capture and submits the period.

## Decision tags

A criterion tagged `[Dn]` depends on open decision Dn in `design.md` section 21. If the user answers differently, `design.md` section 21.1 lists exactly what changes. Untagged criteria do not depend on an open decision.

## Assumptions (change any of these through the Open Decisions list in design.md section 21)

- A1. The app never records how the officer paid for the goods (card, cash, anything). Only the proof supports it.
- A2. A pre-paid expense counts toward the officer's personal tithing (Officers section total), not the Members tab total.
- A3. An officer-faithfulness reading counts a pre-paid expense as tithing recorded for that officer.
- A4. One expense line has exactly one source. A purchase paid partly from cash and partly by an officer is entered as two lines.
- A5. Expense proof is mandatory for both sources even when the congregation's `proof_mandatory` is false (Open Decision D1, recommended).
- A6. Cash expenses can be paid only from tithe cash collected in the same period (Open Decision D2, recommended).
- A7. The governance threshold (R500 default) applies to the total of all expenses of both sources (Open Decision D4, recommended).
- A8. Officer-fund supplements (the District Head Office reimbursing an officer) are out of scope.
- A9. Exactly two expense sources exist (user, 2026-11-27). There is no third source and no per-line free-text Notes column; the Expenses notice (Spec 2) replaces the notes idea.
- A10. The category list is configuration managed by the HO at District or Apostleship level, not a code constant; the built-in default and "Other" are the only code constants.
- A11. A Burial payment is made by an officer or a member and is recorded the same way; no officer is attached to a Burial line (the pre-paid officer link exists only on Expenses lines).

## Requirements

### Requirement 1: Every expense has exactly one payment source

**User Story:** As a Treasurer, I record where the money for each expense came from, so the cash to bank and the officer's tithing are correct.

#### Acceptance Criteria

1.1 The Expenses capture bar shall require the user to choose exactly one source before an expense can be added: "Paid from congregation cash" or "Pre-paid by officer". There shall be no pre-selected value.
1.2 [D7] When the source is "Pre-paid by officer", the capture bar shall also require choosing one officer from the same list the Officers tab uses (active officers of the congregation; Elders are not in that list today). Interim officers pending HO approval are selectable because the interim request insert sets `is_active: true` (`src/components/CashbookForm.tsx` line 158) and the server guard tests `officers.is_active`. See design.md 4.1 for the residual risk if HO later rejects an interim officer.
1.3 When the source is "Paid from congregation cash", no officer shall be stored on the expense.
1.4 The stored expense shall carry the source as `expense_payment_source` with exactly the values `CongregationCash` or `OfficerPrepaid`. The prepaid officer shall be stored in the existing `officer_id` field.
1.5 The Officers tab shall offer a "Record pre-paid expense" action per officer that opens the Expenses tab with source "Pre-paid by officer" and that officer preselected. Both entry points shall create the same single expense line (no second record).
1.6 An expense whose source or officer is missing or invalid shall not be saved, and the user shall see an inline error naming the missing field.
1.7 Existing local and server expense lines with no source shall be treated as `CongregationCash`.
1.8 The server shall reject a pre-paid expense that has no officer, a cash expense that has an officer, and a pre-paid officer who is not an active officer of the period's congregation.

1.9 Exactly two sources exist: "Paid from congregation cash" and "Pre-paid by officer". The CHECK constraint, the client validation, the sync row and the Appendix vectors allow exactly these two values. No third source, option, field or label is offered, stored or accepted, and the app never records how an officer paid for the goods (A1, 2.7).
1.10 Burial lines carry no payment source and no officer. The Burial capture bar offers no officer picker, and a Burial payment made by an officer is recorded exactly as one made by a member (the app does not distinguish the payer). The pre-paid officer link (`officer_id` with source `OfficerPrepaid`) exists only on Expenses lines; the guard trigger already forces the source to NULL on every non-Expenses row (migration section 2). Whether the current Burial bar offers an officer picker is [UNVERIFIED]; task T9 reads it and the requirement holds either way.

### Requirement 2: Officer total tithing includes the pre-paid value, without a second record

**User Story:** As a Chairperson or Elder, I see an officer's total tithing as what he paid in plus the receipt value he pre-bought, whatever way he paid for the goods.

#### Acceptance Criteria

2.1 [D5, D6] An officer's total tithing for a period shall equal the sum of his tithe lines plus the sum of his pre-paid expense lines. Example: paid-in R500 EFT plus a pre-paid R120 expense gives R620.
2.2 A tithe line shall keep its own payment type (EFT, DirectDebit or Cash) unchanged by any pre-paid expense. No line shall be created, edited or retyped to represent the pre-paid value.
2.3 A pre-paid expense shall not reduce the cash to bank, shall not change the banked amount and shall not change whether the period balances.
2.4 [D5, D6] The Officers tab shall show, in the officer's group, a read-only "Pre-paid expense" row for each linked expense, with a link to the expense in the Expenses tab, and the group total shall show paid-in tithe, pre-paid value and the total.
2.5 The Chairperson and Elder tithing review shall show the same three figures for each officer, computed by one shared function.
2.6 The Secretary (totals-only permission `T`) shall see only totals; no officer-level pre-paid detail and no proof images.
2.7 The app shall not ask for or store how the officer paid for the goods.
2.8 [D6] At period level, "Total tithing recorded" shall equal Members lines + Officers lines + pre-paid expenses, and "Funds banked or kept" shall equal income minus cash expenses. Both shall be shown wherever a period total is shown (capture panel, Audit page, Chairperson, Elder, Overseer, HO), computed by `balanceBreakdown` (`tithingRecorded`, `fundsKept`). Example (vector V2): income R700 and pre-paid R120 give tithing recorded R820 and funds kept R700. Only `fundsKept` relates to the balance and the deposit; `tithingRecorded` never does.

### Requirement 3: The balance rule works with both sources

**User Story:** As a Treasurer, I can submit a period that contains expenses once everything is accounted for.

#### Acceptance Criteria

3.1 A period shall be balanced if and only if both hold:
 (a) income (Members + Officers + Burial lines) equals electronic banking (EFT + DirectDebit) plus gross banked cash (`CashBanked`);
 (b) [D2, D3] cash expenses do not exceed `titheCashBanked` of the same period (per period, burial cash excluded).
 A pre-paid expense always has a valid officer because the CHECK constraint and the guard trigger reject any other row (design 4.1); the balance function therefore has no officer term.
3.2 The net deposit shall equal gross banked cash minus cash expenses and shall never be negative in a balanced period.
3.3 For a period with no expenses, the new rule shall give the same result as the current rule `income === banked + expenses` for every input (backward compatible).
3.4 Adding, editing or deleting a pre-paid expense shall never change the balance verdict, the net deposit or the banked total.
3.5 Adding a cash expense of amount A to a balanced period shall reduce the net deposit by exactly A, provided A does not exceed remaining tithe cash.
3.6 When cash is entered but not yet banked, the period shall show "Awaiting banking" (amber), not "Not balanced" (red), including when the pending cash includes burial cash and when cash expenses exist.
3.7 [D2] Mark Banked shall be blocked, the panel shall show the shortfall in red, and Submit shall stay disabled, whenever cash expenses exceed `titheCashAvailable` (entered tithe cash, banked or not). The message shall read "Cash expenses R x exceed cash collected R y. Record the remainder as pre-paid by an officer or correct the amount." The pre-banking block uses `titheCashAvailable` and the post-banking `balanced` test uses `titheCashBanked`; the two cannot disagree after banking because all eligible lines are banked together (vector V14 covers the blocked case).
3.8 One shared function (`balanceBreakdown` in `src/lib/captureTotals.ts`, which also returns `titheCashAvailable`, `titheCashBanked`, `tithingRecorded` and `fundsKept`) shall be the single source of the figures used by the capture panel, the Banking tab, the submission manifest `balanced` flag, the Audit page, the Chairperson dashboard, the Elder dashboard and the Overseer review.
3.9 The server shall compute the balance from the synced line items (`cashbook_period_balance`) and shall store that result, not the client's flag, in `cashbook_submission_manifest.balanced`.
3.10 For a manifest frozen under the new rule (`balance_rule = 2`), `cashbook_review_ready` shall re-evaluate the balance live and shall return false when it is not balanced.
3.11 [D17] A manifest frozen before the migration (`balance_rule = 1`) shall keep the legacy review-ready semantics (stored `manifest.balanced`, no live re-check, no always-on expense proof, no slip-amount comparison; the one exception is the Burial proof exemption of the burial-notice-and-trend spec, which relaxes the legacy branch too, so that spec's change touches both the rule-1 and rule-2 Burial blocks of `cashbook_review_ready`), so no already-submitted period changes state because of this migration. A period that is rejected and re-submitted gets a `balance_rule = 2` manifest and is judged by the new rule. Read-only check on the dev/demo backend (2026-11-24): the manifest table has 0 rows, so today no period is affected; the pre-apply check in the migration header must be re-run before applying.

### Requirement 4: Banking, deposit and confirmation

**User Story:** As a Treasurer, I am told how much to deposit and I confirm it before the cash is marked banked.

#### Acceptance Criteria

4.1 Before marking cash banked, the app shall show a confirmation dialog with: tithe cash available, burial cash, less expenses paid from congregation cash, the pre-paid expense total (shown as "not deducted"), and the deposit amount.
4.2 When all expenses are pre-paid, or there are no expenses, the deposit amount shall equal the cash collected, and the dialog shall say so.
4.3 Marking cash banked shall store `depositNetAmount` on the period. `depositNetAmount` always means that period's own whole-period net deposit (gross banked cash minus its own cash expenses). When a combined AM+PM slip is banked, the AM period's `depositNetAmount` is written in the same local transaction as the PM period's. When the slip syncs, `cashbook_deposit_slip.amount` shall be the sum of `depositNetAmount` over every period the slip covers (vector V13).
4.4 Inside the same local transaction that marks cash banked, the app shall recompute the deposit amount. If it differs from the confirmed amount, nothing shall be banked and the user shall be told the expenses changed.
4.5 [D15] When the net deposit is R0, the app shall allow marking cash banked without a deposit slip photo, and the server shall not require a slip for that period.
4.6 For a combined AM+PM slip, the confirmation dialog shall show the sum of both periods' deposits as the amount to deposit, each period's `depositNetAmount` stays its own net, and each period shall be checked against its own `titheCashAvailable` (criterion 3.7).
4.7 [D13] Once any cash on the period is banked, adding, editing the amount or source of, or deleting a cash expense shall be blocked with the message "Cash is already banked on this period. A cash expense cannot change until the banking is reversed." Pre-paid expenses stay editable.
4.8 The server shall treat a recorded `cashbook_deposit_slip.amount` that differs from the covered periods' net deposits as not review-ready.
4.9 [D16] A later banking on the same period (cash added after a first banking) shall deposit only the cash not yet banked, without subtracting cash expenses a second time, and shall overwrite the stored `depositNetAmount` of that period with its whole-period net deposit (gross banked cash minus cash expenses). The confirmation dialog shall state both the amount deposited now and the total deposited on the period. Repeating or splitting bankings shall never change the final `depositNetAmount` for the same set of lines.

### Requirement 5: Proof is forced, with several proofs per expense

**User Story:** As a Treasurer, I attach one proof per supplier or purchase time to an expense.

#### Acceptance Criteria

5.1 [D1] An expense (both sources) shall not be submittable until it has at least one proof, even when the congregation's `proof_mandatory` setting is false.
5.2 After an expense is added, the proof upload dialog shall open automatically. Cancelling it shall leave the expense visibly marked "Proof required".
5.3 An expense shall accept any number of proofs. Each proof is one photo with its own date, optional Invoice No., optional supplier and optional document amount.
5.4 On the Expense proof dialog, the optional reference field shall be labelled "Invoice No.". On EFT, DirectDebit, Burial and the cash deposit slip it shall stay labelled "Bank Ref".
5.5 The Invoice No. shall be stored in `cashbook_attachment.bank_reference` (no column rename). Supplier and document amount shall be stored in new optional columns, with an `entry_source` of `manual` (reserved value `ocr` for the future).
5.6 When every proof has a document amount and their sum differs from the expense amount, the capture row and the Audit page shall show a non-blocking warning.
5.7 The expense row shall list its proofs and allow adding another. A proof that has not yet synced can be removed after confirmation. A synced proof cannot be removed from the UI.
5.8 Offline: proofs shall be held locally and uploaded on sync; capture shall never wait for Storage.
5.9 [D1] `cashbook_review_ready` shall require at least one attachment on every Expenses line regardless of `proof_mandatory`.

### Requirement 6: Delete behaviour and warnings

**User Story:** As a Treasurer, I am told exactly what a delete removes.

#### Acceptance Criteria

6.1 Deleting an unsynced expense shall remove the expense, its officer link (nothing else holds the link) and all its local proofs in one local transaction.
6.2 The delete dialog for an expense with proofs shall state how many proofs will be permanently removed from this device. For a pre-paid expense it shall also state the officer and that R x stops counting toward his tithing.
6.3 A synced expense (it has a server id) shall remain non-deletable from the UI, with the existing message.
6.4 A cash expense shall not be deletable once cash is banked (criterion 4.7).
6.5 After deleting, the balance panel shall recompute and show the correct state (balanced, awaiting banking, or not balanced) with no stale value.

### Requirement 7: R500 governance

**User Story:** As an Elder, I approve large spending.

#### Acceptance Criteria

7.1 The approval threshold shall come from the congregation's `expense_approval_threshold` setting, falling back to R500 when it is empty.
7.2 [D4] The total of all expenses of both sources in the period shall be compared with the threshold. The existing per-period basis is unchanged (the "monthly" naming defect stays recorded, not fixed here).
7.3 When the total exceeds the threshold, the existing Elder approval comment shall be required before Submit, and the panel text shall say which sources make up the total.
7.4 [D4] The pre-paid share of the total shall be shown so the Elder can see how much is officer-funded.

### Requirement 8: Review views

**User Story:** As an Auditor, Chairperson, Elder or Overseer, I can see the source of each expense and the correct totals.

#### Acceptance Criteria

8.1 The Audit page expense panel shall show, per expense, the source badge, the officer for pre-paid expenses, and every proof with Invoice No., supplier, date and amount.
8.2 The Audit page, the Chairperson dashboard, the Elder dashboard, the Overseer review and the HO review shall all read their totals from `balanceBreakdown`. "Grand total" shall be `fundsKept` (income minus cash expenses). Each screen shall also show "Total tithing recorded" (criterion 2.8) and the pre-paid expenses on a separate line.
8.3 Those screens shall load the `expense_payment_source` field with the line items.
8.4 Every pre-paid expense shall carry a visible "Pre-paid by officer" badge on the Audit page, to help independent review (see the self-dealing risk in design.md section 14).

### Requirement 9: Offline and data compatibility

#### Acceptance Criteria

9.1 The Dexie schema shall move to the next free version (5 at the time of writing) as an additive change. Existing data shall remain readable and no upgrade function shall delete data.
9.2 A device whose server has not yet received the migration shall still sync cash expenses. The pre-paid option shall be hidden until the server reports the capability.
9.3 Old clients that do not send the new field shall still be able to write expenses; the server shall default them to `CongregationCash`.
9.4 The sync engine shall retain and retry a line or proof that fails, as it does today, and shall never mark a period synced while a proof is still local.
9.5 The capability flag shall default to "not available" when it has never been stored. Only a schema error (undefined column) shall set it to "not available" after it was available; any other probe failure (network, authentication, server error) shall leave the previous value unchanged. A successful probe shall set it to "available".
9.6 The capability flags are `expensePaymentSource`, `attachmentMeta` and `expenseCategory` (probe: `select expense_category from cashbook_line_item limit 0`). Each is probed and stored independently under the rules of 9.5. When `expenseCategory` is false the category and Other fields are omitted from the sync row and the category list is still captured and shown, so a cash expense on an un-migrated backend syncs exactly as today.


### Requirement 10: Expense categories (HO-managed configuration and a category on every expense)

**User Story:** As a DHO, I set the short list of expense categories for my district or apostleship so spending is described the same way everywhere. As a Treasurer, I pick a category for each expense and, when none fits, choose Other and say in a few words what it was.

#### Acceptance Criteria

10.1 [D20] Every new expense shall require exactly one category, chosen from the list in force for its congregation (10.4), with no pre-selected value. The list always ends with the built-in "Other". An expense with no category shall not be saved and the user shall see an inline error naming the field. An existing line with no category (captured before this feature) is shown as "Uncategorised"; it is not blocked, and it is not retro-fitted.
10.2 A configured category list shall hold 1 to 8 named categories (about 6 are expected). Each label shall be trimmed (the trim set is space, tab, carriage return and line feed), 1 to 40 characters, free of control characters, unique ignoring case within the list, and shall not equal "Other" ignoring case. The built-in "Other" is never stored in the configuration and cannot be renamed, moved or removed.
10.3 A list belongs to exactly one scope node: a District or an Apostleship. An Overseership or Congregation scope, a node that does not exist, a node whose level differs from the chosen level, and a node whose parent chain breaks the fixed shape (Apostleship under District) shall be rejected with 400 and write nothing. A node outside the caller's assigned districts shall be rejected with 403 and write nothing.
10.4 [D18] Scope resolution is consistent with the notice scope rule: it uses the congregation's own `apostleship_id` and `district_id` (already cached by `cacheLoader`) and works offline. Until Open Decision D18 is answered, the build default is REPLACE: the Apostleship list applies when one exists; otherwise the District list applies; otherwise the built-in default list applies. The alternative (MERGE the broader list with the more specific one) is listed in `design.md` section 21 with a change set. The notice precedence rule (`burial-notice-and-trend` O1) stays open and is to be answered together with D18.
10.5 When no list is configured for the congregation's Apostleship or District, the built-in default list of six synthetic categories shall show (constant `EXPENSE_CATEGORY_DEFAULTS`, design 27.3), followed by "Other". It works offline and with an empty cache.
10.6 Writes shall be possible only for an HO acting inside the districts assigned to that HO (`ho_district_assignments`), only through the `admin-write` Edge Function, in the order of the Privileged Route Checklist: service-role key present (500), Bearer token (401), `auth.getUser` (401), active in-window `user_hierarchy_access` role `HO` (403), validate body (400), write with the service-role client. The write shall run in one `service_role`-only SQL function (`expense_category_publish`, `expense_category_clear`) that re-checks the caller from the user id, so a gap in the Edge gate cannot widen access. The browser shall hold no INSERT, UPDATE or DELETE privilege or policy on the configuration table.
10.7 Every authenticated user, whatever the role, shall be able to SELECT the active category rows of their own district (the same read function as notices, no role term). The rows shall be cached offline in a new Dexie store `expenseCategories` (part of the same additive Dexie version as `lineProofs`), refreshed in the same `Promise.allSettled` pass as the other reference caches and again when the Expenses tab mounts while online. A failed refresh keeps the cached rows. If the table does not exist on the backend yet, the app logs one warning and the built-in default list shows.
10.8 Each expense line shall store its category as `expense_category` (the chosen label, a snapshot) and, only when the category is "Other", `expense_category_other`. A later edit or retirement of a list shall never change a stored line. The server shall validate the format (trimmed, length, no control characters, Other-needs-description, description-only-with-Other, Expenses rows only) and shall NOT require the label to be in the current list, because an offline device may capture against a list that has since been replaced.
10.9 [D19] When "Other" is chosen, a description shall be required: plain text, trimmed, 1 to 60 characters, no control characters, and (D19) no run of 9 or more consecutive digits, which looks like an account or identity number, with the message "Describe the purchase in words. Do not enter account or ID numbers." The input shall carry the hint "Never enter passwords, PINs or account numbers." When any other category is chosen the description shall be empty and shall not be stored. The description shall never be written to a log (N3).
10.10 The category and the Other description shall remain editable until the period is submitted, with no effect on any money figure. They are not covered by the cash-banked freeze (4.7). Changing the category never changes the source, the officer, the amount, the balance or the proofs.
10.11 Sync: both fields shall be in the sync engine's mutable line fields and shall be sent only when the server capability `expenseCategory` is true (9.5, 9.6); otherwise they are omitted and the line still syncs. A line captured offline against a list that has since changed keeps its label and syncs.
10.12 The capture row and the Audit page expense panel shall show each expense's category and, for Other, its description. The Secretary (totals-only `T`) shall see no category detail (steering invariant 7). Category subtotals on any screen are out of scope (D21).
10.13 Category administration shall reuse the machinery of `burial-notice-and-trend` and shall not duplicate it: the shared SQL helpers (`scope_resolve_district`, `scope_assert_ho`, `scope_district_readable`), the `adminApi.invoke` wrapper, the shared HO `ScopePicker` and the offline block pattern. One HO screen (`/ho/expense-categories`, permission row `expense_categories.manage`, `HO: "M"` and `-` for every other role, gated through `permissions.ts`) shows the list in force at the chosen scope (or "No list set: standard categories apply" with the six standard names offered as a starting point), lets the HO edit 1 to 8 labels in order, save, and clear the list. It is unavailable offline (explicit message, no data).

### Requirement 11: No per-line Notes; the Expenses notice

**User Story:** As a DHO, I publish guidance about expenses once, above the expense capture line, instead of every Treasurer typing notes on every line.

#### Acceptance Criteria

11.1 There shall be no per-line free-text Notes column, field or input on expenses in the client, in Dexie or on the server. The existing required expense Description is unchanged and is not a notes field.
11.2 The Expenses tab shall show the Expenses notice above the expense capture line. Its behaviour (scope District, Apostleship or Overseership; start and expiry dates; overwrite prompt; built-in synthetic default text; offline cache; `admin-write` path; every role reads, Secretary included) is defined entirely by `burial-notice-and-trend` requirement 11 and its generalised notice mechanism (one table, one notice type key, one edit screen). This spec adds no notice table, screen, action, component or default text of its own.
11.3 The only Spec 1 work for the notice is the placement dependency: the expense capture UI task (T18) is built after the notice component exists and keeps its slot above the capture bar free.

## Non-Functional Requirements

N1. All balance arithmetic shall be at cent precision (round half up on cents).
N2. The client rule and the server rule shall agree on a shared set of golden test vectors (design.md Appendix A).
N3. No secret, real account number or personal document shall be written to code, specs or logs. The Other description and the category labels are never logged.
N4. New code shall follow the existing `permissions.ts` gate. No role string comparisons in components.
N5. Migration shall be authored but not applied. It shall first run on a disposable stack together with the RLS and integrity tests.
N6. The change shall not widen any RLS policy and shall not add a client-callable SECURITY DEFINER function that returns data across congregations.

## Out of Scope

- Officer Fund supplements and reimbursement of an officer by the District Head Office (later Officers Fund spec).
- OCR itself. Only the fields are made ready.
- Burial announcement, burial proof rules and the burial chart (separate spec).
- The Officer Faithfulness detail page and graph.
- A "reverse banking" feature (flagged as a gap in design.md; Open Decision D13).
- Fixing the per-period versus per-month naming of the R500 check.
- Multi-proof for EFT, DirectDebit, Burial and the deposit slip.
- Recording how an officer paid for the goods.
- A third expense source and a per-line Notes field (requirements 1.9, 11.1).
- Category subtotals, charts or category reports on any screen (D21), and a category check against the current list on the server (10.8).
- Congregation-level or Overseership-level category lists.
- Server enforcement of the Elder comment (Open Decision D4b).
