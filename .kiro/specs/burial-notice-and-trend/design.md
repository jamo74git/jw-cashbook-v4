# Design Document: Burial Notice, Burial Proof Exemption, Burial Trend and Officer Faithfulness Chart

Status: DRAFT for user approval, revised 2026-11-26 after the second design review round (CHANGES_REQUESTED; findings 2, 3, 4, 5, 8, 9 for this spec, responses in 19.4). Three migrations are AUTHORED in `supabase/migrations/` (`20261124110000_burial_notice.sql`, `20261124120000_burial_proof_exempt.sql`, `20261124130000_burial_monthly_totals.sql`), all NOT APPLIED and never parsed by Postgres. No code changed. Nothing is applied, deployed, committed or pushed.
Requirements: `requirements.md` in this folder. Companion: `.kiro/specs/expense-payment-source/` (Spec 1).

## 1. Overview

Four small changes on the existing Vite + React + Dexie + Supabase stack. No new npm dependency.

1. **Burial notice.** A new table `public.burial_notice` holds HO-written messages with a scope (District, Apostleship or
   Overseership), a start date and an optional expiry date. Writes go only through two new `admin-write` actions
   (`publish_burial_notice`, `retire_burial_notice`). Each action passes the Privileged Route Checklist gate, then calls
   one `service_role`-only SQL function that re-checks the caller, validates the scope against the caller's districts,
   detects overlap conflicts and writes inside one transaction. Authenticated users read their own district's active
   notices. `cacheLoader` copies them into a new Dexie store `burialNotices`. A `BurialNotice` component on the Burial tab
   resolves the applicable notices from the congregation's cached ids and falls back to a built-in default.
2. **Burial proof exemption.** Remove `Burial` from the two client proof-required lists and replace the server's
   `cashbook_review_ready` in a new migration, keying the exemption on `section = 'Burial'`.
3. **Burial trend.** A `SECURITY DEFINER` RPC `burial_monthly_totals` returns 24 monthly totals (this window and the prior
   year) for one congregation. A pure merge function adds this device's own editable periods. A small SVG bar chart,
   hand-written and shared with item 4, renders it. The last server result is cached in Dexie for offline use.
4. **Officer Faithfulness upgrade.** `dashboardRepo` and `officerFaithfulnessLive` gain a per-period history function.
   The existing detail page adds a stacked bar chart and a "missed N of M" column using the shared chart.

The client is built to run before any SQL is applied (section 13): every new server read degrades to the default notice,
local data, or a hidden chart.

## 2. Facts this design stands on

Verified means read in the working tree at `c98feafd` (branch `feat/treasurer-dashboard-v1`) or in the migration files.
The backend was not queried for this spec.

| # | Fact | Source | Status |
|---|---|---|---|
| F1 | `needsProof` lists `EFT, DirectDebit, Burial, Expense`. It drives both the missing-proof list (line 211) and the per-row attach control (lines 438 and 849). The report cites line 44; the file now has it on line 45. | `src/components/CashbookForm.tsx` | Verified |
| F2 | `PROOF_REQUIRED_TYPES = ["EFT","DirectDebit","Burial","Expense"]` and `proofRequiredFor()` | `src/lib/completeCapture.ts` lines 25-31 | Verified |
| F3 | `markCashBanked` sets `item_type` and `payment_type` to `CashBanked` on banked lines, including Burial lines. | `src/db/captureRepo.ts` lines 548, 572 | Verified |
| F4 | `tabItems` for the Burial tab filters on `item_type`, so banked Burial lines leave the tab. `incomeTotal` uses `section`. | `captureRepo.ts` line 446; `src/lib/captureTotals.ts` | Verified (report s8) |
| F5 | Server `cashbook_review_ready` gates `item_type in ('EFT','DirectDebit','Burial','Expense')` on `proof_mandatory`. Latest authored body is in Spec 1's migration (not applied); the applied body is `20261105140000_banked_cash_deposit.sql` line 131. | migrations | Verified (authored) |
| F6 | Spec 1 forces Expense proof regardless of `proof_mandatory` and rewrites `cashbook_review_ready`. A later `CREATE OR REPLACE` of the same function must start from Spec 1's body. | `supabase/migrations/20261124100000_expense_payment_source.sql` s8 | Verified |
| F7 | `congregation_settings` UPDATE/INSERT policies are role-only, not congregation-scoped. Rejected as the notice store. | report s9.3 | Verified (report) |
| F8 | `admin-write` has two actions, `create_hierarchy` and `update_hierarchy`, table writes through `buildWrite`. The HO check reads `user_hierarchy_access` with `status = active` and `.limit(1)` and compares `role === "HO"`. It does not check `start_date`/`end_date` and does not scope to a district. | `supabase/functions/admin-write/index.ts` | Verified |
| F9 | `adminApi.invoke` maps `data.error` to `{ok:false}`. A non-2xx response from `functions.invoke` returns an `error` with a generic message and no body. | `src/ho/adminApi.ts` | Verified; supabase-js behaviour for non-2xx is [UNVERIFIED] at the pinned version |
| F10 | HO is `user_hierarchy_access(role='HO', scope_level='District', hierarchy_id=district)` plus `ho_district_assignments(user_id, district_id)`. Tranche 4 requires both. | `environment-context.md`; `20261105130000_tranche4_proof_access.sql` lines 101-136 | Verified |
| F11 | `hierarchy_levels` has `id, name, code, level_type, parent_id`. Created by `create_hierarchy`. Level names in `HIERARCHY_LEVELS` are title case. The DB value casing of `level_type` is [UNVERIFIED]. | `admin-write`; `src/lib/types.ts` | Partly verified |
| F12 | `CongregationLookup` caches `district_id`, `apostleship_id`, `overseership_id`. `refreshReferenceCache` uses `Promise.allSettled`, replaces a store only if its own query succeeded, and runs only from `LoginPage`. | `src/db/schema.ts`; `src/utils/cacheLoader.ts` | Verified |
| F13 | Dexie is at version 4. Spec 1 plans `version(5)` for `lineProofs`. | `schema.ts` 323-370; Spec 1 design s4.3 | Verified |
| F14 | `cashbook_period` carries `year, month, week, service, status, congregation_id`. `status` is the enum `period_status`: Draft, Submitted, AuditApproved, SubmittedToOverseer, Rejected, SubmittedToHO, HOReviewed. Draft and Rejected are the editable states. | `environment-context.md`; `LocalPeriod` in `schema.ts` | Verified |
| F15 | No chart library in `package.json`. Only inline SVG exists in the repo (`src/audit/ProofLink.tsx` icons). `src/components/ui/` has badge, button, card, input, label, tabs only (no textarea, no dialog). | `package.json`; directory listing | Verified |
| F16 | Faithfulness card and detail share `listOfficersWithoutRecentTithe`. Any line with `officer_id` counts. The Elder reads live via `officerFaithfulnessLive.ts`. Matrix row `dashboard.officer_faithfulness` is V for Elder and Chairperson only. | `dashboardRepo.ts` 89-133; `OfficerFaithfulnessPage.tsx`; `permissions.ts` line 24 | Verified |
| F17 | `getHODistrictIds(userId)` reads `ho_district_assignments`. | `src/lib/permissions.ts` ~line 331 | Verified |
| F18 | Live `cashbook_line_item` columns include `section`, `amount`, `receipt_number`, `officer_id`, `transaction_date`. 4 Burial rows exist live. | report s9.1, s10 | Verified (report) |
| F19 | RLS on `cashbook_line_item` and `cashbook_period` SELECT policies were not read. `get_my_hierarchy_ids()` is verified to return congregation ids (compared with `congregation_id` in `20261105110000` lines 235, 304, 315, `20261105130000` line 283); its role coverage (Overseer, Apostle) is [UNVERIFIED]. | migrations | Partly verified; the trend RPC does not rely on either (section 7); the notice SELECT policy and the Treasurer read rely on the congregation-id behaviour |
| F25 | Dexie `periods` rows are created only by `captureRepo.ts` line 95 (`db.periods.add`). `syncEngine.ts` updates only `serverId`, `localStatus`, `lastError`, `submitOpId` and similar flags (lines 353-464), never the period `status`. A local period's `status` is therefore never refreshed from the server, and a server-side Rejected or later status is not reflected locally. | `src/db/captureRepo.ts`; `src/utils/syncEngine.ts` | Verified |
| F26 | The Chairperson's faithfulness page and card read Dexie (`dashboardRepo.listOfficersWithoutRecentTithe`, `OfficerFaithfulnessPage.tsx` line 56). Only the Elder (no home congregation, `?cong=`) reads live (line 41). The Chairperson dashboard itself reads Supabase live (`ChairpersonDashboard.tsx` lines 169, 287). | `OfficerFaithfulnessPage.tsx`; `ChairpersonDashboard.tsx` | Verified |
| F20 | Existing `supabase/tests/*.test.sql` pattern (pgTAP-style SQL files run on a disposable stack). | `supabase/tests/` | Verified by listing; content not read |
| F21 | vitest runs with `environment: "node"` and `include: ["src/**/*.test.ts"]`. `package.json` has `fake-indexeddb` and `fast-check` but no jsdom, happy-dom or Testing Library, and there are no `*.test.tsx` files. Component render tests are therefore impossible without new tooling; this spec adds none (N5). | `vitest.config.ts`; `package.json`; file search | Verified |
| F22 | Tranche 4 ties role and congregation to ONE access row: `uha.congregation_id = cp.congregation_id and uha.role in ('Elder','Chairperson','Treasurer')`. The trend RPC reuses this pattern. | `20261105130000_tranche4_proof_access.sql` lines 270 and 296 | Verified |
| F23 | `cacheLoader` caches officers with `.in("rank", ["Priest","Underdeacon"])`, so the Dexie officer list is already rank-filtered. `listOfficersWithoutRecentTitheLive` applies the same filter itself. `listOfficersWithoutRecentTithe` (Dexie) returns every active officer when there are zero periods (empty `referenced` set). | `src/utils/cacheLoader.ts` line 58; `officerFaithfulnessLive.ts`; `dashboardRepo.ts` ~line 100 | Verified |
| F24 | `canEnterCapture` admits Elder, Chairperson and Treasurer only. A Secretary cannot open the capture Burial tab. | `tech_old.md` (routeGuard); `src/lib/routeGuard.ts` | Verified (steering); code line not re-read |

## 3. Key decisions

### 3.1 New table, not `congregation_settings` (decided by the user, confirmed)

F7 shows the settings UPDATE policy lets any active Elder, Chairperson or HO change any congregation's row. A notice also
needs several rows per district (scope, dates, history). A dedicated table `burial_notice` with no client write grant is the
only option that satisfies HO-only, district-segregated writes.

### 3.2 Write path: Edge Function gate, SQL function does the work

Options considered:

- **A. Edge Function does table writes with the service-role client** (the pattern used by `buildWrite`). Simple, but the
  Replace operation (retire old + insert new) is two statements over HTTP and is not atomic, and the district rule would
  live only in TypeScript.
- **B. Edge Function gate, then one `service_role`-only SQL function** that validates, detects conflicts and writes in one
  transaction. Atomic, testable with SQL tests on a disposable stack, and a second, independent check of the caller.

**Chosen: B.** The Edge Function reproduces the checklist gate exactly (steps 1-4), validates the body shape (step 5),
and calls `supabaseAdmin.rpc("burial_notice_publish", {...})` (step 6). The SQL function owns the invariants that matter:
HO in-window access, district assignment, scope shape, overlap detection, atomic replace. This also covers the F8 gaps for
the new actions without editing the shared gate (steering: do not "fix" recorded logic in unrelated work).

### 3.3 Conflict is a normal outcome, returned as HTTP 200

