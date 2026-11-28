# Requirements Document: Burial Notice, Burial Proof Exemption, Burial Trend and Officer Faithfulness Chart

Spec 2 of the expense/burial track. Status: DRAFT for user approval, revision 3, 2026-11-27: revised after design review rounds 1 and 2 (design section 19) and after the user's additions of 2026-11-27 (generalised notice mechanism with a notice type key, Expenses notice, Elder sees the trend, all roles read notices; design section 19.5).
Branch `feat/treasurer-dashboard-v1`. Documentation only: no code, no migration applied, no backend write. Document changes are committed locally and not pushed.
Fact base: `.agents/tasks/uat-treasurer-findings-2026-11-23.md` (sections 5, 7, 8, 9, 10, 11) plus the code and
migration reads cited in `design.md`. Anything not verified is marked **[UNVERIFIED]**.

## Introduction

Treasurer UAT (2026-11-23) asked for four things, all delivered by this spec:

1. A message on the Burial tab that the District Head Office (DHO) can edit, with start and expiry dates, and a
   built-in default when no message is active.
2. Burial lines must not need a proof attachment, even when the congregation's `proof_mandatory` is true.
3. A small chart on the Burial tab landing: Burial amounts received per month for the last 12 months against the same
   months of the prior year.
4. An upgrade to the Officer Faithfulness detail page: a tithed-versus-not-tithed chart per period, and a per-officer
   count of missed periods.

5. (Added 2026-11-27.) The notice in item 1 is built as ONE generalised mechanism with a **notice type** key. Two types
   exist: **Burial** (item 1) and **Expenses** (a message above the expense capture line, requested for the Expenses
   tab of Spec 1 `expense-payment-source`). One table, one publish and one retire function, one Edge action pair, one HO
   edit screen, one Dexie store and one display component serve both types. This spec owns the mechanism; Spec 1 only
   consumes it (requirement 11).

The Burial function may be retired once members all pay electronically, so items 1 and 3 are deliberately small.
Item 3 and item 4 share one chart component.

## Resolved decisions (user, 2026-11-27)

- RD1. **All roles read notices, Secretary included.** There is no role term in the read rule. See 6.4 and 3.9.
- RD2. **The Elder also sees the Burial trend**, totals only, no line detail. See 8.3 and 8.8.
- RD3. The Expenses notice follows exactly the same process as the Burial notice (requirement 11).
- RD4. There is no per-line free-text Notes column on expenses; the Expenses notice replaces that idea (Spec 1 requirement 11).

Still open (design section 17): O1, the rule when notices at several scope levels are active together, applies to each
notice type independently and stays open; its build default is unchanged.

## Glossary

- **DHO**: a user with role `HO` whose access is scoped to one or more districts (`user_hierarchy_access` role `HO`,
  scope `District`, plus a matching `ho_district_assignments` row). There is no separate DHO role in `ROLES`
  (`src/lib/types.ts`).
- **Notice**: a text message with a notice type, a scope, a start date and an optional expiry date. Stored in one table
  (`scope_notice`).
- **Notice type**: the key that says where a notice is shown. Exactly two values: `Burial` (shown on the Burial tab, above
  the capture bar) and `Expenses` (shown on the Expenses tab, above the expense capture line). Notices of different types
  never conflict, never replace each other and are resolved separately.
- **Burial notice**: a notice of type `Burial`. **Expenses notice**: a notice of type `Expenses`. Everything this
  document says about "a notice" applies to both types unless it names one.
- **Scope**: the part of the hierarchy a notice applies to. One of `District` (every congregation in the district),
  `Apostleship` (every congregation under that apostleship) or `Overseership` (every congregation under that
  overseership).
- **User's four scope choices, mapped.** The user asked for "district level, all apostleship congregations, single
  apostleship, or an overseership". "District level" and "all apostleship congregations" are the same thing in the
  hierarchy (a District holds Apostleships), so both are the **District** scope. "Single apostleship" is the
  **Apostleship** scope and "an overseership" is the **Overseership** scope. Publishing the same message to several (but
  not all) apostleships needs one notice per apostleship; there is no multi-select scope.
