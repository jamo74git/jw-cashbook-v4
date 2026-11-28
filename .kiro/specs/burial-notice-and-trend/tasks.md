# Implementation Plan: Burial Notice, Burial Proof Exemption, Burial Trend and Officer Faithfulness Chart

> DRAFT. Do not start until the user approves `requirements.md` and `design.md` and answers the Open Decisions
> (design.md section 17). No task here applies a migration to `cwdyixafvylzgtpsfmwr`, deploys an Edge Function, commits or
> pushes unless the task says so and the user has authorised it. SQL is applied only to a disposable stack
> (`supabase start`, Docker) or an explicitly identified disposable test project.
>
> Baselines to hold after every task (from `PROJECT-LOG.md`): `tsc --noEmit` 0 errors; vitest all passing (237 at
> `c98feafd`); lint = 1 known error (`_params` in `captureRepo.ts`) + 6 warnings, no new ones; `vite build` passes.
>
> **Dependency order (revised 2026-11-27).** The two specs are interleaved, because Spec 1 now consumes this spec's notice
> mechanism (Expenses notice) and its SQL helpers (expense categories), and this spec still depends on Spec 1's proof and
> `cashbook_review_ready` changes. Order: Spec 1 T0-T14 (pure logic, Dexie v5, repo, migration authoring, sync) -> this spec T0-T8
> and T7b (the generalised notice mechanism, including the Expenses type and the shared SQL helpers) -> Spec 1 T15 onward (its UI
> consumes `ScopeNotice` and `ScopePicker`; its category administration task needs T4, T5 and T8 here) -> this spec T9-T22.
> Dexie versions: whichever spec touches `schema.ts` second takes the next free number (each task reads `schema.ts` first).
> `cashbook_review_ready` (T13) still comes after Spec 1's migration. Within this spec: T0 first; T2 before T7, T8, T11;
> T1 before T7; T3 before T8; T4 before T5; T5 before T8; T6 before T7; T9 before T11 and T18; T10 before T11;
> T15 before T16, T17, T18; T11 and T13 migrations need T4 done only for numbering (independent otherwise).
>
> **Test rule (design 16, N5).** vitest is node-only over `src/**/*.test.ts`; no jsdom or Testing Library. Every task's
> automated verification is a pure-function `.test.ts`. Rendering is verified only by manual UAT task T20.
>
> Parts: A = Notices, Burial and Expenses types (T1-T8, T7b), B = Burial chart, trend and proof exemption (T9-T14), C = Officer Faithfulness upgrade
> (T15-T18), then verification and records (T19-T22).

## Phase 0: Gate

> Migration status: `20261124110000_scope_notice.sql`, `20261124120000_burial_proof_exempt.sql` and `20261124130000_burial_monthly_totals.sql` are already AUTHORED in `supabase/migrations/` with NOT APPLIED headers and never parsed by Postgres. T4, T11 and T13 review and test them. Seed scripts (T14) are not yet authored.

- [ ] T0. Record decisions
  - Get the user's answers to O1-O18 (O13 is partly resolved) and write them into `design.md` section 17 (add a "Decision" column).
  - Verification: every row has an answer; O1, O2, O3, O4, O6, O8 and O13 are reflected in design sections 3, 4 and 5 and in
    `requirements.md` 3.3, 6.4 and 8.8; the `tasks.md` tasks that depend on a changed answer are edited.

## Part A: Notices (Burial and Expenses types)

- [ ] T1. Notice resolution and view model (R3, R4)
  - Add `src/lib/scopeNotice.ts`: `NOTICE_TYPES`, `isActiveOn`, `scopeRank`, `resolveNotices(rows, noticeType, ids, todayISO, max)`,
    `noticeView(rows, noticeType, ids, todayISO, max)`, `MAX_NOTICES_SHOWN`, `BURIAL_DEFAULT_DETAILS` (synthetic values only),
    `buildDefaultNotice`, `EXPENSES_DEFAULT_TEXT` (no banking detail), `defaultNoticeText(noticeType)`.
  - Add `src/lib/scopeNotice.test.ts`: Appendix B vectors N1-N12 (N9-N12 are the type vectors), `noticeView` kinds for both types,
    `<b>x</b>` returned unchanged, the two properties and the type-isolation property (design 16).
  - Verification: `vitest run src/lib/scopeNotice.test.ts` passes; the module imports nothing from React, Dexie or
    Supabase; a search of the new files for digit runs of 8 or more finds only `9999 0000 111` and `011 293 4567` (both in the Burial default only; `EXPENSES_DEFAULT_TEXT` has none).