F9: a non-2xx response gives the client only a generic error. The overwrite prompt needs the list of conflicting notices,
so the server returns `200 { conflict: true, conflicts: [...] }` and writes nothing. The client resends with
`replace: "retire_conflicts"` or `replace: "keep_both"`. Validation, auth and config failures keep their 400, 401, 403 and
500 codes.

### 3.4 Scope resolution: client side from cached ids, specificity is an open decision

A congregation row already carries `district_id`, `apostleship_id`, `overseership_id` (F12). The client selects notices
where `(scope_level, scope_id)` matches one of those three ids. No server round trip, works offline.

What to show when several notices are active at different scope levels is **Open Decision O1**. Options:

- **(a) Most specific only.** Overseership beats Apostleship beats District; show one. Simple, but a district-wide AGM
  notice disappears for any congregation whose apostleship has its own message.
- **(b) Broadest only.** Rarely what an HO wants; a local message would never show.
- **(c) Show all applicable, most specific first, capped.** Nothing the DHO published is hidden, at a cost of more screen
  space on the Burial landing. Cap at 3 (`MAX_NOTICES_SHOWN`).

**Recommendation: (c).** The resolver returns an ordered list, so (a) is `slice(0, 1)` and the change is one constant.
Requirement 3.3 states the build default (c, cap 3) until the user answers.

### 3.5 Overwrite semantics: overlap at the same scope

A conflict is a non-retired row at the same `(scope_level, scope_id)` whose `[starts_on, coalesce(expires_on, infinity)]`
overlaps the new range. This lets a DHO schedule next month's message without replacing the current one. Replace retires
rows (`is_active = false`); it never deletes, so history survives.

### 3.6 Burial proof exemption: client predicate split, server filter on `section`

`needsProof` is used for two things (F1): the "missing" rule and the attach control. Split it:

- `proofRequiredFor(line: { section: string; item_type: string }): boolean`, defined once in `src/lib/proofRules.ts` as
  `line.section !== "Burial" && ["EFT","DirectDebit","Expense"].includes(line.item_type)`. Keyed on `section`, so a Burial
  line stays exempt after `markCashBanked` rewrites its `item_type` to `CashBanked` (F3) and a Burial line mis-typed
  `EFT` is still exempt. Used by `missingProofs`, the submit gate and `completeCapture`.
- `proofAttachAllowedFor(line: { section: string; item_type: string }): boolean` = `proofRequiredFor(line)` or
  `line.section === "Burial"`. Used by the attach control, so the Treasurer can still attach a DHO receipt photo
  voluntarily (requirement 7.5, Open Decision O9).

`completeCapture.ts` already receives the section: `ManifestLineInput` and `ReviewEvidenceLine` carry `section`
(review-verified), so no new data is needed, only the signature change (section 6.1).

Server: key on `li.section <> 'Burial'` as well as removing `'Burial'` from the `item_type` list. After `markCashBanked`
the `item_type` is `CashBanked` (F3), so an `item_type`-only filter would be accidentally right today and wrong if the type
list ever grows. The `section` column is stable. Burial **cash** remains covered by the deposit-slip rule (unchanged).

### 3.7 Trend data source: server RPC plus local overlay (push-back on the idea)

The idea is good and cheap enough, with these corrections:

1. **Dexie cannot supply the prior year.** `db.periods` holds only the periods captured or synced on this device
   (`dashboardRepo.periodsFor`). A new device, a cleared cache, or a year-old period never synced here would show zero.
   The comparison needs a server read.
2. **The pre-production backend has almost no history.** The report (s9.1, F18) counts 4 Burial rows live. A real
   comparison will be empty. The demo needs synthetic prior-year data (section 9), and that data conflicts with the user's
   wish not to demo on seed data. Resolution: the seed is separate, clearly labelled synthetic, authored only, and its
   target is Open Decision O8.
3. **"Single capture per period" is practice, not a rule.** The Burial tab accepts many receipt lines per period (report
   s9.1). The trend sums them, so it is correct either way. Do not build around one line.
4. **Month key.** "Calendar month" could mean the line's `transaction_date` (the date the treasurer typed, pinned to today)
   or the period's OAC month. Use the period's OAC month (A4): the book is kept by period, `transaction_date` is the
   capture date and not the date the member paid, and late catch-up capture would shift months. Open Decision O4.
5. **Burial may be retired.** Keep the investment small: one RPC, one pure merge, one shared chart (about 150 lines),
   hidden entirely when 24 months are zero.

Why a `SECURITY DEFINER` RPC and not a view or a client query: F19 says the line-item SELECT policy was not read. A
`SECURITY INVOKER` view would silently depend on it, and a policy that returns nothing would show zero without an error.
The RPC takes a congregation id, checks the caller's role and congregation on one `user_hierarchy_access` row itself
(F22), and returns aggregate numbers only.
This is the same pattern Tranche 4 used for proof access.

### 3.8 Chart library: hand-written SVG (Open Decision O7)

| Option | Cost | Verdict |
|---|---|---|
| Add `recharts` or similar | New dependency, larger precache for a PWA, many transitive packages, styling to match Tailwind. Size not measured. | Reject for a feature that may be removed |
| Add a tiny lib (e.g. `chart.js`) | Still a dependency; canvas, no accessible text | Reject |
| Hand-written SVG `BarChart` | About 150 lines, no dependency, accessible table fallback, themed with Tailwind classes | **Choose** |

Component: `src/components/charts/BarChart.tsx`, with the pure scale and layout helper `src/components/charts/chartMath.ts`.
Props: `categories: string[]`, `series: {name; values: number[]; className: string}[]`, `mode: "grouped" | "stacked"`,
`valueFormat?: (n:number)=>string`, `ariaLabel: string`, `height?: number`. It draws bars, a y axis with 3 ticks, month
labels, a legend, and a visually hidden `<table>` of the values. Burial uses `grouped`; Faithfulness uses `stacked`.

### 3.9 Offline behaviour of the trend (Open Decision O11)

Show the last successful server result, labelled "as of <date>". Hiding it offline would remove the comparison exactly
where Treasurers work. The cached result is stored in `syncMeta` as a JSON string under the key
`burialTrend:<congregationId>` (`SyncMeta.value`, F13 context in `schema.ts`: `value?: string | null`), so it needs no Dexie
version. If no cache exists, local current-year months only, with the "Prior year needs a connection" note.

### 3.10 Secretary and the trend (decided: no Secretary surface)

The trend returns monthly totals only and renders only inside `CashbookForm` on the Burial tab. A Secretary cannot enter
capture (F24), so a `T` row for Secretary would describe a surface that does not exist. Options: (a) drop Secretary from
the matrix row and the RPC; (b) add a totals block to `SecretaryReview.tsx`. **Chosen: (a).** The Secretary request
("totals only, no line detail") is met trivially because the Secretary never sees Burial detail through this feature.
The matrix row `burial.trend_view` is Chairperson V, Treasurer V, every other role `-` (Elder included, see 4.3). The RPC
checks the same two roles (requirement 8.3). If the user wants a Secretary Burial figure, it is a separate task (O13 option b).

## 4. Data model

### 4.1 Server: `burial_notice` (migration `20261124110000_burial_notice.sql`, AUTHORED, NOT APPLIED)

The migration file is the authoritative text. The snippet below is a summary; where they differ, the file wins (the file also
carries the stricter message CHECKs described in the Notes).

```sql
create table public.burial_notice (
  id           uuid primary key default gen_random_uuid(),
  scope_level  text not null check (scope_level in ('District','Apostleship','Overseership')),
  scope_id     uuid not null references public.hierarchy_levels(id),
  district_id  uuid not null references public.hierarchy_levels(id),  -- denormalised for RLS and HO checks
  message      text not null,   -- two CHECKs in the file: trimmed length 1-1000 and no control characters (see Notes)
  starts_on    date not null,
  expires_on   date,                                                   -- null = no expiry (Open Decision O2)
  is_active    boolean not null default true,
  retired_at   timestamptz,
  retired_by   uuid references auth.users(id),
  replaced_by  uuid references public.burial_notice(id),
  created_by   uuid not null references auth.users(id),
  updated_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint burial_notice_dates_ck check (expires_on is null or expires_on >= starts_on),
  constraint burial_notice_retired_ck check ((is_active and retired_at is null) or (not is_active and retired_at is not null))
);
create index burial_notice_scope_idx on public.burial_notice (scope_level, scope_id) where is_active;
create index burial_notice_district_idx on public.burial_notice (district_id) where is_active;
```

Notes:

- `level_type` casing in `hierarchy_levels` is [UNVERIFIED] (F11). The publish function compares
  `lower(hl.level_type) = lower(p_scope_level)`. Reconcile on the stack.
- **Message rules live in SQL too (review finding 4).** In Postgres `btrim(text)` trims spaces only, so a message of `E'\n'` or `E'\t'`
  would pass a plain `btrim` check. The file therefore uses the explicit trim set `btrim(message, E' \t\r\n')` in both the table CHECK
  (`char_length(...) between 1 and 1000`) and the publish function, plus a second CHECK `message !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'`
  (control characters other than tab, CR and LF; NUL cannot occur in `text`). The function stores the trimmed string, and the Edge
  function forwards the string it trimmed with the same set. The regex literal and the `\x` escapes are [UNVERIFIED] until T19.
- `district_id` is derived inside the publish function from the parent chain, never taken from the client.
- The "retire" columns keep history without an `audit_log` dependency. `audit_log` action names are an enumerated set in
  `types.ts`; adding one is a separate change (backlog B2).

RLS and grants:

```sql
alter table public.burial_notice enable row level security;
revoke all on public.burial_notice from anon, authenticated;
grant select on public.burial_notice to authenticated;

create policy burial_notice_select_district on public.burial_notice
  for select to authenticated
  using (
    is_active
    and (
      district_id in (select c.district_id from public.congregations c
                       where c.id in (select public.get_my_hierarchy_ids()))
      or district_id in (select hda.district_id from public.ho_district_assignments hda
                          where hda.user_id = (select auth.uid()))
    )
  );
```

No INSERT/UPDATE/DELETE grant or policy exists, so the browser cannot write (requirement 6.1). `service_role` bypasses RLS.
`get_my_hierarchy_ids()` is verified to return congregation ids: existing migrations compare it with
`cashbook_period.congregation_id` and `cashbook_attachment.congregation_id`
(`20261105110000_signoff_foundation.sql` lines 235, 304, 315; `20261105130000_tranche4_proof_access.sql` line 283), so the
Treasurer's read of notices through the `congregations` join works on that basis. The remaining unknown is only whether it
covers every role (Overseer and Apostle see-all, `tech_old.md`); those roles do not use the Burial tab, so a gap there makes
the policy narrower than expected, never wider. Confirm on the stack (integration case 7). If the user
prefers the simpler "readable by every authenticated user" (as `congregations` and `officers` are), replace the `using`
clause with `is_active`. That is Open Decision O3. Recommendation: keep the district scope, because a notice may carry
payment instructions.

### 4.2 Server: `burial_notice_publish` and `burial_notice_retire` (same migration, AUTHORED, NOT APPLIED)

**Status of the SQL (review finding 3).** The three migration files now exist in `supabase/migrations/`, each with a NOT APPLIED
header: `20261124110000_burial_notice.sql`, `20261124120000_burial_proof_exempt.sql` (full function body),
`20261124130000_burial_monthly_totals.sql`. They have never been parsed by Postgres ([UNVERIFIED] until T19 on a disposable
stack). Tasks T4, T11 and T13 now review and test them; they no longer author them.

The authoritative SQL for both functions is `supabase/migrations/20261124110000_burial_notice.sql` (authored, NOT APPLIED, never parsed
by Postgres, [UNVERIFIED] until T19). It is not repeated here so the document and the file cannot drift; the behaviour contract follows.
Both functions are `plpgsql security definer set search_path to ''`, executable by `service_role` only (`revoke ... from public, anon,
authenticated`).