- **Active notice**: `is_active` is true and today's date lies in `[starts_on, expires_on]` (open-ended when
  `expires_on` is null).
- **Conflict**: an existing non-retired notice of the same notice type, with the same scope level and scope id, whose date
  range overlaps the new notice's date range.
- **Default notice**: the built-in text of a notice type, shown when no active notice of that type applies to the
  congregation (one default per type, requirements 4 and 11.5).
- **Trend window**: by default the 12 OAC months ending with the current OAC month (the user asked for "the last calendar year"; trailing 12 months versus January to December of the last full year is part of Open Decision O4). The prior-year window is the same 12
  (year-1, month) pairs. "OAC month" is `cashbook_period.year` and `cashbook_period.month`, the same month key the
  rest of the app uses (`src/lib/oacWeeks.ts`).
- **Burial amount**: the sum of `amount` over line items whose **`section = 'Burial'`**. The key is the section, never
  `item_type`, because `markCashBanked` rewrites a banked Burial line's `item_type` to `CashBanked`
  (`src/db/captureRepo.ts` lines 548 and 572).
- **Tithed (faithfulness)**: an active officer appears in at least one line item (`officer_id` set) in a period. This is
  the rule the dashboard card already uses (`src/db/dashboardRepo.ts` `listOfficersWithoutRecentTithe`).

## Assumptions (change any of these through the Open Decisions list in design.md section 17)

- A1. DHO means role `HO` limited to its assigned districts. No other role may write a notice.
- A2. A notice is plain text. No HTML, markdown, links or images.
- A3. All specific values in the default notice and in all test data are synthetic: account number `9999 0000 111`
  (fabricated, "Demo Bank"), contact `Sister JV Van Der Venter`, phone `011 293 4567`. No real banking detail is stored
  in the repository.
- A4. The trend counts Burial amounts by OAC period month, not by the line's `transaction_date`.
- A5. The trend counts periods that have left the editable states (status not `Draft` and not `Rejected`) from the
  server, plus this device's own periods from Dexie that the server result does not list (requirement 8.4).
- A6. Faithfulness charts use the officers who are active today, applied to each historical period.
- A7. Spec 1 (`expense-payment-source`) and this spec share files and the Dexie version, and Spec 1 consumes this spec's
  notice mechanism (Expenses notice) and its scope helpers (expense categories). The interleaved implementation order is
  fixed in `tasks.md` of both specs.

## Requirements

### Requirement 1: HO publishes a notice (Burial or Expenses)

**User Story:** As a DHO, I publish a message for my congregations, with the dates it should show, so members see AGM
dates, annual increases and payment instructions where they pay Burial, and guidance on how to record expenses.

#### Acceptance Criteria