- [ ] T2. Permission rows (R6.5, R8.3, R8.8; O13)
  - `src/lib/permissions.ts`: add `notice.manage` (`HO: "M"`, all others `-`; one row for both notice types) and `burial.trend_view`
    (Elder, Chairperson and Treasurer `V`; every other role including Secretary `-`; Elder added 2026-11-27, RD2); export the two key constants beside
    `OFFICER_FAITHFULNESS_VIEW`.
  - Update the permission-matrix tests deliberately (find any snapshot or characterization test first).
  - Verification: new tests assert the full role row for both keys (including Elder `V` and Secretary `-` for `burial.trend_view`, requirement 8.8); existing permission tests pass; a `grep` shows no role
    string comparison added under `src/`.

- [ ] T3. HO form logic (R1.2-1.4, R1.9, R2.1-2.2)
  - Add `src/ho/scopeNoticeForm.ts`: `validateNoticeForm` (includes the `notice_type` rule), `conflictPanelState`, `visibleNotices` (design 4.5, 5.1, 10).
  - Add `src/ho/scopeNoticeForm.test.ts`: every rule in design section 10 (missing or unknown `notice_type`, changed `notice_type` on edit, empty, whitespace-only, 1001 chars, bad date,
    expiry before start, expiry before today on create, control characters; on edit: expiry before today allowed, expiry before start rejected, `starts_on` moved, scope change rejected, conflict check requested only when a date changed); `conflictPanelState` for conflict, saved and
    error bodies; `visibleNotices` hides expired by default and shows them with `showExpired`.
  - Verification: tests pass; the module imports nothing from React, Dexie or Supabase.

- [ ] T4. `scope_notice` table, RLS, shared scope helpers, publish and retire functions (R1, R2, R6, R11; O2, O3, O12)
  - REVIEW the already-authored `supabase/migrations/20261124110000_scope_notice.sql` (regenerated 2026-11-27 with the `notice_type` key; NOT APPLIED header; table with trim-set and control-character CHECKs; read function `scope_district_readable` and policy; shared helpers `scope_resolve_district` and `scope_assert_ho`; `scope_notice_publish` with advisory lock keyed on type and scope; idempotent `scope_notice_retire`) against design 3.11, 4.1-4.2 and fix any drift; do not rewrite it from scratch. The helpers are consumed by Spec 1's `20261124115000_expense_category.sql`; do not change their signatures without updating it.
  - Author `supabase/tests/scope_notice_rls.test.sql` covering integration cases 1-7 including 5b (edit rules), 6b (concurrent publish, advisory lock), 6c (message rules: `E'\n'`, `E'\t'`, `E'\r\n'`, spaces only, `E'a\x01b'`, 1001 characters), 7b (read rule for every role: Elder via an Eldership row, Secretary, Auditor, Chairperson; asserted), the 400-versus-403 split in cases 2 and 5, the type cases (a Burial and an Expenses notice at one scope and dates never conflict; `notice_type` outside the two values and a changed type on edit raise 22023) and the create-date boundary (an expiry of UTC yesterday is accepted, the UTC day before yesterday raises 22023; review NIT 4) (design 16).
  - Verification: the SQL parses on a disposable stack (`supabase db reset`) and the test file passes there. If no stack is
    available the task stays "authored, not run" and the final report says so. Nothing is run against `cwdyixafvylzgtpsfmwr`.