Defined behaviours the review asked for: retiring an already-retired id returns `{conflict:false,id,already_retired:true}`
with no write and no error (idempotent, so a double click or a retry is harmless); an edit with `replace = 'keep_both'`
updates the edited row in place and leaves every overlapping notice active and untouched; an edit with
`retire_conflicts` updates the edited row and retires only the other overlapping rows. Unverified column types:
`user_hierarchy_access.start_date/end_date` (compared with `now()`) and `hierarchy_levels.level_type` casing (compared
with `lower()`); confirm on the stack.

Behaviour in order (each failure raises, which rolls back everything):

1. **Actor.** `p_actor` not null; an active (`status = 'active'`), in-window (`start_date <= now()` and
   `end_date is null or end_date >= now()`) `user_hierarchy_access` row with `role = 'HO'`, `scope_level = 'District'`
   exists. Else `errcode 42501` ("forbidden").
2. **Validation.** `p_replace in ('none','retire_conflicts','keep_both')`; message trimmed with `btrim(msg, E' \t\r\n')`, then
   length 1-1000 and no control character matching `[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]` (so `E'\n'`, `E'\t'`, `E'\r\n'` and
   `E'a\x01b'` all raise `22023`); `p_starts_on` not
   null; `p_expires_on` null or `>= p_starts_on`. On **create** (`p_id` null) additionally `p_expires_on` null or
   `>= current_date - 1` (the server date is UTC and the display date is the device's; a deliberate one-day leniency so
   the two can never reject a notice that expires "today" on the device; the client form applies the strict device-date
   check, requirement 1.3). On **edit** (`p_id` not null) there is no today rule: `starts_on` may move either way and
   `expires_on` before today is allowed (it ends the notice). Else `errcode 22023` ("validation: ...").
3. **Scope shape.** Resolve `p_scope_id` in `hierarchy_levels` with matching level. Derive the district by the fixed parent
   chain (Apostleship parent = District; Overseership parent = Apostleship parent = District). A missing node, a wrong
   level, or any break in the chain raises `22023` (HTTP 400, requirement 1.4a). This restates steering invariant 8
   (hierarchy shape is fixed).
4. **District authority.** The derived district must have BOTH a `ho_district_assignments(p_actor, district)` row and an
   active in-window HO District access row with `hierarchy_id = district` (the Tranche 4 rule, F10). Else `42501`
   (HTTP 403, requirement 1.4b). Because step 3 runs first, a nonexistent node always yields 400, never 403.
4b. **Concurrency (review finding 9).** After step 4 the function takes `pg_advisory_xact_lock(hashtext('burial_notice:' ||
   scope_level || ':' || scope_id))`, held to the end of the transaction. Two HO users publishing at one scope at the same moment
   are serialised, so the second sees the first's committed row in the step 6 conflict query and gets the prompt. A hash collision
   between two different scopes only causes harmless extra waiting. Integration case 6b covers it.
5. **Edit.** If `p_id` is not null: the row exists, is active, belongs to the same derived district (else `42501`), and
   scope is not being changed (scope args must equal the stored scope, else `22023`).
6. **Conflicts.** Select active rows at the same `(scope_level, scope_id)` (excluding `p_id`) whose range overlaps. On
   create the check always runs. On edit it runs only when `p_starts_on` or `p_expires_on` differs from the stored values
   (a text-only edit never reports conflicts). If any conflict and `p_replace = 'none'`, return
   `{"conflict": true, "conflicts": [{id, message, starts_on, expires_on}...]}` and write nothing. A new `expires_on` before
   today normally removes the overlap with current ranges; it can still overlap an older notice's past dates, in which
   case the prompt appears and the DHO can choose Keep both.
7. **Write.** (On edit, `retire_conflicts` retires the other conflicting rows and updates the edited row in place.)
   `retire_conflicts`: set conflicts `is_active=false, retired_at=now(), retired_by=p_actor, replaced_by=<new id>`.
   Insert (or update when `p_id` is set, setting `updated_by`, `updated_at`). Return `{"conflict": false, "id": <id>}`.

`burial_notice_retire(p_actor uuid, p_id uuid)` repeats steps 1 and 4 for the row's `district_id`, then retires the row
(an unknown id raises 22023, an already-retired id is a no-op success). Same grants.

### 4.3 Server: `burial_monthly_totals` (migration `20261124130000_burial_monthly_totals.sql`, AUTHORED, NOT APPLIED)

The authoritative SQL is `supabase/migrations/20261124130000_burial_monthly_totals.sql` (authored, NOT APPLIED, never parsed by Postgres,
[UNVERIFIED] until T19). It is not repeated here, so the document and the file cannot drift. Shape: a `plpgsql stable security definer`
function `burial_monthly_totals(p_congregation_id uuid, p_end_year int, p_end_month int)` returning `(year, month, total, period_ids)`.
Order inside the function:

1. **Argument validation returns no rows (decided, review finding 5).** `p_congregation_id` null, `p_end_year` or `p_end_month` null,
   `p_end_month` outside 1-12, or `p_end_year` outside 2000-2100 makes the function `return` an empty set before any date arithmetic, so
   `make_date(2026, 13, 1)` (which would raise `22008`) is never reached. No error is raised; the client treats an empty result as
   "hide the chart" (integration case 8d). It is `plpgsql` rather than `sql` precisely so the early `return` guarantees evaluation order.
2. **Role gate.** An active, in-window `user_hierarchy_access` row with `congregation_id = p_congregation_id` and `role in
   ('Treasurer','Chairperson')` on the SAME row (F22). No `get_my_hierarchy_ids()` dependency. Otherwise return no rows.
3. **Window.** 24 contiguous months: `generate_series` from `make_date(end) - 23 months` to `make_date(end)` step 1 month, both ends cast to
   `timestamp` so one overload resolves. The prior-year window is the 12 months before the current window, so one range covers both.
4. **Aggregate.** `cashbook_period` joined to `cashbook_line_item` on `section = 'Burial'`, `status not in ('Draft','Rejected')`, grouped by
   year and month: `total = sum(amount)`, `period_ids = array_agg(distinct cp.id)`. Status compared as string literals, with no `coalesce`
   over the enum (the guard-enum bug in `PROJECT-LOG.md`).

Grants: `revoke all ... from public, anon`; `grant execute ... to authenticated`.

- Aggregates plus `period_ids`. The ids are the caller's own congregation's period uuids, carry no amounts or receipts, and
  let the client decide which local periods the server already counted (section 7.1, finding 8). Months with no rows are
  absent; the client fills zeros.
- The window is 24 contiguous months (this year window and the prior-year window are one contiguous range, because the
  prior-year window is the 12 months before it).
- The `status not in (...)` comparison uses string literals against the enum column, with no `coalesce` over the enum (the
  guard-enum bug recorded in `PROJECT-LOG.md`).
- `year` and `month` are reserved-ish names; if the stack complains, alias them (`yr`, `mo`) and adjust the client mapper.
- Secretary is not in the role list (section 3.10). An Auditor, or a Treasurer of another congregation, gets no rows even
  if `get_my_hierarchy_ids()` would show them the congregation: integration case 8b.
- **Elder (decided, review finding 2, option a).** An Elder does enter capture (`capture.create` is `O`,
  `src/lib/permissions.ts` line 28, so `canEnterCapture` is true) but typically holds no congregation-scoped
  `user_hierarchy_access` row (the Elder portal reads congregations live). A trend that is silently empty is worse than
  none, so Elder is removed from the RPC role list and from `burial.trend_view`. Behaviour for an Elder on the capture
  Burial tab: the notice area works from the Elder's own cache (whatever `refreshReferenceCache` could read under RLS, else
  the Default notice, requirement 3.8); `BurialTrend` renders nothing and calls nothing (requirement 8.8b). Covered by
  unit test (matrix row, component gate through `hasPermission`) and integration cases 7b and 8c.
- `uha.start_date`/`end_date` column types and `congregation_id` presence on every row are [UNVERIFIED]; F22 shows the
  `congregation_id` column in use. Confirm on the stack.
- In a `plpgsql` function `RETURNS TABLE (year, month, ...)` the output names are variables. The file qualifies every column
  reference (`cp.year`, `win.y`) so they should not clash; confirm on the stack, else alias to `yr`, `mo`.

### 4.4 Client: Dexie `burialNotices` (`src/db/schema.ts`, additive version)

```ts
export interface BurialNoticeRow {
  id: string;
  scope_level: "District" | "Apostleship" | "Overseership";
  scope_id: string;
  district_id: string;
  message: string;
  starts_on: string;           // YYYY-MM-DD
  expires_on: string | null;   // YYYY-MM-DD
}
// Dexie: burialNotices!: Table<BurialNoticeRow, string>;
this.version(6).stores({ burialNotices: "id, district_id, scope_id" });   // 6 = next free version at implementation time, see below
```

**Spec 2 takes the next free Dexie version at implementation time.** Spec 1 plans `version(5)` for `lineProofs` (F13).
If Spec 1 has landed, this spec uses `version(6)`; if not, it uses `version(5)` and Spec 1 takes the next free number (Spec
1 T8 states the same rule). The Dexie task reads `schema.ts` first, finds the highest `this.version(n)` (4 at the time of
writing), and uses `n + 1`; versions must be strictly increasing and additive. Snippets in this spec that show
`version(6)` are illustrative. The `schema.ts` header comment lists stores; update it. The
version is additive: no `.upgrade()`, no existing store re-declared. `cacheLoader` replaces the store with
`clear()` then `bulkPut()` only when its own query succeeded, matching the other stores.

### 4.5 Client types and constants

All decision logic sits in pure modules (no React, Dexie or Supabase) because components cannot be render-tested (F21).
Components only map a view model to markup.

- `src/lib/burialNotice.ts`: `resolveNotices(rows, ids, todayISO, max)`, `isActiveOn(row, todayISO)`,
  `scopeRank(level)`, `MAX_NOTICES_SHOWN = 3`, `BURIAL_DEFAULT_DETAILS`, `buildDefaultNotice(details)`, and the view model
  `noticeView(rows, ids, todayISO, max) -> { kind: "notices" | "default"; items: { id; scopeLabel; message; untilLabel }[] }`.
  Messages are passed through unchanged as strings; the component renders them as React text nodes.
- `src/ho/burialNoticeForm.ts`: `validateNoticeForm(values, todayISO) -> { ok } | { ok:false, errors }` (same rules as
  section 10), `conflictPanelState(response) -> { kind: "saved" | "conflict" | "error"; ... }`,
  `visibleNotices(rows, todayISO, showExpired)` (requirement 1.9).
- `src/lib/burialTrend.ts`: `trendWindow(endYear, endMonth)`, `mergeTrend(server, localPeriods, itemsByPeriod, window)`,
  `trendViewModel(result) -> { label; note; allZero; categories; series }`.
- `src/lib/faithfulness.ts`: `windowPeriods(periods, n)`, `buildFaithfulness(officers, periodRefs)`,
  `faithfulnessViewModel(history) -> { rows (sorted, with badge kind "none-in-window" | "no-periods" | null); chart }`.

### 4.6 Synthetic default values (A3)

```ts
export const BURIAL_DEFAULT_DETAILS = {
  bankName: "Demo Bank (synthetic)",
  accountNumber: "9999 0000 111",        // fabricated; not a real account
  contactName: "Sister JV Van Der Venter",
  contactPhone: "011 293 4567",          // fabricated
} as const;
```

Default text: "Burial contributions can be paid electronically to {bankName}, account {accountNumber}. Use your membership number as
the payment reference and wait for your receipt from the DHO. For enquiries, contact {contactName} on {contactPhone}."
Before launch these values must be replaced or the default reworded without an account (Open Decision O6, launch
checklist item in section 14).

## 5. Burial notice flows

### 5.1 HO screen: `src/ho/BurialNoticesScreen.tsx`