1.1 A user with role `HO` shall be able to create a notice with: notice type (`Burial` or `Expenses`), scope level
(District, Apostleship or Overseership), the scope node, message text, a start date, and an expiry date. The notice type
is required, is one of exactly those two values, and cannot be changed on an edit (a changed type is rejected with 400).
1.2 The message text shall be required, trimmed, and between 1 and 1000 characters after trimming. The trim set is space, tab,
carriage return and line feed (Postgres `btrim(text)` trims spaces only, so the explicit set is required). Empty, whitespace-only
(including newline-only and tab-only), longer than 1000 characters, and containing a control character other than tab, CR and LF
shall be rejected with a 400 response and no row written. The trimmed string is what is forwarded and stored. The rule is
enforced in the Edge validator, in `scope_notice_publish` and in the table CHECK constraints.
1.3 On creation, the expiry date (when given) shall be on or after the start date, and on or after **yesterday's UTC date**
(the server rule, `p_expires_on >= current_date - 1`). The server is deliberately lenient by one day so the device's local
date (used for display, 3.6) and the server's UTC date can never reject a notice that expires "today" on the device. The
client form is stricter: it requires the device's date, today or later. Boundary cases (test T4): an expiry of UTC yesterday is
accepted; an expiry of the UTC day before yesterday is rejected with 22023 and nothing is written. A rejected date pair
shall write nothing.
1.4a A scope node that does not exist, whose `level_type` differs from the chosen scope level, or whose `parent_id` chain
does not reach a District by the fixed shape (Apostleship under District, Overseership under Apostleship) shall be
rejected with 400 and shall write nothing.
1.4b A scope node that is valid but whose district is not one of the caller's assigned districts shall be rejected with
403 and shall write nothing.
1.5 Roles other than `HO`, an `HO` whose `user_hierarchy_access` row is inactive or outside `[start_date, end_date]`,
an `HO` with no `ho_district_assignments` row for the notice's district, and unauthenticated callers shall be refused
(401 or 403) and shall write nothing.
1.6 The HO shall be able to edit the message text and the dates of an existing active notice in their district, and to retire
(deactivate) it. The scope of an existing notice shall not be editable (a changed scope is rejected with 400).
1.6a Edit date rules: the only date rule on edit is `expires_on >= starts_on` (or `expires_on` null). `starts_on` may
move earlier or later. Setting `expires_on` before today is allowed; it ends the notice (the client then treats it as
expired, requirement 3.6) and it is not a creation error.
1.6b The conflict check of requirement 2.1 shall run on an edit whenever `starts_on` or `expires_on` changes, excluding the
edited notice itself. Replace on an edit retires the other conflicting notices and keeps the edited row.
1.7 Retiring or replacing a notice shall keep the row (`is_active` false, `retired_at`, `retired_by`). No notice row
is physically deleted by the application.
1.8 A notice shall record `created_by`, `updated_by`, `created_at` and `updated_at`.
1.9 One HO screen serves both notice types (a notice type selector at the top of the form and a type badge on each
row). It shall show the HO's current and future notices with notice type, scope name, dates and text, and shall be
unavailable (explicit offline message, no data) while the device is offline. Notices whose `expires_on` is before today
(still `is_active`, because nothing retires them automatically) shall be hidden by a client date filter, with a
"Show expired" toggle that lists them badged "Expired".

### Requirement 2: Overwrite prompt at the same scope

**User Story:** As a DHO, when I publish a message for a scope that already has one, I am asked whether the new one
replaces the old one.

#### Acceptance Criteria

2.1 When the new notice, or an edit that changes its dates, conflicts with one or more existing notices at the same scope, the server shall
write nothing and shall return a normal (HTTP 200) response `{ conflict: true, conflicts: [...] }` listing each
conflicting notice's id, message text, start date and expiry date.
2.2 The HO screen shall show those conflicts and ask "Replace the current message for <scope name>?", with the choices
Replace, Keep both and Cancel.
2.3 On Replace, the server shall, in one transaction, retire every conflicting notice and insert the new one. If either
step fails, neither shall persist.
2.4 On Keep both, the server shall insert the new notice and leave the older ones active.
2.5 On Cancel, nothing shall be written.
2.6 Notices of different notice types, at different scope levels or at different scope nodes shall never be reported as
conflicts of each other. A Burial notice and an Expenses notice for the same scope and dates coexist.
2.7 A notice whose date range does not overlap an existing notice's range (for example a scheduled future message)
shall not be reported as a conflict.

### Requirement 3: Display on the Burial tab

**User Story:** As a Treasurer, I see the current message just below the tab buttons and above the capture lines.

#### Acceptance Criteria