- [ ] T5. Edge Function actions and client wrapper (R6.2, R6.3)
  - `supabase/functions/admin-write/scopeNotice.ts` (pure `validateScopeNoticeRequest`, no Deno imports); `index.ts`: add
    the two actions after the existing gate as in design 5.3, leaving the gate and existing actions untouched;
    `src/ho/adminApi.ts`: add `publishScopeNotice` and `retireScopeNotice` (the payload carries `notice_type`; one action pair for both types).
  - Write the self-contained validator (no imports) in `supabase/functions/admin-write/scopeNotice.ts` with
    `validateScopeNoticeRequest`, the dispatching entry `validateConfigRequest(payload)` (only the two notice actions are dispatched until Spec 1 adds the category actions) and `mapScopeNoticeError`, and an identical copy at `src/lib/scopeNoticeRequest.ts`.
    `index.ts` imports only the same-folder file and returns fixed error text by SQLSTATE (42501 403, 22023 400, other 400),
    logging detail with `console.error`.
  - Tests (`src/lib/scopeNoticeRequest.test.ts`): every rule in design 10; the SQLSTATE mapping never echoes `error.message`;
    `src/lib/scopeNoticeRequest.copy.test.ts` reads both files and asserts they are byte-identical.
  - Verification: tests pass (including the byte-identity test); `git diff supabase/functions/admin-write/index.ts` shows exactly one added import line (`./scopeNotice.ts`) plus the new action block, with the gate and the existing `create_hierarchy`/`update_hierarchy` actions unchanged;
    `tsc --noEmit` 0 errors. No deploy.

- [ ] T6. Dexie store and cache loader (R5)
  - Read `src/db/schema.ts`, find the highest `this.version(n)` (4 at the time of writing; 5 once Spec 1 has landed) and add
    `this.version(n + 1).stores({ scopeNotices: "id, notice_type, district_id, scope_id" })` (the next free version; if Spec 1 lands later it takes
    the next free number after this one, as Spec 1 T8 states), the `ScopeNoticeRow` type, the table field,
    and update the header comment.
  - `src/utils/cacheLoader.ts`: add the notice query to the `allSettled` array, `RefreshResult`, the transaction, and export
    `refreshScopeNotices()` (never throws).
  - Tests (fake-indexeddb, extend the existing cacheLoader test file or create `cacheLoader.scopeNotices.test.ts`): a
    failed notice query keeps old rows while other stores still refresh; success replaces; a missing table logs one warning.
  - Verification: new and existing cacheLoader tests pass; existing schema and Dexie tests pass; `grep` shows no other code
    treats `refreshReferenceCache().ok === false` as fatal.

- [ ] T7. `ScopeNotice` component and placement on both tabs (R3, R11.2; O1)
  - `src/components/ScopeNotice.tsx`: reads the congregation ids and `db.scopeNotices`, calls `refreshScopeNotices()` on
    mount when online, then renders `noticeView(...)`. It takes a `noticeType` prop. Insert in `CashbookForm.tsx` between the tab row
    and the capture bar for `activeTab === "Burial"` (type `Burial`) and for `activeTab === "Expenses"` (type `Expenses`, above the
    expense capture line), rendered whether or not `canEdit`. Spec 1's expense capture UI task relies on this placement and adds no notice code.
  - Add a node source-guard test `src/components/ScopeNotice.guard.test.ts` that reads the component file and asserts it has
    no `dangerouslySetInnerHTML` and renders the message only through `{item.message}`.
  - Verification: the guard test and existing CashbookForm-related tests pass; `tsc` 0; rendering is checked in T20.

- [ ] T7b. Secretary notices panel (R3.9; O17)
  - Read `src/review/SecretaryReview.tsx` (or wherever `SecretaryReview` lives) first and record where a single congregation is in
    view. Add a read-only "Notices" panel that shows both notice types for that congregation through `resolveNotices` / `noticeView`,
    text only. No amount, line item or proof is added to the screen. If no single congregation is in view, stop and report under
    design 5.6 rather than guessing.
  - Verification: a pure test of the panel view model (both types, defaults, expired hidden); a grep shows the panel adds no write
    call and no `dangerouslySetInnerHTML`; `tsc` 0; rendering checked in T20 (Secretary login).