- Route `/ho/burial-notices` added in `src/App.tsx` inside the `/ho` layout block (after line 179), nav entry
  "Burial Notices" in `src/ho/HOAdminLayout.tsx` `NAV` (lines 14-19). Shown only when
  `hasPermission(role, "burial.notice_manage")`. The `/ho` area is already guarded by `canEnterAdmin`.
- Offline: render the same explicit "unavailable offline" block the other HO screens use and do not request data
  (requirement 1.9).
- List: reads `burial_notice` through the client (RLS gives the HO their district's active rows) joined in memory with
  `hierarchy_levels` names. Rows are never retired automatically when `expires_on` passes, so the list passes through
  `visibleNotices(rows, todayISO, showExpired)` (pure, `src/ho/burialNoticeForm.ts`): by default it hides rows with
  `expires_on < today`; a "Show expired" checkbox lists them badged "Expired". Current and future rows, newest first.
- Form fields (plain controls styled like the existing HO screens; no dialog component exists, F15, so the confirm step
  is an inline panel, the same approach the delete dialog in `CashbookForm.tsx` takes):
  scope level select (District, Apostleship, Overseership), scope node select (filtered to the HO's assigned districts
  using `getHODistrictIds`, plus parent chain), message `<textarea maxLength=1000>` with a counter, start date, expiry date
  (required or optional per O2).
- Submit calls `adminApi.publishBurialNotice({ id?, scope_level, scope_id, message, starts_on, expires_on, replace: "none" })`.
  If the result is `{conflict:true}`, show the conflict panel (requirement 2.2). Replace resends with
  `replace: "retire_conflicts"`, Keep both with `"keep_both"`, Cancel discards.
- Retire button calls `adminApi.retireBurialNotice({ id })` after a confirm.
- Errors: `ok:false` shows the message inline with `role="alert"` (project pattern). 403 shows "You can only publish for your
  own district".

### 5.2 `adminApi` additions (`src/ho/adminApi.ts`)

```ts
publishBurialNotice: (p: BurialNoticeInput) => invoke<{ conflict: boolean; id?: string; conflicts?: ConflictRow[] }>("publish_burial_notice", p),
retireBurialNotice: (p: { id: string }) => invoke("retire_burial_notice", p),
```

`invoke` is unchanged. A conflict is a 200 body without `error`, so it returns `{ ok: true, data }`.

### 5.3 Edge Function (`supabase/functions/admin-write/index.ts`)

Gate steps 1-4 unchanged. After the gate (and after the JSON parse), before `buildWrite` (`mapBurialNoticeError` and
`validateBurialNoticeRequest` are imported from `./burialNotice.ts`):

```ts
if (payload?.action === "publish_burial_notice" || payload?.action === "retire_burial_notice") {
  const v = validateBurialNoticeRequest(payload);          // pure module, no Deno imports
  if ("error" in v) return json({ error: v.error }, 400);
  const { data, error } = await supabaseAdmin.rpc(v.fn, { p_actor: userData.user.id, ...v.args });
  if (error) {
    console.error("burial_notice rpc failed", v.fn, error.code, error.message);   // detail stays in the Edge runtime log
    const m = mapBurialNoticeError(error.code);                                   // fixed text per SQLSTATE
    return json({ error: m.message }, m.status);
  }
  return json(data ?? { success: true });
}
```

`mapBurialNoticeError(code)` is part of the same self-contained module: `42501` returns `403 "Forbidden"`; `22023` returns
`400 "Invalid notice request"`; any other code returns `400 "Could not save the notice"`. The raw `error.message` is never
returned to the client (it may name tables, columns or constraint text).

**Validator location (decided).** `validateBurialNoticeRequest` and `mapBurialNoticeError` are written self-contained (no
imports of any kind) in `supabase/functions/admin-write/burialNotice.ts`, which `index.ts` imports with a same-folder
relative path (a form the Supabase CLI bundler handles). An identical copy lives at `src/lib/burialNoticeRequest.ts` and is
used by the HO form and by vitest (vitest's `include` is `src/**/*.test.ts`, F21, and cannot reach `supabase/functions`).
A node test `src/lib/burialNoticeRequest.copy.test.ts` reads both files with `fs.readFileSync` and asserts they are
byte-identical, so the copies cannot drift. No cross-folder import into the function is attempted, and there is no
fallback branch.

`validateBurialNoticeRequest` checks: `scope_level` in the
three values; `scope_id` and `id` are UUID strings; `message` string, trimmed 1-1000; `starts_on` and `expires_on` match
`^\d{4}-\d{2}-\d{2}$` and are real dates; `replace` in the three values (default `none`); unknown keys ignored. The
service-role key never leaves the function. The caller's id comes from `auth.getUser`, never from the body.

Existing defects recorded, not fixed (F8): no date-window check and an unordered `limit(1)` HO lookup in the shared gate.
The SQL function's step 1 and step 4 cover the new actions. Raise a bugfix spec for the shared gate (backlog B1).

Deployment: the Edge Function must be redeployed for the actions to exist. Deploy status of the current function on the
dev/demo project is [UNVERIFIED] (`tech_old.md` says "not deployed"). Deploying needs explicit user authorisation.

### 5.4 Display: `src/components/BurialNotice.tsx`

- Rendered inside `CashbookForm` between the tab row (closing `</div>` at line 698) and the capture bar (`{canEdit &&
  activeTab !== "Banking" ...` at line 701): `{activeTab === "Burial" && <BurialNotice congregationId={...} />}`
  (requirement 3.1). It is rendered whether or not `canEdit`.
- Inputs: the congregation's `{district_id, apostleship_id, overseership_id}` read from `db.congregations` by
  `period.congregationId`, and `db.burialNotices`. Uses `useEffect` + local state like the rest of the form.
- On mount, when online, call `refreshBurialNotices()` (cacheLoader export; one query, replaces the store only on
  success), then re-read (requirement 5.3).
- `resolveNotices(rows, ids, todayISO, MAX_NOTICES_SHOWN)`: keep rows whose `(scope_level, scope_id)` matches `ids`, that
  are active on `todayISO`, sort by `scopeRank` descending (Overseership 3, Apostleship 2, District 1), then by `starts_on`
  descending, then `id`; take `max`. `todayISO` is `localTodayISO()` from the existing helper (device local date; a date
  string, so no time zone arithmetic).
- The component calls `noticeView(rows, ids, todayISO, MAX_NOTICES_SHOWN)` and only maps `{kind, items}` to markup. An
  empty result (`kind: "default"`) renders the Default notice (requirement 4).
- Markup: a bordered `div` with `role="note"`, an `aria-label` of "Burial notice", a small scope label and the message in a
  `<p className="whitespace-pre-line">{row.message}</p>` text node. No `dangerouslySetInnerHTML` anywhere.

### 5.5 `cacheLoader` changes (`src/utils/cacheLoader.ts`)

- Add a fifth query to the `Promise.allSettled` array: `supabase.from("burial_notice").select("id, scope_level, scope_id,
  district_id, message, starts_on, expires_on")`. Add `"burial_notice"` to `tables`, `burialNotices` to `RefreshResult`
  and the Dexie transaction. Replace only if the query succeeded (existing pattern).
- A missing table (PostgREST error before the migration is applied) is logged by the existing `warnQueryFailed`, which does
  not abort the other stores. The result `ok` flag becomes false until the table exists; `LoginPage` ignores the result
  (F12). A task confirms nothing else treats `ok:false` as fatal.
- **Staleness bound (requirement 5.5).** A notice retired or corrected on the server stays in the offline cache until the next
  successful `refreshReferenceCache` (online login) or `refreshBurialNotices` (Burial tab mount while online), then the store is
  replaced wholesale, so retired rows vanish. There is no timer. Because a notice can carry payment instructions, the HO screen
  shows a hint after a text edit: "Devices pick up the change at their next online login or Burial tab visit." Expiry is
  independent of this window (client date filter).
- Export `refreshBurialNotices()` for the Burial tab mount refresh. It is the same query alone and must never throw.

## 6. Burial proof exemption

### 6.1 Client

Current call sites (verified in the working tree at the time of this revision):

| File | Line | Today | Change |
|---|---|---|---|
| `src/components/CashbookForm.tsx` | 45 | `needsProof = (i) => ["EFT","DirectDebit","Burial","Expense"].includes(i.item_type)` | delete; import `proofRequiredFor`, `proofAttachAllowedFor` from `@/lib/proofRules`. `LocalLineItem` has `section` and `item_type`, so it satisfies the line type |
| `src/components/CashbookForm.tsx` | 211 | `missingProofs = proofMandatory ? items.filter((i) => needsProof(i) && !hasProofLocally(i))` | `proofRequiredFor(i)` |
| `src/components/CashbookForm.tsx` | 438 and 849 | `{needsProof(item) && ...` attach control | `proofAttachAllowedFor(item)`. A Burial row shows an optional "Attach" with no red "missing" state |
| `src/lib/completeCapture.ts` | 25-29 | `PROOF_REQUIRED_TYPES` (includes `"Burial"`) and `proofRequiredFor(itemType: string)` | remove the list and re-export `proofRequiredFor` from `proofRules.ts` (or keep the name, new signature `(line)`); no caller keeps the string signature |
| `src/lib/completeCapture.ts` | 86 | `proofRequiredFor(line.item_type)` | `proofRequiredFor(line)` (the manifest line input carries `section`) |
| `src/lib/completeCapture.ts` | 239 | `.filter((l) => proofRequiredFor(l.item_type) && !attached.has(l.id))` | `proofRequiredFor(l)` (the review evidence line carries `section`) |

Spec 1 edits the same lines (it forces Expense proof regardless of `proof_mandatory`); implement Spec 1 first and re-read the
lines before editing, because the line numbers above will have moved by then.

Required unit tests (`src/lib/proofRules.test.ts` plus the updated `completeCapture` tests): `{section:"Burial",
item_type:"EFT"}` is NOT proof-required; `{section:"Burial", item_type:"CashBanked"}` is NOT; `{section:"Burial",
item_type:"Burial"}` is NOT; `{section:"Members", item_type:"EFT"}` IS; `DirectDebit` and `Expense` lines outside Burial
ARE; `proofAttachAllowedFor` is true for every Burial line. The existing `completeCapture` tests that assert Burial is
proof-required are updated and named in task T12.
- Coordination with Spec 1: Spec 1 forces Expense proof regardless of `proof_mandatory` in the same two places (its design
  s7.4). Implement Spec 1 first; this change is then a one-element removal plus the split. If the order reverses, rebase on
  Spec 1's version of those lines.

### 6.2 Server (migration `20261124120000_burial_proof_exempt.sql`, AUTHORED, NOT APPLIED)

`CREATE OR REPLACE FUNCTION public.cashbook_review_ready(uuid, int)` with the **same signature, same security settings
(`security definer`, `set search_path to ''`, `stable`) and the same grants** as Spec 1's section 8. The migration file holds the
**full function body** (generated by copying lines 360-480 of `20261124100000_expense_payment_source.sql` and applying the two edits
below by script, so the copy is verbatim apart from them).

**Decision (review finding 2): the exemption applies to BOTH branches.** Spec 1's function lists `'Burial'` in two places, and both
are edited identically:

1. the `balance_rule = 1` legacy branch (manifests frozen before Spec 1, `proof_mandatory = true` block), and
2. the rule-2 path's `proof_mandatory = true` block.

Each becomes:

```sql
      -- Burial exempt (Spec 2): key on section, never item_type (markCashBanked rewrites item_type)
      and li.section is distinct from 'Burial'
      and li.item_type in ('EFT','DirectDebit','Expense')
```

(was `and li.item_type in ('EFT','DirectDebit','Burial','Expense')`). Why both: the exemption only relaxes a check, requirement 7.2
is stated without a manifest-rule qualifier, and Spec 1's `ADD COLUMN` gives every existing manifest row `balance_rule = 1`, so any already-frozen period under `proof_mandatory = true` would otherwise still demand Burial proof (the user's stated wish is "should not apply to Burial"). The review noted that 0 manifests exist today; that count is [UNVERIFIED] by this spec. `IS DISTINCT FROM` instead of `<>` keeps a NULL `section` on the
old behaviour (still checked) rather than silently skipping it. The legacy branch is otherwise still a verbatim copy of the
20261105140000 tail, with this single deliberate relaxation. **Cross-spec follow-up for Spec 1 (not edited here):** Spec 1 R3.11
and its "verbatim legacy" wording should read "verbatim, except the Burial exemption of Spec 2". Both specs must be approved together.

Everything else is unchanged: stale-revision check, manifest balanced, live balance check, forced Expense proof,
deposit-slip amount check, `proof_mandatory = false` short circuit, and the deposit-slip-required rule.

Hazards:

- **Two files replace one function; the later one wins.** The new file is a verbatim copy of Spec 1's function plus exactly two
  identical edits. Task T13 diffs the two bodies with a script and fails unless the diff shows exactly two changed hunks, both the
  same edit. The file sorts after Spec 1's (`20261124100000`). If Spec 1's migration is not applied, this file must not be applied
  either (the base body would be `20261105140000` line 131 and would lose Spec 1's changes). The header states this.
- **Burial cash is unchanged.** A Burial cash line still needs the deposit slip. Only the per-line attachment is waived.
- **`CashBanked` Burial lines.** After banking, `item_type = 'CashBanked'`, which was never in the list, and `section` stays
  `'Burial'`. Both forms of the filter agree.
- **Why not `burial_proof_mandatory`.** The user's stated wish is "should not apply to Burial". A second setting adds a
  column, Dexie type, cacheLoader and UI for a function that may be retired. Rejected; revisit if a DHO ever needs Burial
  proof.

The `markCashBanked` quirk is not fixed here (it flips `item_type`; the tab then hides banked Burial lines). It is recorded
in section 15.

## 7. Burial trend

### 7.1 Window and merge (pure, `src/lib/burialTrend.ts`)

- `trendWindow(endYear, endMonth)` returns `{ current: {year, month}[12], prior: {year, month}[12] }` where `prior[i]` is
  `current[i]` with `year - 1`. The end month is the current OAC month from `getCurrentOacWeek()` (`src/lib/oacWeeks.ts`).
- Server rows are `{year, month, total, period_ids}`. `mergeTrend(serverRows, localPeriods, localItemsByPeriod, window)`:
  1. build `counted = union of period_ids` over all server rows, and a map keyed `year-month` holding the server totals;
  2. for each local period in the 24-month range whose `serverId` is null OR not in `counted`, add the sum of its items with
     `section === "Burial"` to its month (requirement 8.4);
  3. fill missing months with 0.
- **Why the rule keys on `period_ids` and not on local `status` (finding 8, F25).** Dexie never refreshes a period's
  `status` from the server: `syncEngine.ts` writes only `serverId` and `localStatus` flags, and `status` changes only through
  local capture actions. A local period shown as `Submitted` and `synced` could therefore have been Rejected by the
  auditor on the server, where the RPC excludes it. A rule "skip local when synced and past Draft" would then drop it from
  both sources. Keying on the server's own list of counted period ids removes the dependence: if the server counted the
  period it is skipped locally (no double count), otherwise it is counted locally (no drop). This also closes the earlier
  gap of a period synced after the cached result was taken: it is not in the cached `period_ids`, so it is counted locally.
- Accepted limits: (a) a counted period edited locally but not yet re-synced shows the server's total until it syncs;
  (b) an offline cached result can list a period that the server later rejects, and the chart shows it until the next
  refresh (the "as of" label covers this); (c) a period captured on another device and synced is in the server result only,
  so it appears only after a refresh. A local period with `serverId = null` is by definition not yet on the server.
- Amounts are summed in integer cents (`Math.round(n * 100)`) like `captureTotals.ts`, then divided back, so floating point
  does not drift.

### 7.2 Repository and loader

- `src/db/burialTrendRepo.ts`: `loadBurialTrend(congregationId)` returns `{ series, source: "server" | "cache" | "local",
  asOf: string | null }`. Order: online, call `supabase.rpc("burial_monthly_totals", {...})`; on success store the rows
  (including `period_ids`) in `syncMeta` (`burialTrend:<congregationId>`, JSON `{ asOf, rows }`) and merge with local; on failure or offline read the
  cached rows; with no cache, local only.
- The RPC call has a 8 second timeout via `AbortController`-free `Promise.race` (the repo has no shared helper; unverified
  whether one exists, so the race is written locally). Failure never throws to the UI (requirement 8.7).
- `trendViewModel(result)` (pure, in `src/lib/burialTrend.ts`) returns the label ("as of <date>", "Prior year needs a
  connection" or empty), the inline note for failures, `allZero` and the two series; the component only renders it.
- `src/components/BurialTrend.tsx` renders the heading "Burial received by month", the shared `BarChart`
  (`grouped`, series "This year" and "Prior year"), the source note, and the empty state. Placed directly below
  `BurialNotice` on the Burial tab and above the capture bar, inside the same `activeTab === "Burial"` condition. A
  `hasPermission(role, "burial.trend_view")` check wraps it.
- Local-only layout on a phone: the chart is a fixed 12-category SVG with a `viewBox` and `w-full`, so it scales; month
  labels are single letters under 360 px width (CSS only).

### 7.3 Chart component (`src/components/charts/`)

`chartMath.ts` (pure, tested): `niceMax(values)`, `scaleY(value, max, height)`, `barRects(categories, series, mode, width,
height)`. `BarChart.tsx` maps those to `<rect>` elements with Tailwind classes (`fill-primary`, `fill-muted-foreground/40`,
`fill-green-600`, `fill-red-400`), an axis, a legend and the hidden table. No animation. No dependency.

## 8. Officer Faithfulness upgrade

### 8.1 Data

`src/db/dashboardRepo.ts` gains:

```ts
export interface FaithfulnessHistory {
  periods: { key: string; label: string; tithed: number; notTithed: number }[];  // oldest -> newest
  officers: { id: string; officer_code: string; first_name: string; last_name: string | null;
              rank: string; is_interim: boolean; missed: number; of: number }[];
  windowSize: number;
  capped: boolean;
}
export async function getFaithfulnessHistory(congregationId: string, window: 4 | "all"): Promise<FaithfulnessHistory>;
```

- Periods: `periodsFor(congregationId)` sorted by `byWeekDesc`, take 4 or up to 26 ("all"; `capped` true when more exist).
- For each period: `lineItemsForPeriod`, collect `officer_id` set `R(p)`.
- Officers: the active cached officers (same query as `listOfficersWithoutRecentTithe`).
- Per period: `tithed = |active ∩ R(p)|`, `notTithed = |active| - tithed`. Per officer: `missed = count of periods where
  officer ∉ R(p)`, `of = number of periods`.
- Period label: `oacServiceDateLabel(year, month, week)` plus `AM`/`PM` (existing helper, F16 context).
- Pure core `buildFaithfulness(officers, periodRefs)` in `src/lib/faithfulness.ts` so both the Dexie and the live paths
  share it.
- The card's `listOfficersWithoutRecentTithe` stays and keeps its output. Requirement 9.4 is a test, not a refactor:
  `officers.filter(o => o.missed === o.of)` of the 4-window must equal the card's list. There is no `of > 0` clause: with
  zero periods the card lists every active officer (F23, empty `referenced` set), and the history gives every officer
  `missed = 0, of = 0`, so `missed === of` matches the same set. Presentation: `of = 0` shows "No periods yet", not
  "None in window".

`src/elder/officerFaithfulnessLive.ts` gains `getFaithfulnessHistoryLive(congregationId, window)`: the same periods query
with `.limit(4 | 26)` and selecting `year, month, week, service, id`; one `in("period_id", ids)` lines query selecting
`period_id, officer_id`; an officers query that repeats the card's live filter exactly
(`.eq("is_active", true).in("rank", ["Priest","Underdeacon"])`, F23), so a non-priest officer never counts as missed; then
`buildFaithfulness`. The Dexie path needs no explicit rank clause because the cache is rank-filtered at load (F23). RLS governs both reads (as today). The existing `limit(4)` live query
orders by year, month, week only; AM and PM of one week are then both counted as periods, matching Dexie. The ordering for
equal `week` between AM and PM is not significant for counts.

### 8.2 Page (`src/components/OfficerFaithfulnessPage.tsx`)

- Keep the permission guard, Elder `?cong=` live branch, Back button and states. Add a window toggle (two buttons, local
  state) that reloads.
- Replace the single table with: the stacked `BarChart` (series "Tithed" green, "Not tithed" red), then one table of all
  active officers with columns Code, Name, Rank, Missed ("2 of 4"). `faithfulnessViewModel(history)` (pure) returns the
  rows already sorted by `missed` descending then `officer_code` (requirement 9.7), and each row's badge kind: red
  "None in window" when `missed === of && of > 0`, grey "No periods yet" when `of === 0`, otherwise none. The page maps
  that to markup.
- Caption (requirement 9.8): AM and PM count separately; the current officer list is applied to past periods; an officer
  added later shows earlier periods as missed; and a pre-paid expense recorded against an officer (Spec 1, assumption A3)
  counts as tithed, so an officer who tithed only through such an expense is not shown as missed (review finding 8,
  requirement 9.8). The existing caption is extended, not replaced.
- **Data source and its limit (requirement 9.8a/b, F25, F26).** The Chairperson path reads Dexie periods, which exist only for
  weeks this device captured (`captureRepo.ts` line 95 is the only writer; nothing pulls periods down). On a new device or
  after a cache clear M is small. The page therefore (1) states the source in the caption ("Based on the periods held on this
  device" for the Chairperson, "Based on the latest periods in the database" for the Elder) and (2) shows an inline note
  when `M < windowSize`: "Only M period(s) are held on this device". The Chairperson dashboard does read Supabase live
  (`ChairpersonDashboard.tsx` lines 169, 287), so a live read is feasible; it is not chosen here because requirement 9.4 ties
  the page to the card's data. Offered as Open Decision O16 (recommended: backlog). The note is computed by
  `faithfulnessViewModel` (`partialWindow: boolean`) and tested.
- No new role logic: `canViewOfficerFaithfulness(role)` stays the only gate.

## 9. Synthetic data (specified here, to be authored in T14, never applied by this spec; not authored in this pass, the review did not ask for it)

- `supabase/seed_burial_trend_synthetic.sql` (to be authored in T14, never applied here) generates 24 months of `cashbook_period` rows
  (status `HOReviewed`) with one Burial line each (`section = 'Burial'`, `item_type = 'Burial'`, `receipt_number`
  `SYNTH-YYYY-MM`, amounts from a fixed deterministic series) for **one congregation id passed as a psql variable**
  (`:congregation_id`). It must refuse to run unless the congregation's `code` starts with `SYNTH`.
- `supabase/seed_burial_trend_synthetic_cleanup.sql` deletes that congregation's synthetic periods by
  `receipt_number like 'SYNTH-%'` through the period cascade.
- Why a dedicated `SYNTH` congregation: the user does not want to demo on seed data, and the dev/demo backend holds sensitive
  test data (`environment-context.md`). A labelled synthetic congregation keeps seed data separable and removable. Whether
  to create it on the dev/demo backend at all is Open Decision O8; the default is disposable stack only.
- Unverified until run on a stack: `NOT NULL` columns on `cashbook_period` and `cashbook_line_item` beyond those listed in
  F14 and F18, and whether the guard triggers (`trg_guard_*`, `20261105150000_fix_guard_enum.sql`) block a direct insert
  at status `HOReviewed`. The script may need `set local session_replication_role = replica` on the disposable stack; do
  not use that on the dev/demo backend.
- Notice seed: `supabase/seed_burial_notice_synthetic.sql` inserts two synthetic notices (one District, one Apostleship)
  for a `SYNTH` district. The messages use only the synthetic values in section 4.6.

## 10. Validation rules (external inputs)

| Input | Rule | On failure |
|---|---|---|
| `scope_level` | required; one of District, Apostleship, Overseership | 400 `validation:` |
| `scope_id`, `id` | required (id only for edit/retire); UUID | 400 |
| `message` | required; string; trimmed with the set space, tab, CR, LF (`btrim(msg, E' \t\r\n')`, never plain `btrim`, which trims spaces only); 1 to 1000 chars after trimming; control characters other than tab, CR and LF rejected (`[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]`). Enforced in the Edge validator, in `burial_notice_publish` AND in the table CHECKs. The trimmed string is what is forwarded and stored. Newline-only and tab-only messages are rejected | 400 (22023); client shows inline error |
| `starts_on` | required; real date `YYYY-MM-DD` | 400 |
| `expires_on` | optional (O2); real date; `>= starts_on`. On create also `>= today`. On edit no today rule: a past value is allowed and ends the notice | 400 |
| Edit scope | `scope_level` and `scope_id` on an edit must equal the stored scope | 400 (22023) |
| Edit dates | conflict check runs when `starts_on` or `expires_on` changed; text-only edits skip it | 200 conflict body, or write |
| Scope node | must exist, level must match, parent chain must reach a District (400); district must be in the caller's assignments (403) | 400 / 403 |
| `replace` | optional; `none` (default), `retire_conflicts`, `keep_both` | 400 |
| `p_actor` | taken from `auth.getUser`, never the body | n/a |
| Trend args | `p_congregation_id` non-null UUID; `p_end_month` 1-12; `p_end_year` 2000-2100 | **RPC returns no rows and raises nothing** (decided, review finding 5): NULL congregation, NULL or out-of-range month or year all return an empty set before any date arithmetic; the client treats empty as "hide the chart" |
| Faithfulness window | `4` or `"all"` (client enum; the live query limit derived, never user text) | n/a |

## 11. Error handling

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Publish: service key missing | config | fatal | 500 `Server config error` | Edge runtime log |
| Publish: no or bad Bearer | auth | yes (sign in) | 401 | none |
| Publish: not HO / HO outside window / no district assignment / other district | authz | no | 403 `Forbidden` | none (no PII) |
| Publish: body invalid | validation | yes | 400 with the first failing field | none |
| Publish: overlap at same scope | business | yes | 200 `{conflict:true, conflicts}`, nothing written | none |
| Publish: SQL error | unexpected | maybe | fixed text by SQLSTATE: `42501` 403 "Forbidden"; `22023` 400 "Invalid notice request"; other 400 "Could not save the notice". Raw `error.message` is never returned | `console.error` in the Edge runtime log with code and message |
| Notice cache refresh fails or table missing | network or schema | yes | existing cache kept, default shows | `console.warn` once per refresh (existing pattern) |
| Notice render: row with bad dates | data | n/a | row skipped | none |
| Trend RPC fails, times out, offline | network | yes | cached or local series with a one-line note | `console.warn` |
| Trend RPC returns no rows | n/a | n/a | zero series; chart or "No Burial recorded" | none |
| Proof exemption | none new | n/a | n/a | n/a |
| Faithfulness load fails | network or Dexie | yes | existing red `role="alert"` message | none |

Nothing in this spec adds a toast on a background read failure.

## 12. Invariants and who enforces them

| Invariant | Owner | Why there |
|---|---|---|
| Only HO writes notices, only for assigned districts | `burial_notice_publish` (SQL) + `admin-write` gate | Server-side; the SQL function is the single place that decides, the Edge gate is the checklist front door |
| Scope shape and parent chain | `burial_notice_publish` | One transaction, testable on a stack |
| No browser writes | table grants (none) and RLS default deny | Fails closed even if the Edge Function is bypassed |
| Notice read scope | RLS policy | Authoritative; the client filter is a convenience |
| Overlap conflict and atomic replace | `burial_notice_publish` | Atomicity needs a transaction |
| Expired notice never shows | client `isActiveOn` | Date compare against the device date; offline cache cannot be trusted to prune |
| Burial exempt from per-line proof | server `cashbook_review_ready` (authority) + client mirror | Server is the review gate; client mirrors it so Submit is not blocked locally |
| Trend visible to Chairperson and Treasurer only (not Elder), for their own congregation | `permissions.ts` (UI) + RPC (authority: role and congregation on one access row, F22) | Matrix is the UI single source of truth; RPC re-checks and does not trust `get_my_hierarchy_ids()` for this |
| Faithfulness only Chairperson and Elder | `canViewOfficerFaithfulness` via matrix | Unchanged |
| Card and detail agree for the 4-window | shared `buildFaithfulness`/`listOfficersWithoutRecentTithe` and a test | Divergence would confuse the demo |

Steering invariants touched: #1 (matrix rows added, no role strings), #2 (HO-only), #3 (district segregation), #4 (time window,
enforced in the new SQL function; the shared gate gap is recorded), #5 (fail-closed: any failure writes nothing), #7 (trend is
totals only), #8 (hierarchy shape re-checked). None is widened.

## 13. Offline and rollout compatibility

| State | Notice | Trend | Burial proof | Faithfulness |
|---|---|---|---|---|
| Client new, backend old (migrations not applied) | Default notice (table query errors, logged) | Local current-year only; RPC error hidden | Client rule exempts Burial; server still requires it when `proof_mandatory` true | Works (Dexie) |
| Client new, backend new | DHO notices | Server + local | Both exempt | Works |
| Offline | Cached notices, expired ones filtered | Cached last result or local | Client rule | Dexie path works; Elder live path needs a connection (as today) |

The server and client Burial-proof rules can disagree for a time when `proof_mandatory` is true: the client lets Submit
through, the server's `cashbook_review_ready` then reports not ready until the migration is applied. Demo congregations have
`proof_mandatory = false` (`PROJECT-LOG.md`), so the demo is not affected. Apply the migration before enabling
`proof_mandatory` anywhere.

## 14. Rollout and launch checklist

1. Spec 1 approved and implemented first (shared files and Dexie version).
2. Client work for items 2-4 merges with migrations unapplied (section 13 makes this safe).
3. SQL files tested on a disposable stack (`supabase start`, Docker) with the new tests in `supabase/tests/`.
4. With explicit user authorisation only: apply migrations in order `...110000`, `...120000`, `...130000` after Spec 1's
   `20261124100000`; redeploy `admin-write`; run read-only checks; the destructive-statement cancel behaviour noted in
   `PROJECT-LOG.md` does not apply (no DROP in these files) but the user may still prefer the SQL editor.
5. Launch checklist (before any real member sees the app): replace or reword `BURIAL_DEFAULT_DETAILS` (O6); confirm no
   synthetic notice rows remain; confirm `SYNTH` congregation is removed from any real backend.

## 15. Known issues recorded, not fixed (steering: raise a bugfix spec)

- B1. `admin-write` gate does not check `start_date`/`end_date` and uses an unordered `limit(1)` active-access lookup
  (`index.ts`, F8). An HO with more than one active access row may be refused (403) non-deterministically.
- B2. Audit log: no `audit_log` action exists for notice publish or retire. Provenance is held in the table columns only.
- B3. `markCashBanked` rewrites `item_type`, so banked Burial lines disappear from the Burial tab (`tabItems` filters
  `item_type`). Queries in this spec use `section`.
- B4. The faithfulness rule counts any line with `officer_id` and counts empty or future-dated local periods, so a
  draft future period lowers every officer's score. The card shares this behaviour; this spec preserves it.
- B5. `refreshReferenceCache` runs only from `LoginPage`; a restored session never refreshes it. The Burial tab mount
  refresh in 5.4 covers notices only.
- B6. `ProofLink.tsx` has a whitespace-only uncommitted change (`PROJECT-LOG.md`). Leave it.

## 16. Test plan

Unit (vitest, `fast-check` is installed, `fake-indexeddb` for Dexie):

**Test approach (F21, N5).** vitest runs in node over `src/**/*.test.ts`; there is no jsdom or Testing Library and this
spec adds none. Every decision is a pure function with a node test. Components are thin mappers, verified by (a) a
node "source guard" test that reads the component file text and asserts it contains no `dangerouslySetInnerHTML`
(`fs.readFileSync` in vitest is available in node), and (b) the manual UAT task (T20). No `*.test.tsx` file is created.

- `burialNotice.test.ts`: `isActiveOn` boundaries (start day, expiry day inclusive, null expiry, expired); `resolveNotices`
  scope matching, ordering, cap, default fallback; `noticeView` returns `kind: "default"` for none/expired/not-started and
  returns the message string unchanged for `<b>x</b>` (the component renders it as a text node); property: a notice
  outside every id never appears; property: output length `<= max`; expired never present.
- `burialNoticeForm.test.ts`: `validateNoticeForm` for every rule in section 10; `conflictPanelState` for a 200 conflict
  body, a saved body, and an `ok:false` error; `visibleNotices` hides expired by default and lists them with
  `showExpired` (requirement 1.9).
- `burialTrend.test.ts`: `trendWindow` for each end month including January and December (year rollover); `mergeTrend` no
  double count (Draft local plus server Draft), submitted-unsynced counted, synced and listed by the server skipped, unlisted counted, server-rejected-later counted once (Appendix A TV3, TV8-TV11),
  cents arithmetic (`0.1 + 0.2`), Burial identified by `section` including a line with `item_type = "CashBanked"`; zero
  fill; property: sum of merged = sum of inputs in range; `trendViewModel` for server, cache ("as of"), local-only,
  failure note and all-zero; the merge never reads the local `status` field (property: changing a period's `status` does not change the merged result).
- `chartMath.test.ts`: `niceMax(0)`, single value, equal values; stacked totals; bar widths positive; no NaN for all-zero.
- `faithfulness.test.ts`: `buildFaithfulness` counts; the 4-window equality `missed === of` versus the card list on
  fixtures (requirement 9.4), including zero periods (every active officer on both sides); window capped at 26;
  `faithfulnessViewModel` sorting (missed desc, then code) and badge kinds ("none-in-window", "no-periods", none).
- Faithfulness live path (mocked Supabase client in a `.test.ts`): identical fixtures including one non-Priest officer row
  yield the same history as the Dexie path (the live officers query asserts the `rank` filter is passed); window limit 4
  or 26 passed.
- Route guard: `canViewOfficerFaithfulness` is true for Chairperson and Elder and false for Treasurer, Secretary and the
  other roles (already built; the test pins it so the redirect behaviour stays as today).
- `completeCapture` tests: Burial no longer proof-required; EFT, DirectDebit, Expense unchanged. `CashbookForm` proof tests
  updated for the split predicate.
- `permissions.test` additions: `burial.notice_manage` is M for HO only; `burial.trend_view` per role; matrix characterization
  tests updated (if a snapshot test of the full matrix exists, update deliberately) [UNVERIFIED whether one exists].
- `cacheLoader.test.ts` (extend the existing file if present, [UNVERIFIED]): notice query failure keeps old rows and does
  not stop other stores; success replaces; missing table logs a warning.
- `validateBurialNoticeRequest` and `mapBurialNoticeError` tests (against `src/lib/burialNoticeRequest.ts`): every rule in
  section 10; SQLSTATE `42501`, `22023` and an unknown code map to the fixed texts and never echo the input message. Copy
  guard: `src/lib/burialNoticeRequest.copy.test.ts` reads `supabase/functions/admin-write/burialNotice.ts` and
  `src/lib/burialNoticeRequest.ts` and asserts byte identity (design 5.3).

Integration (disposable stack; SQL tests in `supabase/tests/burial_notice_rls.test.sql`, following the existing pattern):

1. Authenticated user cannot INSERT, UPDATE or DELETE `burial_notice` (permission denied).
2. HO of district A: `burial_notice_publish` for an Apostleship under A succeeds; for a valid Apostleship under district B raises
   42501 (HTTP 403); for a nonexistent scope id raises 22023 (HTTP 400, not 403).
3. HO with inactive or expired access row: 42501. HO access row but no `ho_district_assignments` row: 42501.
4. Non-HO role (Treasurer, Elder) cannot execute the function (permission denied; also not callable by `authenticated`).
5. Scope shape: an Apostleship id passed as `Overseership` raises 22023 (HTTP 400); a broken parent chain raises 22023; a
   nonexistent node raises 22023. None of these returns 403.
5b. Edit rules: edit with `expires_on` before today succeeds and the row stops showing; edit with `expires_on < starts_on`
   raises 22023; moving `starts_on` into an overlap with another active notice at the same scope returns `conflict:true`;
   a text-only edit on a row that overlaps another (both already active) returns no conflict; edit with a changed scope raises
   22023.
6b. Concurrency: two sessions publish overlapping notices at the same scope at the same moment (the second is started while the first transaction is open). The second blocks on the advisory lock, then returns `conflict:true` naming the first row; with `retire_conflicts` it retires it. Never two overlapping active rows without a deliberate `keep_both`.
6c. Message rules: `E'\n'`, `E'\t'`, `E'\r\n'`, `'   '`, `E'a\x01b'` and a 1001-character string each raise 22023 from `burial_notice_publish`, and a direct `service_role` insert of each is rejected by the table CHECKs. A message with an interior newline and a tab is accepted and stored trimmed.
6. Overlap: second publish at same scope with overlapping range and `replace='none'` returns `conflict:true`, writes nothing.
   `retire_conflicts` retires old and inserts new atomically (force a failure after the retire step to prove rollback).
   Non-overlapping range: no conflict. Different node or level: no conflict.
7. SELECT policy: a Treasurer in district A reads district A notices and none from B; retired rows invisible.
7b. Elder read: an Elder with no congregation-scoped access row reads zero or the district's notices depending on `get_my_hierarchy_ids()` (record the actual result; requirement 3.8 is satisfied either way because the client falls back to the Default notice). Expected and recorded, not asserted either way until confirmed on the stack.
8. `burial_monthly_totals`: `period_ids` lists exactly the periods whose lines make up `total`; returns sums by `section = 'Burial'` including banked lines (`item_type = 'CashBanked'`); excludes
   Draft and Rejected; a caller without a Treasurer or Chairperson row at that congregation gets no rows (an Elder row alone gets none, case 8c); an
   Auditor gets no rows; a Secretary gets no rows.
8b. Cross-congregation role: a user with an active Treasurer row at congregation A and an active Auditor row at congregation
   B calls the RPC for B and gets no rows (the role is not held at B). Expected and required; this is the same-row rule of
   requirement 8.3. A call for A returns rows.
8c. Elder: a user whose only active row is an Elder row at congregation A calls the RPC for A and gets no rows (Elder is not in the role list, requirement 8.3 and 8.8). The client never calls it for an Elder (8.8b).
9. `cashbook_review_ready` with `proof_mandatory = true`, `balance_rule = 2` manifest: Burial-only unproofed period returns true (including a Burial line with `item_type = 'CashBanked'`); an unproofed EFT line still returns false; an unproofed Expense line still returns false; Burial cash with no deposit slip still returns false.
9b. Same with a `balance_rule = 1` manifest (legacy branch): Burial-only unproofed period returns true; an unproofed EFT line returns false. The function body differs from Spec 1's only in two identical blocks (scripted diff in T13).
8d. `burial_monthly_totals` invalid arguments: month 0, month 13, year 1999, year 2101, NULL congregation, NULL year, NULL month each return no rows and raise no error (valid Treasurer caller, so the result is due to the argument check, not the role check).
10. Re-run Spec 1's and the sign-off SQL tests to confirm no regression.

Manual UAT (task T20; the only coverage of rendering, F21). Browser, after merge to the preview, with a written checklist:
Burial tab shows the Standard notice, then a published notice after login and after tab mount; the notice sits below the
tab buttons and above the capture bar and is absent on other tabs; a message containing <b>x</b> shows literally;
offline shows the cached notice and hides an expired one; the HO screen shows the conflict panel and Replace, Keep both
and Cancel; the trend renders with synthetic data, shows "as of" offline and a one-line note when the RPC is absent;
a Burial line without proof submits with proof_mandatory = true; the Faithfulness page for Chairperson and Elder shows
the chart and "missed N of M", redirects the Treasurer, and Back works from both entry points.

## 17. Open decisions the user must answer

| ID | Decision | Options | Recommendation | Needed by |
|---|---|---|---|---|
| **O1** | When notices at different scope levels are active together, which show? | (a) most specific only; (b) broadest only; (c) all applicable, most specific first, max 3 | **(c)**; build default until answered | T1, T7 |
| **O2** | Is the expiry date required? | Required, or optional (null = no expiry) | Optional, with a "no expiry" hint, so permanent payment instructions are possible | T4 |
| **O3** | Who may read notices? | District-scoped (members of the district and its HO), or every authenticated user | District-scoped, because a message may hold payment instructions | T4 |
| **O4** | Two parts. (1) Which month does a Burial amount belong to? (2) Which 12-month window? The user wrote "over the last calendar year". | (1) Period OAC month, or the line's `transaction_date` calendar month. (2) Trailing 12 OAC months ending with the current month (this spec's default), or January to December of the last full calendar year | (1) Period OAC month. (2) Trailing 12 months: it always has data up to now, whereas January to December of last year leaves the current year out and is empty in early January; it needs no change to the RPC (one end month argument) either way | T10 |
| **O5** | Should Draft, Rejected and unsynced periods count in the trend? | Exclude Draft and Rejected on the server and add this device's editable or unsynced periods locally, or exclude entirely | Server excludes; local overlay adds editable and unsynced periods | T10 |
| **O6** | What does the default notice say before launch? | Keep synthetic account in the default; or reword without any account and show only "ask your DHO for the account details" | Reword without an account before launch; keep synthetic values for the demo only | Before demo |
| **O7** | Chart implementation | Hand-written SVG, or add a charting library | Hand-written SVG (no dependency) | T9 |
| **O8** | Where may the synthetic seed be applied? | Disposable stack only, or also a labelled `SYNTH` congregation on `cwdyixafvylzgtpsfmwr` (needs your authorisation) | Disposable stack for tests; a `SYNTH` congregation on the dev/demo backend only if you want a prior-year story in the demo | Before demo |
| **O9** | Burial proof control after exemption | Keep an optional attach control, or remove the control for Burial | Keep optional (DHO receipt photo) | T12 |
| **O10** | Faithfulness windows | 4 only; 4 and All (cap 26); other | 4 and All (cap 26) | T18 |
| **O11** | Trend when offline | Show last cached result labelled "as of"; or hide | Show cached | T11 |
| **O12** | Confirm DHO means role `HO` limited by `ho_district_assignments`, and that Apostle and Overseer never publish | Yes, or another rule | Yes | T4 |
| **O13** | Who sees the Burial trend, and does the Secretary get a surface? | (a) Chairperson and Treasurer on the capture Burial tab only (Elder excluded: no congregation-scoped access row, no trend, Default or cached notice only); (b) (a) plus a Secretary totals block on `SecretaryReview.tsx` (extra task, needs a second RPC role entry); (c) Treasurer only; (d) add Elder with a defined fallback (needs the RPC to accept an Elder row with a congregation id) | **(a)**: the Secretary cannot reach the Burial tab (F24) and Burial may be retired | T2 |
| **O14** | Hide the trend automatically once 24 months are all zero (supports Burial retirement) | Yes or always show | Yes, replace with one line | T11 |
| **O15** | Should an `audit_log` action be added for notice publish and retire? | Now (changes `types.ts` enumeration) or backlog B2 | Backlog | n/a |
| **O16** | Chairperson faithfulness data source | (a) Dexie only, matches the card, device-limited (note shown); (b) live read online with Dexie fallback offline, so the history is complete on any device but the card and page could disagree until the card is also changed | **(a)** now, backlog (b) with a card change | T18 |

## 18. Risks

- **Shared files with Spec 1.** `CashbookForm.tsx`, `completeCapture.ts`, `schema.ts` (Dexie version) and
  `cashbook_review_ready`. Mitigation: fixed order in `tasks.md`, a diff check on the function body, and a task that reads
  `schema.ts` for the current version before editing.
- **Function replaced twice.** If Spec 1's body changes after the proof-exempt migration (authored, NOT APPLIED) was generated from it, the Burial exemption silently
  reverts that change. Mitigation: the diff task, and the header that names the dependency.
- **Notice with real bank details.** A DHO could type a real account number into a notice. That is the intended use in
  production, and it is data, not repository content. The repository, tests and seeds contain synthetic values only (10.3).
  A pre-commit grep task checks for long digit runs in the new files.
- **Notice abuse (long text, scripts).** Plain text rendering, 1000-character cap, control characters rejected.
- **Demo shows an empty trend.** Pre-production history is thin (F18). Without O8 the chart is empty or local only. Decide
  before the demo.
- **Trend counts submitted periods plus this device's own.** Treasurers may think a number is missing because the period
  is still Draft on another device. The caption says "submitted periods and this device's drafts". The merge keys on the
  server's `period_ids` (design 7.1), so a period is neither dropped nor double counted; the residual limits (a locally
  edited counted period, a stale cached result) are stated there.
- **Faithfulness on the Chairperson path reflects this device only (F25, F26).** A Chairperson on a new device or after a
  cache clear sees few periods; the page says so (requirement 9.8a/b). A live read for the Chairperson is O16.
- **Elder on the capture Burial tab sees no trend.** Decided (review finding 2, option a): an Elder enters capture
  (`capture.create` = `O`) but has no congregation-scoped access row, so the trend is removed for Elder rather than shown
  empty (design 4.3, requirement 8.8b). The Elder's notice area depends on RLS returning notices to an Elder, which is
  [UNVERIFIED] (case 7b); the Default notice is the fallback. Recorded as O13 option (d) if the user wants an Elder trend.
- **Component rendering has no automated test.** Accepted and deliberate (F21, N5): logic lives in tested pure modules,
  rendering is covered by the manual UAT task T20. A regression in markup only shows in UAT.
- **Faithfulness is judged against today's officer list.** An officer added last week shows earlier periods as missed
  (A6, caption). Acceptable for v1.
- **Edge Function not deployed.** The notice screen will show an error on publish until `admin-write` is redeployed with
  the new actions. The HO screen reports it plainly; nothing else is affected.
- **Dexie version collision.** Two specs claim `version(5)`. Mitigation: the task reads `schema.ts` first; Dexie versions
  must be strictly increasing and additive.
- **supabase-js non-2xx behaviour [UNVERIFIED].** Avoided by returning conflicts as 200.
- **Burial retired later.** All new code is in separate files plus three small insertions in `CashbookForm.tsx` (notice,
  trend, split predicate). Removal is mechanical.

## Appendix A: golden vectors for the trend merge

Window end 2026-11. `current` = 2025-12 ... 2026-11, `prior` = 2024-12 ... 2025-11.

| Case | Input | Expected |
|---|---|---|
| TV1 | server `[(2026,11,100.00),(2025,11,80.50)]`, no local | current[11]=100, prior[11]=80.5, all else 0 |
| TV2 | server `[]`, local Draft period 2026-11 with Burial lines 50.10 and 49.90 | current[11]=100.00 |
| TV3 | server `[(2026,11,100, period_ids=[P1])]`, local period P1 (`serverId=P1`) 2026-11, `localStatus="synced"`, Burial 100 | current[11]=100 (P1 listed by the server, local skipped, no double count) |
| TV4 | local Draft period with a banked Burial line (`item_type="CashBanked"`, `section="Burial"`) of 70 | counted: 70 |
| TV5 | local Draft period with an Expense line of 70 | not counted |
| TV6 | end 2026-01 | current = 2025-02 ... 2026-01; prior = 2024-02 ... 2025-01 |
| TV7 | all zero | `allZero = true` (chart replaced by one line) |
| TV8 | server `[]`, local period 2026-11 `serverId=null` or not listed, `localStatus="pending"`, Burial 100 | current[11]=100 (not counted by the server, counted from Dexie) |
| TV9 | server `[(2026,11,100, period_ids=[P1])]`, local periods P1 (synced, Burial 100) and P2 (`serverId=null`, pending, Burial 40) | current[11]=140 (P1 skipped, P2 added) |
| TV10 | local period P1 `status="Submitted"`, `localStatus="synced"`, `serverId=P1`, Burial 100; the server has since Rejected P1, so the server result is `[]` (P1 not listed) | current[11]=100, counted once, from Dexie (finding 8; local `status` is never refreshed, F25) |
| TV11 | cached server result (older) lists P1; P3 synced after the cache was taken (`serverId=P3`, not listed), Burial 60 | P1 skipped, P3 added (60); no period dropped |

## Appendix B: notice resolution vectors

Congregation ids: district D1, apostleship A1, overseership O1. Today 2026-12-01.

| Case | Notices | Result (cap 3, mode c) |
|---|---|---|
| N1 | none | default |
| N2 | District D1 2026-11-01..2026-11-30 | default (expired) |
| N3 | District D1 open-ended | [D1] |
| N4 | D1, A1, O1 all active | [O1, A1, D1] |
| N5 | A2 (other apostleship) | default |
| N6 | A1 starts 2026-12-02 | default (not yet started) |
| N7 | A1 expires 2026-12-01 | [A1] (inclusive) |
| N8 | two A1 notices, starts 2026-11-01 and 2026-11-15 | newer start first |

## 19. Responses to review findings

### 19.4 Review of 2026-11-26, second round (`.agents/tasks/specs-expense-burial-2026-11/review.json`; findings 2, 3, 4, 5, 8, 9 concern this spec; 1, 6, 7 concern Spec 1 and are not edited here)

| # | Severity | Response |
|---|---|---|
| 2 | MEDIUM | Addressed, recommended option. The Burial exemption is applied to BOTH branches of `cashbook_review_ready` (the `balance_rule = 1` legacy branch and the rule-2 `proof_mandatory` block) as the identical edit `li.section is distinct from 'Burial' and li.item_type in ('EFT','DirectDebit','Expense')`. The migration file was generated from Spec 1's function by script, so exactly two hunks differ; T13 re-checks with a scripted diff. Requirement 7.2 now covers both manifest rules (7.2a) and integration case 9b tests the legacy branch. Spec 1's R3.11 "verbatim legacy" wording needs "except the Burial exemption of Spec 2"; that edit belongs to Spec 1 and is recorded as a cross-spec follow-up in 6.2. |
| 3 | MEDIUM | Addressed. The three migrations are authored with NOT APPLIED headers: `20261124110000_burial_notice.sql`, `20261124120000_burial_proof_exempt.sql` (full body) and `20261124130000_burial_monthly_totals.sql`. The duplicated SQL was removed from this document (4.2 and 4.3) and replaced by a behaviour contract so file and text cannot drift. T4, T11 and T13 become review-and-test tasks. Not parsed by Postgres; [UNVERIFIED] until T19. The seed scripts (section 9) remain specified, to be authored in T14; the review did not ask for them. |
| 4 | MEDIUM | Addressed. Trim set `E' \t\r\n'` in the function and in the table CHECK, a control-character regex in the function and a second table CHECK, stored value is the trimmed string, the Edge validator uses the same rules and forwards the trimmed string. Integration case 6c covers `E'\n'`, `E'\t'`, `E'\r\n'`, spaces only, `E'a\x01b'`, and 1001 characters. |
| 5 | MEDIUM | Addressed, "returns no rows" chosen. `burial_monthly_totals` is now `plpgsql` with an early `return` for a null congregation, null or out-of-range month (1-12) and year (2000-2100), before `make_date`. Section 10 states the single behaviour. Integration case 8d added. |
| 8 | NIT | Addressed. The window is now part of O4 (trailing 12 OAC months versus January to December of the last full year), with a recommendation. |
| 9 | NIT | Addressed. `pg_advisory_xact_lock(hashtext('burial_notice:' || scope_level || ':' || scope_id))` after the district check and before the conflict query. Integration case 6b covers concurrency. |
### 19.3 Review of 2026-11-26 (`.agents/tasks/specs-expense-burial-2026-11/review.md`; findings 1, 2, 4, 7, 8, 9, 10 concern this spec, 3, 5, 6 concern Spec 1)

| # | Severity | Response |
|---|---|---|
| 1 | MEDIUM | Addressed by option (b). Section 4.1-4.3, 6.2 and 9 now say "specified here, authored in T4/T11/T13/T14, never applied by this spec". `burial_notice_publish` and `burial_notice_retire` have full bodies in 4.2. Retire of an already-retired id returns `{conflict:false,id,already_retired:true}` with no write (idempotent). `keep_both` on an edit updates the edited row in place and leaves other overlapping rows untouched; `retire_conflicts` on an edit retires only the others. No migration file was written in this documentation pass because the brief forbids code and migration changes; the bodies are unparsed and flagged [UNVERIFIED] until T19. |
| 2 | MEDIUM | Addressed by option (a). Elder removed from `burial.trend_view` and from the RPC role list (4.3, 3.10, requirement 8.3, 8.8). New requirement 3.8 states what an Elder sees (notice area from cache or the Default notice, no error) and 8.8b states the trend renders nothing and calls nothing. Integration cases 7b (Elder read of notices, outcome recorded) and 8c (Elder row gets no rows) added; risk text rewritten; O13 gains option (d) to add Elder later. |
| 4 | MEDIUM | Addressed. Section 3.6 and 6.1 now define `proofRequiredFor(line: {section, item_type})` keyed on `section`, list every call site (`CashbookForm.tsx` 45, 211, 438, 849; `completeCapture.ts` 25-29, 86, 239), and require the test pair `{section:"Burial", item_type:"EFT"}` (not required) versus `{section:"Members", item_type:"EFT"}` (required). Requirement 7.7 added; T12 rewritten to match. |
| 7 | NIT | Addressed in tasks T5 verification (one added import line plus the new block; gate and existing actions unchanged). |
| 8 | NIT | Addressed. Requirement 9.8 and design 8.2 caption state that a Spec 1 pre-paid expense counts as tithed. |
| 9 | NIT | Addressed. Requirements glossary maps the four user scope choices to the three levels; multi-apostleship needs one notice each. |
| 10 | NIT | Addressed. The server create-date rule is `expires_on >= current_date - 1` (deliberate one-day leniency, requirement 1.3, design 4.2 step 2); the strict check is the client's, on the device date. |

### 19.1 Review of 2026-11-24 (second review, findings 6-14 for this spec; findings 1-5 concern Spec 1)

| # | Severity | Response |
|---|---|---|
| 6 | MEDIUM | Addressed. Requirement 1.4 split into 1.4a (missing node, wrong level, broken chain: 400, SQLSTATE 22023) and 1.4b (valid node, district not assigned: 403, 42501). Design 4.2 steps 3 and 4 state the order (shape first, so a nonexistent node never gives 403) and section 10 lists both. Integration cases 2 and 5 aligned; 5b added. |
| 7 | MEDIUM | Addressed. Decided: self-contained `supabase/functions/admin-write/burialNotice.ts` plus an identical `src/lib/burialNoticeRequest.ts` for the client form and vitest, with a byte-identity node test. The "if Deno resolves" branch is removed from design 5.3 and 16 and from tasks T5. |
| 8 | MEDIUM | Addressed with a verified fact. Dexie never refreshes period `status` from the server (F25: `syncEngine.ts` updates only `serverId` and `localStatus` flags). The merge rule no longer reads local `status`: the RPC returns `period_ids` and a local period is added unless the server counted it (requirement 8.2, 8.4; design 4.3, 7.1). Vectors TV3, TV8, TV9 rewritten; TV10 (server later Rejected) and TV11 (synced after cache) added. |
| 9 | MEDIUM | Addressed. Verified that Chairperson data is device-local (F25, F26). Requirement 9.8a states the source, 9.8b adds the partial-window note, design 8.2 computes it in `faithfulnessViewModel`. O16 offers a live Chairperson read; recommendation is to keep parity with the card and backlog it. |
| 10 | MEDIUM | Addressed. Requirements 1.3, 1.6, 1.6a, 1.6b and 2.1 define edit rules: only `expires_on >= starts_on` applies on edit, a past expiry ends the notice, the conflict check runs when a date changes and excludes the edited row. Design 4.2 steps 2, 5, 6 and section 10 updated; integration case 5b and the T3 validator tests cover it. |
| 11 | NIT | Addressed. Design 4.1 and F19 now state that `get_my_hierarchy_ids()` is verified to return congregation ids, with file and line references; only role coverage is unverified. |
| 12 | NIT | Addressed. Design 5.3 maps SQLSTATE to fixed messages via `mapBurialNoticeError` and logs detail with `console.error`; section 11 row updated; tests added. |
| 13 | NIT | Addressed. Requirement 5.5 and design 5.5 state the staleness window (next online login or Burial tab mount) and add an HO hint after edits. |
| 14 | NIT | Addressed. Design 4.4 and tasks T6 take the next free Dexie version instead of stopping. |

### 19.2 Earlier review (first review, resolved)

| # | Severity | Response |
|---|---|---|
| 1 | HIGH | Addressed. Option A chosen. Design 16 states the node-only approach (F21, N5); view models `noticeView`, `validateNoticeForm`, `conflictPanelState`, `visibleNotices`, `trendViewModel`, `faithfulnessViewModel` hold the logic and are tested in node; a node source-guard test replaces the render test for "text, not HTML"; the route-guard rule is tested through `canViewOfficerFaithfulness`; rendering is covered by manual UAT task T20. No dependency or `*.test.tsx` added. |
| 6 | MEDIUM | Addressed. Requirement 9.4 and design 8.1 define the zero-period case (`missed === of`, no `of > 0`; "No periods yet" label). The live history query repeats `rank in ('Priest','Underdeacon')`; the Dexie cache is rank-filtered at load (F23). Tests: equality including zero periods, and a live-path test with a non-priest fixture. |
| 7 | MEDIUM | Addressed by tightening, not by documenting a gap. The RPC now ties role and congregation to one access row (Tranche 4 pattern, F22). Requirement 8.3 states it, integration case 8b covers Treasurer at A and Auditor at B. Residual limitation (Elder with no home congregation gets no rows) is stated. |
| 8 | MEDIUM | Addressed, option (a). Secretary dropped from the matrix row, the RPC and requirement 8.8 because the Burial tab is unreachable for a Secretary (F24). O13 rewritten with the Secretary-block option (b) for the user. |
| 9 | MEDIUM | Addressed. Overlay rule is "editable or `localStatus != synced` adds; synced ignored" (requirement 8.4, design 7.1). Vectors TV3 (submitted, synced), TV8 (submitted, unsynced) and TV9 added. The RPC cannot identify periods, so the rule is stated in those terms. |
| 11 | NIT | Addressed. `tasks.md` renumbered T0-T22 in execution order with a dependency line. |
| 12 | NIT | Addressed. Spec 2 uses `version(6)` (design 4.4), with a read-first stop check. |
| 14 | NIT | Addressed. Expired rows are hidden by a client date filter with a "Show expired" toggle (requirement 1.9, design 5.1). |
| Reviewer note | n/a | `generate_series` operands are now both cast to `timestamp` (design 4.3); still to be confirmed on the stack. |
| Findings 2-5, 10, 13 | n/a | Concern Spec 1 only; not changed here. |