3.1 When the Burial tab is active, the Burial notice area shall render below the tab button row and above the capture bar
in `CashbookForm`, whether or not the user may edit (`canEdit`). It shall not render on other tabs. (The Expenses tab
has its own notice area of type `Expenses`, requirement 11.)
3.2 The area shall show the active notices of its notice type that apply to the period's congregation: District notices for its
`district_id`, Apostleship notices for its `apostleship_id`, Overseership notices for its `overseership_id`.
3.3 When more than one notice applies, the order and number shown shall follow the resolution rule chosen in Open
Decision O1. Until O1 is answered, the build default is: all applicable notices, most specific scope first, at most 3.
3.4 When no notice is active, the Default notice shall show (Requirement 4).
3.5 Notice text shall be rendered as text (React text node, line breaks kept). No HTML in notice text shall be
interpreted.
3.6 A notice shall be shown on the dates `starts_on` to `expires_on` inclusive, judged by the device's local date. An
expired notice shall never show, including when it is still present in the offline cache.
3.7 The notice area shall show its scope label ("District", "Apostleship" or "Overseership") and, when set, "until
<expires_on>".
3.8 Elder on the capture Burial tab. An Elder enters capture (`capture.create` is `O`, `canEnterCapture` is true) and
therefore sees the notice area. The notice area for an Elder shows the notices that the Elder's offline cache holds. The read
rule (6.4) admits an Elder through the Elder's Eldership access row (verified read-only 2026-11-27: the row has
`scope_level = 'Eldership'` and `hierarchy_id` equal to the congregation's `eldership_id`); when none is cached (or the
table or policy yields nothing) it shows the Default notice. Behaviour shall be the same code path as for the Treasurer, with
no Elder-specific branch and no error shown. That the policy returns the district's notices to an Elder is [UNVERIFIED] until
integration case 7 runs on a stack. The Elder also sees the Burial trend (8.3, 8.8; resolved decision RD2).
3.9 Secretary. The Secretary cannot enter capture (`canEnterCapture`), so the capture tabs never show it a notice. Resolved
decision RD1 (2026-11-27) says the Secretary reads notices too. The read rule (6.4) therefore has no role term, and the
Secretary's reports screen (`SecretaryReview.tsx`) shall show a read-only "Notices" panel for the congregation being
viewed, listing the active Burial and Expenses notices that apply to it (same resolver, same Default notices, text only). The
panel is a totals-compatible surface: it carries no line detail, no proof and no amounts (steering invariant 7). The exact
placement inside `SecretaryReview.tsx` is [UNVERIFIED] (the file has not been read for this spec); task T7b reads it first.
Other read-only roles (Auditor, Overseer, Apostle, HO) may read notices under the same rule but no new screen is added for
them (Open Decision O17).

### Requirement 4: Default Burial notice

**User Story:** As a member, when my DHO has posted nothing, I still see the basic burial payment rules. (The Expenses type has
its own default, requirement 11.5.)

#### Acceptance Criteria

4.1 The Default notice shall say, in paraphrase: burial can be paid electronically to the stated account; use your
membership number as the payment reference; wait for your receipt from the DHO; for enquiries contact the district
contact.
4.2 The account, bank and contact values shall come from one constant (`BURIAL_DEFAULT_DETAILS`) holding the synthetic
values in A3. No other file shall contain them.
4.3 The Default notice shall be marked visually as a standard notice (label "Standard notice") so it is
distinguishable from a DHO message.
4.4 The Default notice shall work offline and with an empty notice cache.

### Requirement 5: Offline availability

**User Story:** As a Treasurer on a congregation device, I see the notice without a connection.

#### Acceptance Criteria

5.1 The notices of both types readable by the signed-in user shall be cached in one new Dexie store `scopeNotices`
(index `id, notice_type, district_id, scope_id`) through an additive Dexie version (no existing store altered, no upgrade
function). Each cached row carries its `notice_type`.
5.2 `refreshReferenceCache` shall fetch notices in the same `Promise.allSettled` pass. A failed notice query shall
leave the existing cached notices untouched and shall not stop the other stores refreshing.
5.3 The Burial tab and the Expenses tab shall each trigger a notice-only refresh when they mount while online, so a notice
published after the last login appears without a full re-login.
5.4 If the `scope_notice` table does not exist on the backend yet, the app shall still work: the notice query error
is logged once as a warning and the Default notice of each type shows.
5.5 Accepted staleness: a cached notice that the server has since retired or corrected stays visible offline until the
next successful refresh, which happens at the next online login or the next Burial or Expenses tab mount while online. There is no
other maximum age. An expired notice never shows regardless of cache age (3.6).