- [ ] T8. HO notice screen (R1.6, R1.9, R2, R11.1; depends on T2, T3, T5)
  - `src/ho/ScopeNoticesScreen.tsx` (one screen for both types: notice type select first, type badge on rows, optional type filter),
    the shared `src/ho/ScopePicker.tsx` (scope level and node selects filtered by `getHODistrictIds`; reused by Spec 1's category
    screen), route `/ho/notices` in `src/App.tsx`, nav entry in `src/ho/HOAdminLayout.tsx`
    gated by `hasPermission(role, "notice.manage")`. Inline conflict panel with Replace, Keep both, Cancel; "Show
    expired" toggle; offline block as the other HO screens. All decisions come from `scopeNoticeForm.ts`.
  - Verification: T3 tests still pass; `tsc` 0; `grep` shows the screen contains no role string comparison and no
    `dangerouslySetInnerHTML`; behaviour checked in T20 against a mocked or stack-backed function.

## Part B: Burial chart, trend and proof exemption

- [ ] T9. Shared chart (R8.9, R8.10, R9.1; O7)
  - `src/components/charts/chartMath.ts`, `chartMath.test.ts`, `BarChart.tsx` (grouped and stacked, legend, axis, hidden
    table, `aria-label`). No dependency added; `package.json` unchanged.
  - Verification: tests pass (all-zero input yields no NaN; stacked totals; single value; equal values);
    `git diff package.json package-lock.json` is empty; component plus helper are under about 150 lines.

- [ ] T10. Trend logic (R8.1, R8.4-R8.6; O4, O5)
  - `src/lib/burialTrend.ts`: `trendWindow`, `mergeTrend` (keyed on server `period_ids`, never on local `status`), `trendViewModel`. `src/lib/burialTrend.test.ts`: Appendix A
    vectors TV1-TV11 (TV10: server later Rejected; TV11: synced after the cache), year rollover for every end month, cents arithmetic, property "merged sum equals inputs in range",
    `trendViewModel` for server, cache, local-only, failure and all-zero.
  - Verification: tests pass; the module imports nothing from React, Dexie or Supabase.

- [ ] T11. Trend repository, RPC migration and component (R8; RD2; O11, O14; depends on T2, T9, T10)
  - `src/db/burialTrendRepo.ts`: RPC call with a local 8 second `Promise.race` timeout, `syncMeta` cache key
    `burialTrend:<congregationId>`, local overlay reading Dexie periods and items keyed on `section === "Burial"`, skipping periods whose `serverId`
    is in the result's `period_ids`.
  - `src/components/BurialTrend.tsx` gated by `hasPermission(role, "burial.trend_view")`, rendered under `ScopeNotice` in
    `CashbookForm.tsx` for `activeTab === "Burial"`; maps `trendViewModel` only.
  - REVIEW the already-authored `supabase/migrations/20261124130000_burial_monthly_totals.sql` (NOT APPLIED header; plpgsql with an early `return` for invalid arguments; role list Treasurer, Chairperson and Elder; returns `period_ids`) against design 4.3 (output columns `yr` and `mo`; role gate branches (a) Treasurer, Chairperson or Elder with `congregation_id`, (b) Elder with an Eldership row) and add integration cases 8, 8b, 8c, 8d (invalid arguments return no rows and no error) and 8e to `supabase/tests/`. The client mapper reads `yr` and `mo`.
  - `BurialTrend` returns null and makes no RPC call when `hasPermission(role, "burial.trend_view")` is false (every role except Elder, Chairperson and Treasurer); covered by a pure `shouldLoadTrend(role)` test that asserts Elder true and Secretary false. The Elder sees the same chart from totals only.
  - Tests (`burialTrendRepo.test.ts`, node, mocked Supabase client and fake-indexeddb): server success writes the cache;
    error with cache returns `source: "cache"`; error without cache returns `source: "local"`; timeout; offline; the repo
    never throws.
  - Verification: tests pass; with the RPC absent the repo returns local data (checked by the mocked-error test); rendering
    and "no toast" checked in T20.

- [ ] T12. Burial proof exemption, client (R7.1, R7.3-R7.7; O9)
  - Read the current `needsProof` (`CashbookForm.tsx` line 45 at the time of writing) and `PROOF_REQUIRED_TYPES`/`proofRequiredFor`
    (`completeCapture.ts` lines 25-29); Spec 1 changes them, so re-read after Spec 1 lands.
  - Add `src/lib/proofRules.ts`: `proofRequiredFor(line: { section: string; item_type: string }): boolean` =
    `line.section !== "Burial" && ["EFT","DirectDebit","Expense"].includes(line.item_type)`, and `proofAttachAllowedFor(line)` =
    `proofRequiredFor(line) || line.section === "Burial"`.
  - Update every call site (design 6.1 table): `CashbookForm.tsx` (missing list at ~211, submit gate, attach controls at ~438 and ~849: drop
    `needsProof`) and `completeCapture.ts` (remove `PROOF_REQUIRED_TYPES`; calls at ~86 and ~239 pass the whole line instead of `item_type`).
    Update every existing test that pinned Burial as proof-required (list them in the task report).
  - Add `src/lib/proofRules.test.ts`: `{section:"Burial", item_type:"EFT"}` NOT required; `{section:"Burial", item_type:"CashBanked"}` NOT;
    `{section:"Burial", item_type:"Burial"}` NOT; `{section:"Members", item_type:"EFT"}` required; DirectDebit and Expense outside Burial
    required; `proofAttachAllowedFor` true for every Burial line.
  - Verification: the new and updated tests pass; `grep -n "needsProof\|proofRequiredFor(.*item_type" src` finds no remaining string-signature use;
    existing `completeCapture` tests pass; `tsc` 0.

- [ ] T13. Burial proof exemption, server migration (R7.2, R7.3; depends on Spec 1 migration)
  - REVIEW the already-authored `supabase/migrations/20261124120000_burial_proof_exempt.sql` (full function body generated from Spec 1's `cashbook_review_ready` with exactly two identical edits, design 6.2; header says it must not be applied unless Spec 1's migrations are applied). Re-generate it if Spec 1's function changes. Add
    integration cases 9 and 9b (`balance_rule` 2 and 1) to `supabase/tests/`.
  - Verification: a scripted text diff of Spec 1's function body (`20261124100000_expense_payment_source.sql`, from `create or replace function public.cashbook_review_ready` to the closing `end $$;`) against the new file's body shows exactly TWO changed hunks, both the same edit (`li.section is distinct from 'Burial'` added and `'Burial'` removed from the `item_type` list), one in the `balance_rule = 1` branch and one in the `proof_mandatory = true` block (the diff output is kept in the task report); the SQL test is run on a disposable stack in T19, or recorded "authored, not run".

- [ ] T14. Synthetic seed scripts, authored only (design 9; O8)
  - Author `supabase/seed_burial_trend_synthetic.sql`, its cleanup script and `supabase/seed_scope_notice_synthetic.sql`.
    The trend seed requires a `SYNTH`-prefixed congregation code and a psql variable for the congregation id.
  - Verification: static check only here: digit-run grep of the files finds only synthetic values; the script contains the
    `SYNTH` guard. Execution and row counts are verified on a disposable stack in T19. Never run on `cwdyixafvylzgtpsfmwr`.

## Part C: Officer Faithfulness upgrade (chart, missed count)

- [ ] T15. Pure faithfulness core (R9.2, R9.4, R9.7)
  - `src/lib/faithfulness.ts`: `windowPeriods`, `buildFaithfulness`, `faithfulnessViewModel` (returns `partialWindow` when M < window size). `src/lib/faithfulness.test.ts`:
    counts; zero periods (every active officer, `missed = of = 0`, badge "no-periods"); window cap at 26 with `capped`;
    sorting by missed descending then code; badge "none-in-window"; the equality
    `officers.filter(o => o.missed === o.of)` against a pure re-implementation of the card rule on generated fixtures
    (fast-check).
  - Verification: tests pass; the module imports nothing from React, Dexie or Supabase.

- [ ] T16. Dexie history function (R9.1-R9.4)
  - `src/db/dashboardRepo.ts`: add `getFaithfulnessHistory(congregationId, window)` using `buildFaithfulness`. Leave
    `listOfficersWithoutRecentTithe` and `countOfficerFaithfulness` untouched.
  - Tests (fake-indexeddb): periods with and without lines, AM and PM both counted, interim officer included, window 4
    versus "all", zero periods, and `missed === of` set equals `listOfficersWithoutRecentTithe` for the 4-window.
  - Verification: tests pass; existing `dashboardRepo` tests unchanged and passing.