### Requirement 6: Notice read and write access control

**User Story:** As the product owner, I need notice writes restricted to HO inside their district and reads limited to
people who should see them.

#### Acceptance Criteria

6.1 The browser client shall have no INSERT, UPDATE or DELETE privilege or policy on `scope_notice`. Writes shall be
possible only through the `admin-write` Edge Function.
6.2 The new `admin-write` actions shall follow the Privileged Route Checklist order: service-role key present (500),
Bearer token (401), `auth.getUser` (401), active `user_hierarchy_access` role `HO` (403), validate body (400), write
with the service-role client.
6.3 The write itself shall run in one SQL function callable only by `service_role`. That function shall re-check, from
the caller's user id, an active, in-window HO access row plus the district assignment, so a gate gap in the Edge
Function cannot widen access.
6.4 **Every role reads notices, the Secretary included (RD1).** An authenticated user, whatever the role, shall be able to
SELECT only active notices of their own district. "Own district" means the notice's district contains a congregation that
the user's access covers: through `get_my_hierarchy_ids()`, or through any non-HO active, in-window `user_hierarchy_access` row
whose `congregation_id` is the congregation or whose `hierarchy_id` is the congregation's hierarchy, eldership,
overseership, apostleship or district id; or the user is an HO assigned to that district (an HO access row without the `ho_district_assignments` row admits nothing, steering invariant 3). The rule is one shared SQL function
(`scope_district_readable`) with no role term, and the expense category configuration of Spec 1 uses the same function.
Anonymous users shall read nothing. Whether the district scoping itself stays (versus "every authenticated user reads every
notice") is Open Decision O3; the resolved decision is only that no ROLE is excluded.
6.5 `notice.manage` shall be a permission-matrix row with `HO: "M"` and `-` for every other role. The HO screen
and its navigation entry shall be gated through `permissions.ts` (`hasPermission`). No role string comparison shall
appear in a page or component.

### Requirement 7: Burial exempt from mandatory proof

**User Story:** As a Treasurer, I do not need to attach a proof to every Burial line, because the receipt number and the
deposit slip already evidence it.

#### Acceptance Criteria

7.1 With `proof_mandatory = true`, a Burial line without an attachment shall not appear in the client's missing-proof
list and shall not block Submit (`src/components/CashbookForm.tsx`, `src/lib/completeCapture.ts`).
7.2 With `proof_mandatory = true`, `cashbook_review_ready` shall return true for a period whose only unproofed lines are
Burial lines (other conditions satisfied), for a manifest of EITHER `balance_rule` (1 or 2).
7.2a The server change shall consist of exactly two identical edits to `cashbook_review_ready` (the `balance_rule = 1` legacy
branch and the `proof_mandatory = true` block of the rule-2 path); no other behaviour of the function changes. Spec 1's
"verbatim legacy" wording is to be read as "except the Burial exemption of this spec".
7.3 The server rule shall identify Burial lines by `section = 'Burial'`. A Burial line whose `item_type` has been
rewritten to `CashBanked` shall be treated identically to one still typed `Burial`.
7.4 EFT, DirectDebit and Expense lines shall keep their current proof rule. The cash deposit-slip rule for periods
that contain cash (including Burial cash) shall be unchanged.
7.5 A user shall still be able to attach a proof to a Burial line voluntarily (optional attach control remains, no
"missing" warning). See Open Decision O9.
7.6 `proof_mandatory = false` behaviour shall be unchanged.
7.7 The client predicate shall be `proofRequiredFor(line: { section: string; item_type: string }): boolean`, true only
when `line.section !== "Burial"` and `line.item_type` is one of EFT, DirectDebit or Expense. Every client call site shall
pass the line (not just the item type). A line with `section: "Burial"` and `item_type: "EFT"` shall not be
proof-required; a line with `section: "Members"` and `item_type: "EFT"` shall be.

### Requirement 8: Burial trend on the Burial tab landing

**User Story:** As a Treasurer, I see how this year's Burial receipts compare with last year's, month by month.

#### Acceptance Criteria

8.1 When the Burial tab is active, a chart shall show, for each month of the trend window, the Burial amount for that
month and for the same month of the prior year (two series, 12 categories).
8.2 Prior-year values shall come from the server through an RPC that returns, per month, `(yr, mo, total, period_ids)`,
where `period_ids` lists the ids of the periods that make up `total`. No line item, receipt number or proof shall be
returned.
8.3 The RPC shall return rows only when the caller holds ONE active, in-window `user_hierarchy_access` row that is either
(a) a Treasurer, Chairperson or Elder row whose `congregation_id` equals the requested congregation (the same
role-and-congregation-on-one-row pattern as Tranche 4, `20261105130000_tranche4_proof_access.sql` lines 270 and 296), or (b)
an Elder row with `scope_level = 'Eldership'` whose `hierarchy_id` equals that congregation's `eldership_id`. Branch (b)
is the one that applies to a real Elder: verified read-only on the dev/demo backend (2026-11-27), the Elder access row has
`congregation_id` NULL and `hierarchy_id` equal to `congregations.eldership_id`. A role held at another congregation or
eldership, or a different role at this one (for example Auditor or Secretary), shall not authorise the read. A caller with no
qualifying row shall receive no rows.
8.4 Periods with status `Draft` or `Rejected` shall be excluded from server totals. This device's own periods shall be
added from Dexie, keyed on `section = 'Burial'`, for every local period whose `serverId` is null or is NOT listed in the
`period_ids` of the server result in use (fresh or cached). A local period whose `serverId` is listed is skipped
because the server total already counts it. The rule does not read the local `status` field, which Dexie never
refreshes from the server (design 7.1). A period is therefore never dropped when the server later rejects it, and never
counted twice.
8.4a Invalid RPC arguments (null congregation, month outside 1-12, year outside 2000-2100) shall return no rows and no error; the
client shall then hide the chart (design 10).
8.5 A month with no data shall show as zero and the chart shall say so ("No Burial recorded"). When the whole window
and prior-year window are zero, the chart shall be replaced by one line of text.
8.6 Offline, the trend shall show the last successful server result, stored per congregation in Dexie, labelled "as of
<date>". When no result is stored, it shall show this device's local current-year months only, labelled "Prior year
needs a connection".
8.7 A trend read failure (network, RPC missing, not permitted) shall never block capture, never show an error toast,
and shall show a short inline note.
8.8 The trend shall use no more than 24 numbers and no line detail (totals only). The trend renders only on the capture Burial
tab, which a Secretary cannot enter (`canEnterCapture`: Elder, Chairperson, Treasurer). **Resolved decision RD2 (2026-11-27):
the Elder also sees the trend.** The matrix row `burial.trend_view` grants V to Elder, Chairperson and Treasurer and `-` to
every other role (Secretary, HO, Auditor, Overseer, Apostle), and the RPC lists the same three roles (8.3). The Elder's access
row is Eldership-scoped, which is why the RPC has the extra branch (b) in 8.3. The Secretary has no trend surface (it reads
notices, 3.9); a Secretary Burial totals block stays out of scope (Open Decision O13).
8.8b Acceptance: for a role whose `burial.trend_view` is `-`, the `BurialTrend` component renders nothing and makes no
RPC call. For an Elder, `BurialTrend` renders the same chart as for a Treasurer, from the same RPC, with totals only (no
receipt number, no proof, no line item). If the RPC returns no rows for an Elder (for example an Elder whose Eldership row
does not cover this congregation), the component hides the chart and shows nothing else, as in 8.4a.
8.9 The chart shall have an accessible text alternative: a visually hidden table of the same values and an `aria-label`
on the figure.
8.10 The chart component shall be the same component used by Requirement 9.

### Requirement 9: Officer Faithfulness upgrade

**User Story:** As a Chairperson or Elder, I see which periods officers tithed in and how many periods each officer
missed.

#### Acceptance Criteria

9.1 The detail page (`/dashboard/officer-faithfulness`) shall show a chart with one bar per period in the selected
window: officers tithed versus officers not tithed (stacked, total = active officers).
9.2 The page shall show, for every active officer, "missed N of M periods", where M is the number of periods in the
window and N the number of those periods in which the officer has no line item.
9.3 The window shall be selectable: "Last 4 periods" (default) or "All captured periods". "All" shall be capped at the
most recent 26 periods and shall say so when the cap applies.
9.4 For the "Last 4" window, the set of officers with N = M (including the zero-period case, where M = 0 and N = 0 so
every active officer matches) shall equal exactly the list the dashboard card counts (`countOfficerFaithfulness`) on the
same data. A row with M = 0 shall read "No periods yet" and not "None in window". The Dexie path and the Elder live path
each apply the officer filter of their own card path (active; the live path also filters `rank in ('Priest','Underdeacon')`;
the Dexie cache already holds only those ranks, `src/utils/cacheLoader.ts` line 58).
9.5 Access shall remain governed by `canViewOfficerFaithfulness` (matrix row `dashboard.officer_faithfulness`:
Chairperson and Elder only). A Treasurer, Secretary and every other role shall be redirected exactly as today.
9.6 The Elder live path (`officerFaithfulnessLive.ts`) shall provide the same data from Supabase under RLS, with the
same window and the same rule.
9.7 The page shall keep its Back button and its loading, error and "every officer tithed" states. Rows shall be sorted
by missed count descending, then officer code.
9.8a Data source. For a Chairperson the page reads periods held in this device's Dexie store (`dashboardRepo`), the same
source as the dashboard card. Those rows exist only because this device captured them (`captureRepo.ts` line 95 is the
only `db.periods.add`; `syncEngine.ts` never pulls periods down). For an Elder the page reads the latest periods live from
Supabase under RLS. The caption shall say which source applies.
9.8b When the number of periods available (M) is below the window size, the page shall show a note: "Only M period(s) are
held on this device" (Chairperson) or "Only M period(s) exist" (Elder). Open Decision O16 covers a live read for the
Chairperson.
9.8 The caption shall state the limits: AM and PM are separate periods, the current officer list is applied to past
periods, and an officer added later will show earlier periods as missed. The caption shall also say that a pre-paid
expense recorded against an officer counts as tithed (Spec 1 `expense-payment-source`, assumption A3: the officer
appears on a line of that period), so an officer who paid church costs and tithed only through that expense is not shown
as missed. The chart legend label "Tithed" is covered by the same caption.

### Requirement 10: Safe delivery

#### Acceptance Criteria

10.1 No migration, seed script or Edge Function change shall be applied or deployed to `cwdyixafvylzgtpsfmwr` by this
spec. All SQL is authored for a disposable stack and applied only after an explicit user authorisation.
10.2 The client shall run correctly before the migrations are applied: notice area shows the Default notice, the trend
shows local data only or hides itself, Burial proof exemption applies to the client rule, and the Faithfulness page
upgrade works from Dexie.
10.3 No real bank account number, real person name, real phone number or secret shall appear in any file added by this
spec, in any test, or in any seed script.
10.4 Baselines hold after every task: `tsc --noEmit` 0 errors; vitest all passing; lint no new errors (1 known error, 6
known warnings); `vite build` passes.

### Requirement 11: Expenses notice (the second notice type)

**User Story:** As a DHO, I publish guidance about expenses (what is claimable, how to record a pre-paid expense, how to
name an invoice) that every Treasurer sees directly above the expense capture line. This replaces the idea of a free-text
Notes column on each expense line (resolved decision RD4).

#### Acceptance Criteria

11.1 The Expenses notice is the same record, the same table and the same process as the Burial notice, with notice type
`Expenses`: scope District, Apostleship or Overseership; start date and optional expiry date; the same message rules (1.2);
the same overwrite prompt at the same type and scope (requirement 2); the same retire and edit rules (1.6, 1.7); the same
`admin-write` path and Privileged Route Checklist gate (6.2, 6.3); the same offline Dexie cache (requirement 5); the same
read rule for every role (6.4). No second table, no second HO screen, no second Edge action pair.
11.2 The Expenses tab shall render the Expenses notice area below the tab button row and above the expense capture bar in
`CashbookForm`, whether or not the user may edit (`canEdit`). It shall not render on other tabs. The Burial and Expenses areas
never appear together.
11.3 The area shall show the active `Expenses` notices that apply to the period's congregation, resolved by the same pure
function and the same rule as the Burial notice (3.2, 3.3 and Open Decision O1, which applies to each type independently),
with the same scope label and "until <date>" text (3.7), rendered as text (3.5) and judged by the device date (3.6).
11.4 When no `Expenses` notice is active, the Default Expenses notice shall show, labelled "Standard notice" (4.3). It works
offline and with an empty cache.
11.5 The Default Expenses notice shall say, in paraphrase: record each expense on its own line; choose how it was paid and
pick a category; attach the invoice for every expense; if an officer paid from his own pocket, record it as pre-paid by that
officer and name him. Its text comes from one constant (`EXPENSES_DEFAULT_TEXT`) holding no account number, no real name and
no phone number. No other file contains the text. The Burial and Expenses defaults are separate constants.
11.6 A Burial notice and an Expenses notice never conflict (2.6), and a type cannot be changed on an edit (1.1).
11.7 A failure to read Expenses notices (network, table missing) never blocks expense capture and shows the Default
Expenses notice (5.4).
11.8 Spec 1 (`expense-payment-source`) references this requirement for the Expenses notice and adds no notice code of its
own. Spec 1 carries no per-line Notes column on expenses.
## Non-Functional Requirements

N1. The notice, trend and chart code shall add no npm dependency (Open Decision O7).
N2. The Burial tab shall render its capture bar without waiting on any network call. Notice and trend loads are
asynchronous and non-blocking.
N3. The chart module shall add under 6 KB of source (about 150 lines including the pure scale helper) so removing Burial
later is cheap.
N4. Pure logic (notice resolution and view model, trend window, merge and view model, faithfulness windows and view model,
HO form validation and conflict-panel state) shall have unit tests and fast-check properties and shall not import Dexie,
Supabase or React.
N5. Test tooling is unchanged: vitest runs in the `node` environment and includes only `src/**/*.test.ts`; no jsdom or
Testing Library is installed and none is added. Component behaviour is covered by pure view-model tests plus a manual UAT
task, never by component render tests.

## Out of Scope

- Rich text, attachments, translations or per-congregation messages. Congregation-level scope is not offered.
- Push notifications, read receipts, or per-member acknowledgement.
- Recording the account number as structured data or validating it. The account text is free text inside the message.
- Changing the `proof_mandatory` setting model (no per-section split) and changing how Burial cash is banked.
- Fixing the Burial lines disappearing from the Burial tab after "Mark Banked" (`tabItems` filters
  `item_type === "Burial"`). Recorded as a known issue (design section 15), not fixed here.
- Fixing the `admin-write` gate gaps (no date-window check, unordered `limit(1)` access row). Recorded for a bugfix spec.
- A Burial report or trend surface for Secretary, Overseer, Apostle or HO across congregations. The trend is per
  congregation, on the Burial tab, for Treasurer, Chairperson and Elder (8.8).
- Applying migrations, seeding the dev/demo backend, or deploying Edge Functions.
- Component render tests (no jsdom or Testing Library; see N5).
- Any change to `src/ho/` screens other than the new notice screen and one navigation entry.
- Officers Fund and reimbursement flows.