- [ ] T17. Live history for the Elder (R9.6)
  - `src/elder/officerFaithfulnessLive.ts`: add `getFaithfulnessHistoryLive` with the explicit
    `.eq("is_active", true).in("rank", ["Priest","Underdeacon"])` officers query (design 8.1).
  - Tests (mocked Supabase client in a `.test.ts`): window limit 4 or 26 is passed; the officers query receives the rank
    filter; a fixture containing a non-Priest officer does not count that officer; an RLS error surfaces as an error;
    result equals the Dexie shape on identical fixtures.
  - Verification: tests pass; `listOfficersWithoutRecentTitheLive` is unchanged (`git diff`).

- [ ] T18. Faithfulness page: chart and missed-count table (R9; O10; depends on T9, T15-T17)
  - `src/components/OfficerFaithfulnessPage.tsx`: window toggle, stacked `BarChart`, table from `faithfulnessViewModel`
    ("missed N of M", badges, `partialWindow` note), caption stating the data source (device periods for the Chairperson, live for the Elder). Keep the guard, Back button and states.
  - Add a route-guard test pinning `canViewOfficerFaithfulness` (true: Chairperson, Elder; false: Treasurer, Secretary and
    every other role).
  - Verification: tests pass; `git diff` of `permissions.ts` and `routeGuard.ts` shows nothing for this task; rendering,
    Back from both entry points and the Treasurer redirect are checked in T20.

## Verification and records

- [ ] T19. Disposable-stack run (needs Docker and the user's go-ahead)
  - On a disposable stack run, in order: all migrations through Spec 1's, then T13, T4 and T11 migrations (by timestamp),
    then `supabase/tests/*.test.sql` including Spec 1's and the sign-off tests, then the T14 seed scripts, the T11 RPC and
    the cleanup script.
  - Verification: every SQL test passes; the T13 function diff is clean; the RPC returns 24 months for the `SYNTH`
    congregation and nothing for a role at another congregation (case 8b); the `generate_series` call resolves; cleanup
    removes every synthetic row (row counts before and after recorded). If Docker or a disposable project is unavailable,
    record "not run" and list the unrun cases; do not substitute the dev/demo backend.

- [ ] T20. Manual UAT script and run (rendering is verified only here)
  - Write `.agents/tasks/` or `.kiro/specs/burial-notice-and-trend/uat.md` with the checklist in design 16 ("Manual UAT"),
    then run it in the browser on the preview after merge.
  - Verification: each checklist line is marked pass or fail with the date; failures become tasks.

- [ ] T21. Full local verification
  - Run `npm run typecheck`, `npm run test`, `npm run lint`, `npm run build`.
  - Verification: 0 type errors; all tests pass; lint shows only the known 1 error and 6 warnings; build passes. Report the
    counts. `git diff --stat` lists no unexpected files; the digit-run grep over all new files finds only synthetic values.

- [ ] T22. Records (only after the work has landed and verified)
  - Update `PROJECT-LOG.md` CURRENT STATE and prepend a journal entry; update `.kiro/steering/tech.md` and `steering.md` only
    for what is real (new tables stay "authored, not applied" until applied; record B1-B6 under known issues); no secret.
  - Verification: the log states the migrations as authored-not-applied, the Edge Function as not redeployed, and lists
    anything unrun. Commit and push only when the user asks.

## Requirement traceability

| Requirement | Tasks |
|---|---|
| R1, R2 | T3, T4, T5, T8 |
| R3, R4 | T1, T7, T7b |
| R5 | T6 |
| R6 | T2, T4, T5 |
| R7 | T12, T13 |
| R8 | T2, T9, T10, T11, T14 |
| R9 | T9, T15, T16, T17, T18 |
| R10, N1-N5 | T0, T4, T14, T19, T21 |
| R11 | T1, T4, T5, T6, T7, T8 (and Spec 1 for the surrounding Expenses tab) |
