# Implementation Plan — Treasurer Capture Slice

Scope: the Treasurer Capture Flow only (Requirements 1 & 2). Realigns the offline layer
to the real `cashbook_period` / `cashbook_line_item` / `cashbook_attachment` schema and
`cashbook-proofs` bucket, and rebuilds the capture UI. Other roles are out of scope.

TypeScript throughout. Property tests use **fast-check** (min 100 runs), tagged
`// Feature: restore-to-vite, Property {n}: {property_text}`. Build on prior steps.

## Tasks

- [ ] 1. Pure utilities (foundational, no dependencies)
  - [ ] 1.1 Implement `src/lib/oacWeeks.ts`
    - `getOacWeeks(year, month)`: Week 1 = 2nd Sunday; weeks per Sunday; final week = 1st Sunday of next month; label `Mon YYYY - Week n [DD Mon]`; `weekKey = YYYY-MM-Wn`. `getCurrentOacWeek(now?)`.
    - _Requirements: 1.2_
  - [ ]* 1.2 Property test — OAC week rules
    - **Property 1**: for any year/month, Week 1's date is the 2nd Sunday and the final week's date is the 1st Sunday of the next month.
    - _Validates: 1.2_
  - [ ] 1.3 Implement `src/lib/imageCompress.ts`
    - `compressImage(file, maxWidth=1920, quality=0.8)`: canvas resize/encode to JPEG; skip non-images and files < 500KB (return original). Ported from f6145ff1, no dependencies.
    - _Requirements: 1.9_
  - [ ] 1.4 Implement `src/lib/captureTotals.ts`
    - `sectionTotals(items)`, `bankingView(items)` (DD/EFT/CashBanked subtotals + total, cash pending, expenses), `isBalanced(items)` (Members+Officers+Burial === Banked + Expenses), `monthlyExpensesExceedThreshold(items, 500)`.
    - _Requirements: 1.11, 1.12, 1.14, 1.15_
  - [ ]* 1.5 Property tests — totals/balancing/threshold
    - **Property 3**: `isBalanced` true ⇔ income === banked + expenses. **Property 2**: cash item ⇔ proof/count NULL.
    - _Validates: 1.5, 1.8, 1.14_

- [ ] 2. Dexie schema v2 (realign to real model)
  - [ ] 2.1 Upgrade `src/db/schema.ts` to `version(2)`
    - Replace the `captureQueue`/`cashbook_service` shape with `periods` (localId, &naturalKey, serverId, localStatus, congregationId, weekKey), `lineItems` (localId, periodLocalId, section, serverId, localStatus); add `congregationSettings` (congregation_id); keep credentials/congregations/hierarchyLevels/officers/syncMeta. Add `rank` index to officers.
    - Define `LocalPeriod` and `LocalLineItem` types (with proof Blob fields) per design; reuse `@/lib/types` enums.
    - The v2 upgrade drops prior local dev data (no production offline data exists).
    - _Requirements: 2.1, 2.4_

- [ ] 3. Checkpoint — utilities + schema compile
  - Run `tsc --noEmit`; ensure no type errors before building the repo layer.

- [ ] 4. Rewrite `src/db/captureRepo.ts` for provisional periods
  - [ ] 4.1 Period helpers
    - `getOrCreateLocalPeriod({congregationId, weekKey, service, year, month, week, userId})` dedups on `naturalKey`, creates provisional `status='Draft'` if absent; `getPeriod`, `listPeriods`, `setPeriodStatus`, `submitPeriod`.
    - _Requirements: 1.1, 1.13, 1.16, 2.2_
  - [ ] 4.2 Line-item helpers
    - `addLineItem(periodLocalId, section, input)`, `updateLineItem`, `deleteLineItem`, `getLineItems`; `setIncomeType` (Cash clears item_count + proof fields); enforce edit only when period status ∈ {Draft, Rejected}.
    - _Requirements: 1.4, 1.5, 1.7, 1.13_
  - [ ] 4.3 Proof + cash-lifecycle helpers
    - `attachProof(localId, blob, fileName, {date, bankRef})` stores compressed Blob + metadata; `markCashBanked(localId, blob, fileName, {date, bankRef})` transitions Cash/CashPending → CashBanked.
    - _Requirements: 1.9, 1.10_
  - [ ] 4.4 Reference reads
    - `listOfficers(congregationId)` (active, rank ∈ {Priest, Underdeacon}); `getProofMandatory(congregationId)` from cached settings.
    - _Requirements: 1.4, 1.8_
  - [ ]* 4.5 Property/unit tests
    - **Property 5** cash lifecycle one-way; **Property 6** editability gate; unit: income-type switch clears count/proof.
    - _Validates: 1.10, 1.13_

- [ ] 5. Update `src/utils/cacheLoader.ts`
  - Cache `congregation_settings` (proof_mandatory) and officers with the rank filter, into the v2 stores, during an online session.
  - _Requirements: 1.4, 1.8, 2.5_

- [ ] 6. Realign `src/utils/syncEngine.ts` reconciliation
  - [ ] 6.1 Period reconciliation via RPC
    - For each pending period ordered by createdAt: call `supabase.rpc('get_or_create_period', {...})` → store `serverId`; conflict-detect if server status downstream of local (mark conflict + audit, no overwrite).
    - _Requirements: 1.18, 2.2_
  - [ ] 6.2 Line-item + attachment upserts
    - Upsert each line item to `cashbook_line_item` with `period_id = serverId`; if `proofBlob`, upload to `cashbook-proofs` (path per design), insert `cashbook_attachment`, set `proof_status='uploaded'`, clear Blob; apply Draft/Rejected→Submitted transition via `statusFlow`; retry failed with backoff.
    - _Requirements: 1.9, 1.18, 2.2, 2.3_
  - [ ]* 6.3 Integration test — reconciliation
    - **Property 7**: every local line item maps to the single RPC-returned `period_id`; none orphaned. Representative offline→reconnect flow.
    - _Validates: 1.18, 2.2_

- [ ] 7. Checkpoint — data + sync layer
  - Run `tsc --noEmit` and property/unit tests; fix before UI.

- [ ] 8. Rebuild capture UI
  - [ ] 8.1 Proof modal component
    - `src/capture/ProofModal.tsx`: pick file → compress → capture transaction date + optional bank ref → returns Blob + metadata; used for EFT/DD inline and Cash-banked deposit.
    - _Requirements: 1.6, 1.9, 1.10_
  - [ ] 8.2 `src/capture/CapturePage.tsx`
    - Resolve access + congregation; render OAC week selector + AM/PM; `getOrCreateLocalPeriod`; status badge; submitted soft-lock notice; pass period to form.
    - _Requirements: 1.1, 1.2, 1.13_
  - [ ] 8.3 `src/components/CashbookForm.tsx` — 5 tabs
    - Tabs Members/Officers/Burial/Expenses/Banking with counts; officer picker (Priest/Underdeacon); conditional date pickers per item type; running totals cards; officer grouping with expand/collapse; Banking computed view (DD/EFT/CashBanked subtotals + total, Cash Pending, Expenses).
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.11, 1.12_
  - [ ] 8.4 Submit gate + governance
    - Submit disabled until `isBalanced`; if monthly expenses > R500 require requestor + Elder approval comments; log `SELF_REVIEW_EXCEPTION` on Elder/Chairperson override; set status Submitted + submittedAt.
    - _Requirements: 1.14, 1.15, 1.16, 1.17_
  - [ ] 8.5 Permission wiring
    - All view/create/edit/submit/override decisions via `permissions.ts` (no inline role checks).
    - _Requirements: 1.19_

- [ ] 9. Final verification
  - Run `tsc --noEmit` and `vite build` (confirm clean); run the property/unit test suite; manually smoke the capture screen offline→online if a dev Supabase is available.
  - _Requirements: 1 (all), 2 (all)_

## Notes

- `*` subtasks are optional tests; core tasks are not. This slice has real correctness rules, so the property tests are recommended, not skipped.
- Do NOT touch other roles or pull further f6145ff1 files in this slice.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.4", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.5", "3"] },
    { "id": 2, "tasks": ["4.1", "4.2", "4.3", "4.4", "5"] },
    { "id": 3, "tasks": ["4.5", "6.1", "6.2"] },
    { "id": 4, "tasks": ["6.3", "7", "8.1"] },
    { "id": 5, "tasks": ["8.2", "8.3"] },
    { "id": 6, "tasks": ["8.4", "8.5"] },
    { "id": 7, "tasks": ["9"] }
  ]
}
```


---

# Implementation Plan — Auditor Review Slice (Slice 2)

Scope: the online-only Auditor portal (Requirement 5). Direct live Supabase reads/writes
under RLS; NO Dexie, sync engine, or Treasurer/PWA files touched. Realtime subscription
and optimistic row-lock are in scope. Reuses `captureTotals` and `permissions.ts`.

> Routing note: audit lives at top-level `/audit` and `/audit/:periodId` (NOT under
> `/admin`, which is HO-only). In-page permission checks gate access, matching f6145ff1.

## Tasks

- [ ] 10. Routing & guard infrastructure
  - [ ] 10.1 Add audit routes to `src/App.tsx`
    - Replace the `/audit` role-dashboard placeholder with `AuditDashboard`; add `/audit/:periodId` → `AuditReviewPage`. Wrap both in the authenticated guard (`Protected area="any"`); the pages enforce `audit.view_queue` in-page. Online-only: render an offline-unavailable state when offline.
    - _Requirements: 5.1, 5.2_

- [ ] 11. Audit dashboard view (`src/audit/AuditDashboard.tsx`)
  - [ ] 11.1 Load congregation + queues
    - Resolve access; load the auditor's congregation; query pending = `cashbook_period` where `congregation_id` matches AND `status="Submitted"` ordered year/month/week desc; history = `status IN ("AuditApproved","Rejected")` limit 10.
    - _Requirements: 5.3, 5.4_
  - [ ] 11.2 Render queue + history layout
    - Pending count banner, "Services Awaiting Review" list, "Recent Audit History" list; each item labelled `"{Mon} {Year} — Week {n} ({AM|PM})"` with congregation/year/month/week context; navigate to `/audit/:periodId`.
    - _Requirements: 5.3, 5.4, 5.5_
  - [ ] 11.3 Access gate
    - If `!hasPermission(role, "audit.view_queue")` → "Access denied. Auditor role required."
    - _Requirements: 5.1_

- [ ] 12. Detail review screen (`src/audit/AuditReviewPage.tsx`)
  - [ ] 12.1 Proof viewer component `src/audit/ProofLink.tsx`
    - Paperclip indicator: green link opening `file_url` in a new tab when an attachment exists; red (missing) otherwise. Handles individual proofs and shared bulk deposit-slip attachments.
    - _Requirements: 5.8_
  - [ ] 12.2 Identity masking utility
    - Map `officer_id` → `officer_code` only (never full name); "—" when null.
    - _Requirements: 5.7_
  - [ ] 12.3 Load + render section panels
    - Load period, line items, attachments, officers. Render 5 panels: Banking Detail (DD/EFT/CashBanked subtotals + BANKING TOTAL), Cash Pending (cash income + cash burial + TOTAL CASH), Burial, Expenses, and Summary/Grand Total (Income − Expenses) + EFT/DD/Cash summary cards. Reuse `captureTotals` (`bankingView`, `sectionTotals`, `expensesTotal`).
    - _Requirements: 5.6, 5.7, 5.8_

- [ ] 13. State machine + concurrency + realtime
  - [ ] 13.1 Verification checklist hard-gate
    - Four per-section "Verified" checkboxes (Banking/Cash/Burial/Expenses); Approve disabled until all four checked. Decision panel only renders when `status="Submitted"` AND `audit.approve || audit.reject`.
    - _Requirements: 5.9, 5.10_
  - [ ] 13.2 Approve / reject writes with optimistic lock
    - Approve → `update cashbook_period set status="AuditApproved", audit_comment=<comment|"Approved"> where id=? and status="Submitted"`; Reject (mandatory non-empty comment) → `status="Rejected", audit_comment=comment` with the same `status="Submitted"` guard. If 0 rows affected → "already audited" notice + reload. Log `AUDIT_APPROVE`/`AUDIT_REJECT` to `audit_log`. Elder/Chairperson override → confirm + `logSelfReviewException(assumedRole:"Auditor")` before write. Navigate back by role (Elder→/elder, Chairperson→/chairperson, else /audit).
    - _Requirements: 5.11, 5.12, 5.13, 5.14, 5.15_
  - [ ] 13.3 Supabase Realtime subscription
    - Dashboard: subscribe to `cashbook_period` changes for the congregation → live-refresh pending/history. Review screen: if the open period's status changes externally, disable the decision panel and prompt reload. Clean up subscriptions on unmount. Degrade gracefully if realtime is unavailable (optimistic lock remains authoritative).
    - _Requirements: 5.15 (+ realtime enhancement)_

- [ ] 14. Workspace verification
  - Run `tsc --noEmit` and `vite build`; confirm zero errors/regressions and that no Treasurer/Dexie files changed.
  - _Requirements: 5 (all)_

## Notes (Auditor slice)

- Online-only; no `*` property-test subtasks (no pure-logic surface beyond the reused,
  already-tested `captureTotals`). Verification is typecheck + build + manual runtime.
- Do NOT touch Treasurer PWA files, `captureRepo`, `syncEngine`, or the Dexie schema.
- No Edge Function changes (audit writes are direct RLS-gated updates).

## Task Dependency Graph (Auditor slice)

```json
{
  "waves": [
    { "id": 0, "tasks": ["10.1", "12.1", "12.2"] },
    { "id": 1, "tasks": ["11.1", "11.3", "12.3"] },
    { "id": 2, "tasks": ["11.2", "13.1"] },
    { "id": 3, "tasks": ["13.2"] },
    { "id": 4, "tasks": ["13.3"] },
    { "id": 5, "tasks": ["14"] }
  ]
}
```

---

# Implementation Plan — Elder Portal Slice (Slice 3)

Scope: the online-only Elder Portal (Requirement 6). Direct live Supabase reads across one
or more congregations; the ONLY write is the month-end batch that advances `AuditApproved`
periods to `SubmittedToOverseer` and logs `MONTH_SUBMIT`. NO Dexie, sync engine, or
Treasurer/PWA files touched. Reuses `permissions.ts`, `oacWeeks.ts`, and `captureTotals.ts`.

> Accountability note (corrected against f6145ff1): the Elder submits **only up to the
> Overseer** (`SubmittedToOverseer`). The historical `elder/page.tsx` wrote `SubmittedToHO`
> with no audit log — a bug that skipped the Overseer stage. The authoritative contract is
> `monthly-close/page.tsx`: write `SubmittedToOverseer`, log `MONTH_SUBMIT`, gate on
> `month.submit_to_overseer`. The Overseer (accountable at HO, consolidating multiple
> congregations) is the one who later advances `SubmittedToHO`. Editing/auditing is NOT
> rebuilt here — the Elder drops into the existing `/capture/:periodId` and `/audit/:periodId`
> screens via `O` override, where the `SELF_REVIEW_EXCEPTION` engine already fires.

## Tasks

- [ ] 15. Routing & guard infrastructure
  - [ ] 15.1 Add the Elder route under the shared shell in `src/App.tsx`
    - Replace the `/elder` role-dashboard placeholder with `ElderDashboard`, mounted inside the shared `AppShell` container. Wrap in the authenticated guard; the page enforces access in-page via `permissions.ts` (no inline role strings). Reachable per the existing route map (Elder).
    - _Requirements: 6.1, 6.3_
  - [ ] 15.2 Offline resilience short-circuit
    - At the top of `ElderDashboard`, if `!navigator.onLine`, render the offline-unavailable state (consistent with the Auditor screen) instead of an empty or permission-denied view. Online-only slice.
    - _Requirements: 6.2_

- [ ] 16. Context filter navigation (congregation + month scope)
  - [ ] 16.1 Multi-congregation resolver
    - Resolve congregations from `user_congregation_assignments` (`user_id = uid`, `status="active"`) → `congregations` (`id, name, code`) ordered by name. Fallback when empty: `congregations` where `eldership_id = access.hierarchy_id`. Empty result → empty state, load no period data.
    - _Requirements: 6.4, 6.5, 6.6_
  - [ ] 16.2 Month selector with future-block
    - Default to current `YYYY-MM`; on change, reject any month after the current month with a "Cannot select future period" notice (selection unchanged); otherwise reload all tabs for the selected month.
    - _Requirements: 6.7, 6.8, 6.9_
  - [ ] 16.3 Month-scope data load
    - Load `cashbook_period` (`id, congregation_id, week, service, status, created_at`) for `congregation_id IN (congIds)` AND selected `year`/`month`; then `cashbook_line_item` (`id, period_id, section, is_officer, item_type, amount, officer_id, proof_status`) for those period ids (skip query when empty); and active `officers` (`id, officer_code, congregation_id`) for the congregations.
    - _Requirements: 6.10, 6.11_

- [ ] 17. The three functional tabs
  - [ ] 17.1 Governance tab
    - Per-congregation rows: In Progress (`Draft|Rejected`), Awaiting Audit (`Submitted`), Audit Approved (`AuditApproved`), Submitted to Overseer (`SubmittedToOverseer|OverseerApproved|OverseerRejected|SubmittedToHO|HOReviewed`), Last Edit (latest `created_at`), Review action. Compute `totalWeeks` via `oacWeeks` and `capturedWeeks` = distinct `week`. Money via `captureTotals` cash/deposit classifiers split by `is_officer`, plus burial/expenses.
    - _Requirements: 6.12, 6.13, 6.14_
  - [ ] 17.2 Submission Summary (expandable weeks)
    - Per congregation: captured/total weeks badge; Members/Officers/Burial/Expenses totals; Total = `(membersCash+membersDeposit+officersCash+officersDeposit+burial) − expenses`; expand to per-week, per-service (AM/PM) rows with "Not Captured" placeholders for missing weeks `1..totalWeeks`.
    - _Requirements: 6.16_
  - [ ] 17.3 Tithing Review tab (per-priest metrics + cash risk)
    - Per congregation, per active officer: members cash/deposit, priestTotal, officers cash/deposit, officerTotal; congregation subtotals and % splits (vs congregation and eldership totals); expandable per officer. Cash Risk = top-3 priestships by `(membersCash+officersCash)` with `pct` (of eldership total) and `cashPct` (of total cash); eldership Total Cash / Total EFT-Debit / grand total + cash-vs-EFT split.
    - _Requirements: 6.19, 6.20_
  - [ ] 17.4 Risk & Audit tab
    - Query `audit_log` (`user_id, action_type, entity_id, comment, created_at`) where `entity_id IN (periodIds)`, order `created_at` desc, limit 20; resolve actors → role via `user_hierarchy_access` (`status="active"`); resolve period → congregation/week label. Fallback: derive from non-Draft period status transitions when no rows.
    - _Requirements: 6.21, 6.22_

- [ ] 18. Idempotent month-end submission (the only write)
  - [ ] 18.1 Submit gate
    - "Submit All Approved to Overseer" enabled only when `hasPermission(role, "month.submit_to_overseer")` AND every congregation row has `auditApproved > 0 && inProgress === 0 && awaitingAudit === 0`.
    - _Requirements: 6.17_
  - [ ] 18.2 Batch write + audit trace
    - `update cashbook_period set status="SubmittedToOverseer" where congregation_id IN (congIds) and year=? and month=? and status="AuditApproved"` (idempotent: re-run matches nothing). Then `logAuditAction({ actionType:"MONTH_SUBMIT", entityType:"monthly_close", entityId:"{congId}_{year}_{month}", comment:"Month {year}/{month} submitted to Overseer" })` per submitted congregation-month. Never write `SubmittedToHO`/`OverseerApproved`/`HOReviewed`. Reload on success; surface errors inline (no optimistic local flip).
    - _Requirements: 6.18, 6.18a, 6.25_

- [ ] 19. Management overrides (reuse existing capture & audit)
  - [ ] 19.1 Review-week navigation into `/capture/:periodId`
    - Review action loads the congregation's periods (`id, week, service, status`) for the month ordered by `week`; each week row navigates to the existing `/capture/:periodId`. Where the Elder audits, route to `/audit/:periodId`.
    - _Requirements: 6.15, 6.23_
  - [ ] 19.2 Confirm override logging is delegated (no duplication)
    - Verify the `/capture` and `/audit` screens fire `SELF_REVIEW_EXCEPTION` (Req 1.17 / 5.13) for an Elder acting via `O`. The Elder Portal adds NO new override-logging code and does not bypass the shared enforcement point.
    - _Requirements: 6.24_

- [ ] 20. Workspace verification
  - Run `tsc --noEmit` and `vite build`; confirm zero errors/regressions and that no Treasurer/Dexie/sync files changed.
  - _Requirements: 6 (all)_

## Notes (Elder slice)

- Online-only; the sole write is the month-end batch (idempotent, no optimistic `.select()`
  lock needed — unlike the Auditor single-row action). Verification is typecheck + build +
  manual runtime against Supabase.
- Pure-logic surface reuses already-tested helpers (`oacWeeks`, `captureTotals`); optional
  unit checks: governance status-bucketing, submit-gate predicate, cash-risk top-3 ordering.
- Do NOT touch Treasurer PWA files, `captureRepo`, `syncEngine`, or the Dexie schema.
- No Edge Function changes (the submit is a direct RLS-gated update).
- Chairperson slice (next) carries the identical `SubmittedToHO` bug — correct it there too.

## Task Dependency Graph (Elder slice)

```json
{
  "waves": [
    { "id": 0, "tasks": ["15.1", "15.2"] },
    { "id": 1, "tasks": ["16.1", "16.2"] },
    { "id": 2, "tasks": ["16.3"] },
    { "id": 3, "tasks": ["17.1", "17.3", "17.4"] },
    { "id": 4, "tasks": ["17.2", "18.1"] },
    { "id": 5, "tasks": ["18.2", "19.1"] },
    { "id": 6, "tasks": ["19.2"] },
    { "id": 7, "tasks": ["20"] }
  ]
}
```
---

# Implementation Plan — Chairperson Portal Slice (Slice 4)

Scope: the online-only Chairperson Portal (Requirement 6 forward note + Requirement 1 fallback). Direct live Supabase reads for SINGLE congregation; the ONLY write is the month-end batch that advances `AuditApproved` periods to `SubmittedToOverseer` and logs `MONTH_SUBMIT` as fallback when Elder unavailable. NO Dexie, sync engine, or Treasurer/PWA files touched. Reuses `permissions.ts`, `oacWeeks.ts`, and `captureTotals.ts`.

> Accountability note: Chairperson is normally a Priest, subordinate to Elder. Chairperson submits **only up to the Overseer** (`SubmittedToOverseer`) as fallback. Never writes `SubmittedToHO`. Same bug as Elder slice - historical `chairperson/page.tsx` wrote `SubmittedToHO` with no audit log. Corrected to Overseer contract. Editing/auditing delegated to existing `/capture/:periodId` and `/audit/:periodId` via `O` override with `SELF_REVIEW_EXCEPTION`.

## Tasks

- [x] 21. Routing & guard infrastructure
    - [x] 21.1 Add the Chairperson route under the shared shell in `src/App.tsx`
        - Replace the `/chairperson` role-dashboard placeholder with `ChairpersonDashboard`, mounted inside the shared `AppShell` container. Wrap in authenticated guard; in-page enforce via `permissions.ts` (no inline role strings). Online-only.
        - _Requirements: 6.3, 6.26_
    - [x] 21.2 Offline resilience short-circuit
        - At top of `ChairpersonDashboard`, if `!navigator.onLine`, render offline-unavailable state (consistent with Auditor/Elder) instead of empty or permission-denied.
        - _Requirements: 6.2_

- [x] 22. Context filter navigation (single congregation + month scope)
    - [x] 22.1 Single-congregation resolver
        - Resolve congregation from `user_congregation_assignments` (`user_id = uid`, `status=active`) → single `congregations` row (order by name limit 1). Fallback: legacy `eldership_id = access.hierarchy_id` first match. Chairperson is 1 congregation vs Elder many. Empty → empty state, load no period data.
        - _Requirements: 6.4, 6.5, 6.6_
    - [x] 22.2 Month selector with future-block
        - Default to current `YYYY-MM`; reject future month with "Cannot select future period" notice (selection unchanged); reload all tabs on change.
        - _Requirements: 6.7, 6.8, 6.9_
    - [x] 22.3 Month-scope data load
        - Load `cashbook_period` (`id, congregation_id, week, service, status, created_at`) for `congregation_id = resolvedId` AND selected year/month; then `cashbook_line_item` (`id, period_id, section, is_officer, item_type, amount, officer_id, proof_status`) for those periodIds (skip when empty); active `officers` (`id, officer_code, congregation_id`) for congregation.
        - _Requirements: 6.10, 6.11_

- [x] 23. The three functional tabs (single congregation view)
    - [x] 23.1 Governance tab
        - Rows: In Progress (`Draft|Rejected`), Awaiting Audit (`Submitted`), Audit Approved (`AuditApproved`), Submitted to Overseer (`SubmittedToOverseer|OverseerApproved|OverseerRejected|SubmittedToHO|HOReviewed`), Last Edit. Compute `totalWeeks` via `oacWeeks`, `capturedWeeks` distinct week. Money via `captureTotals` classifiers split by `is_officer`, plus burial/expenses. Show fallback notice: "Submitting as fallback - Elder unavailable"
        - _Requirements: 6.12, 6.13, 6.14_
    - [x] 23.2 Submission Summary (expandable weeks)
        - Captured/total weeks badge; Members/Officers/Burial/Expenses totals; Total = `(membersCash+membersDeposit+officersCash+officersDeposit+burial) − expenses`; expand to per-week per-service AM/PM rows with "Not Captured" placeholders for missing weeks 1..totalWeeks.
        - _Requirements: 6.16_
    - [x] 23.3 Tithing Review tab (per-priest metrics + cash risk - single congregation)
        - Per active officer: members cash/deposit, priestTotal, officers cash/deposit, officerTotal; congregation subtotals and % splits; expandable per officer. Cash Risk = top-3 by `(membersCash+officersCash)` with pct of congregation total and cashPct.
        - _Requirements: 6.19, 6.20_
    - [x] 23.4 Risk & Audit tab
        - Query `audit_log` (`user_id, action_type, entity_id, comment, created_at`) where `entity_id IN (periodIds)` order `created_at` desc limit 20; resolve actors → role via `user_hierarchy_access` (`status=active`); resolve period → week label. Fallback: derive from non-Draft status transitions.
        - _Requirements: 6.21, 6.22_

- [x] 24. Idempotent month-end submission (fallback - the only write)
    - [x] 24.1 Submit gate
        - "Submit All Approved to Overseer (Fallback)" enabled only when `hasPermission(role, "month.submit_to_overseer")` AND `auditApproved > 0 && inProgress===0 && awaitingAudit===0`. Show tooltip explaining Elder fallback.
        - _Requirements: 6.17, 6.26_
    - [x] 24.2 Batch write + audit trace
        - `update cashbook_period set status="SubmittedToOverseer" where congregation_id = resolvedId and year=? and month=? and status="AuditApproved"` (idempotent). Then `logAuditAction({ actionType:"MONTH_SUBMIT", entityType:"monthly_close", entityId:"{congId}_{year}_{month}", comment:"Month {year}/{month} submitted to Overseer by Chairperson (Elder fallback)" })`. Never write `SubmittedToHO`/`OverseerApproved`/`HOReviewed`. Reload on success.
        - _Requirements: 6.18, 6.18a, 6.25_

- [x] 25. Management overrides (reuse existing capture & audit)
    - [x] 25.1 Review-week navigation into `/audit/:periodId`
        - Review action loads periods (`id, week, service, status`) for month ordered by week; each week navigates to `/audit/:periodId` (period-addressable, override-aware). Note: `/capture` in Vite is NOT period-addressable, so drill targets audit route which already returns to `/chairperson`. Where edit needed, audit page allows navigation to capture via existing flow.
        - _Requirements: 6.15, 6.23, 6.26_
    - [x] 25.2 Confirm override logging is delegated
        - Verify `/audit` screen fires `SELF_REVIEW_EXCEPTION` for Chairperson acting via `O`. Chairperson Portal adds NO new override-logging.
        - _Requirements: 6.24_

- [x] 26. Workspace verification
    - Run `tsc --noEmit` and `vite build`; confirm zero errors and no Treasurer/Dexie/sync files changed. Verify chairperson fallback comment in audit log.
    - _Requirements: 6 (all)_

## Notes (Chairperson slice)

- Online-only; single congregation vs Elder multi. Same buckets, same submit contract, same override delegation to `/audit/:periodId`. Fallback submitter only.
- No Edge Function changes.
- Do NOT touch Treasurer PWA files.

## Task Dependency Graph (Chairperson slice)

```json
{
  "waves": [
    { "id": 0, "tasks": ["21.1", "21.2"] },
    { "id": 1, "tasks": ["22.1", "22.2"] },
    { "id": 2, "tasks": ["22.3"] },
    { "id": 3, "tasks": ["23.1", "23.3", "23.4"] },
    { "id": 4, "tasks": ["23.2", "24.1"] },
    { "id": 5, "tasks": ["24.2", "25.1"] },
    { "id": 6, "tasks": ["25.2"] },
    { "id": 7, "tasks": ["26"] }
  ]
}

---

# Implementation Plan — Overseer Portal Slice (Slice 5) — Option B

Scope: online-only Overseer Portal (Requirement 7). Direct live Supabase reads across Overseership (multiple elderships/congregations); TWO writes: (1) approve/reject `SubmittedToOverseer -> OverseerApproved/OverseerRejected`, (2) batch submit `OverseerApproved -> SubmittedToHO`. NO Dexie, sync engine, or Treasurer/PWA files touched. Reuses `permissions.ts`, `oacWeeks.ts`, `captureTotals.ts`.

> Accountability note Option B: Overseer is accountable at HO and consolidates multiple congregations. Overseer explicitly approves each congregation-month, can reject with comment, then submits approved months to HO. This is the stage Elder/Chairperson bug was skipping. Edit/audit delegated to existing `/audit/:periodId` via `O` override.

## Tasks

- [x] 27. Routing & guard infrastructure
    - [x] 27.1 Add Overseer route under shared shell in `src/App.tsx`
        - Replace `/overseer` placeholder with `OverseerDashboard` inside AppShell. Wrap in authenticated guard; in-page enforce via `permissions.ts` (overseer.view + overseer.approve + month.submit_to_ho). Online-only.
        - _Requirements: 7.2_
    - [x] 27.2 Offline resilience short-circuit
        - If `!navigator.onLine`, render offline-unavailable state.
        - _Requirements: 7.2_

- [x] 28. Context filter navigation (Overseership scope)
    - [x] 28.1 Overseership resolver
        - Resolve Overseership from `user_hierarchy_access` where role=Overseer, hierarchy_id=Overseership. Then resolve all congregations where `overseership_id = hierarchy_id` OR via `user_congregation_assignments` if HO-assigned override. Also resolve elderships/distinct Elders under this Overseership for grouping. Empty → empty state.
        - _Requirements: 7.1, 7.2_
    - [x] 28.2 Month selector with future-block
        - Default current YYYY-MM; reject future month with notice; reload all tabs on change.
    - [x] 28.3 Month-scope data load
        - Load `cashbook_period` where `congregation_id IN (overseershipCongIds)` AND year/month; then `cashbook_line_item` for periodIds; active `officers` for congregations; `user_hierarchy_access` for Elder/Chairperson roles under Overseership for display.

- [x] 29. Governance tab - consolidated rollup
    - [x] 29.1 Per-Eldership per-Congregation rows
        - Rows: In Progress, Awaiting Audit, Audit Approved, Submitted to Overseer (`SubmittedToOverseer`), Overseer Approved (`OverseerApproved`), Submitted to HO (`SubmittedToHO|HOReviewed`), Overseer Rejected (`OverseerRejected`), Last Edit. Compute totalWeeks via `oacWeeks`, capturedWeeks distinct. Money via `captureTotals`.
        - _Requirements: 7.1_
    - [x] 29.2 Drill-down hierarchy
        - Expand Overseership -> Eldership -> Congregation -> Week -> Service. Each week row navigates to `/audit/:periodId` (period-addressable). Show "Not Captured" placeholders.
    - [x] 29.3 Submission Summary across Overseership
        - Captured/total badge per congregation, totals (Members/Officers/Burial/Expenses), grand total, per-week per-service breakdown. Consolidate Overseership total.

- [x] 30. Overseer approval + submission (two writes - Option B)
    - [x] 30.1 Approval gate - individual congregation
        - For each congregation-month where status=`SubmittedToOverseer`, show Approve/Reject actions. Require `hasPermission(role, "overseer.approve")`. Approve: `update cashbook_period set status="OverseerApproved" where congregation_id=? and year=? and month=? and status="SubmittedToOverseer"` + log `OVERSEER_APPROVE`. Reject requires non-empty comment: `status="OverseerRejected", audit_comment=comment` + log `OVERSEER_REJECT`. Optimistic lock guard `status="SubmittedToOverseer"` - 0 rows = already actioned.
        - _Requirements: 7.1_
    - [x] 30.2 Batch submit to HO
        - "Submit All OverseerApproved to HO" enabled only when every congregation in Overseership has `overseerApproved>0 && inProgress==0 && awaitingAudit==0 && submittedToOverseer==0 && overseerRejected==0` (i.e. all approved, none pending/rejected). Require `hasPermission(role, "month.submit_to_ho")`. Write: `update status="SubmittedToHO" where congregation_id IN (overseershipIds) and year=? and month=? and status="OverseerApproved"` (idempotent). Log `MONTH_SUBMIT_TO_HO` per congregation-month. Never write `HOReviewed` (HO responsibility). Reload on success.
        - _Requirements: 7.1_

- [x] 31. Tithing + Risk & Audit tabs (Overseership consolidation)
    - [x] 31.1 Tithing Review
        - Per congregation per priest cash-vs-deposit, congregation subtotals, eldership subtotals, overseership total, % splits, top-3 cash risk across Overseership.
    - [x] 31.2 Risk & Audit
        - Query `audit_log` where `entity_id IN (periodIds)` limit 50 order desc, resolve actors to roles, include MONTH_SUBMIT, SELF_REVIEW_EXCEPTION, OVERSEER_APPROVE/REJECT, MONTH_SUBMIT_TO_HO. Fallback to status transitions.

- [x] 32. Workspace verification
    - Run `tsc --noEmit` and `vite build`; zero errors, no Treasurer/Dexie/sync files touched. Verify approval uses optimistic lock, submit is idempotent, never writes HOReviewed.
    - _Requirements: 7 (all)_

## Notes (Overseer slice)

- Online-only, multi-congregation multi-eldership. Two writes with optimistic lock on approval. Reuses captureTotals, oacWeeks, permissions.
- No Edge Function.
- Do NOT touch Treasurer PWA files.

## Task Dependency Graph (Overseer slice)

```json
{
  "waves": [
    { "id": 0, "tasks": ["27.1", "27.2"] },
    { "id": 1, "tasks": ["28.1", "28.2"] },
    { "id": 2, "tasks": ["28.3"] },
    { "id": 3, "tasks": ["29.1", "29.3"] },
    { "id": 4, "tasks": ["29.2", "30.1"] },
    { "id": 5, "tasks": ["30.2", "31.1"] },
    { "id": 6, "tasks": ["31.2"] },
    { "id": 7, "tasks": ["32"] }
  ]
}

---

# Implementation Plan — HO Admin Suite Slice (Slice 6) — Option B Final Stage

Scope: online-only HO Review portal (Requirement 11; the Secretary/Census tabs in task 37 draw on Requirements 8 & 9). **District-segregated** — HO sees only the Overseerships / Elderships / Congregations under its assigned district(s) via `ho_district_assignments` (steering invariant #3); an HO with zero district assignments sees no data. Apostle sees its Apostleship's scope. ONE write, **approve-only**: `SubmittedToHO -> HOReviewed` with an optimistic lock and an optional review comment — NO reject branch (Overseers do not submit anything expected to be rejected). Reuses `permissions.ts`, `oacWeeks.ts`, `captureTotals.ts`, and the existing `HO_REVIEW` audit action (no new action types). No Dexie/sync/Treasurer files touched. Closes the accountability chain: `...OverseerApproved -> SubmittedToHO -> HOReviewed` (terminal).

> Accountability note Option B final: HO is last approver before monthly-close. HO can reject back to Overseer with comment, not directly to congregation. All prior slices (Treasurer, Auditor, Elder, Chairperson, Overseer) must be complete.
> HO can complete with comments as well - could be that something needed to be flagged for the Overseer's attention.

## Tasks

- [x] 33. Routing & guard infrastructure (HO)
    - [x] 33.1 Add HO route under shared shell in `src/App.tsx`
        - Mount `HOReview` at canonical `/ho`. Wrap in authenticated guard; page gate via `permissions.ts` (`ho.view`; the approve write is gated on `ho.review` in task 36). Online-only.
        - _Requirements: 11.1, 11.5_
    - [x] 33.2 Offline resilience short-circuit
        - If `!navigator.onLine`, render offline-unavailable state.
        - _Requirements: 11.5_

- [x] 34. HO context resolver (district-segregated scope)
    - [x] 34.1 HO scope resolver (district-segregated)
        - HO: `getHODistrictIds(userId)` → `congregations` where denormalized `district_id IN (assigned districts)`; derive the Overseership/Eldership grouping from the denormalized columns. Zero district assignments → empty state (no data), per invariant #3. Apostle: `congregations` where `apostleship_id = access.hierarchy_id`. (No SuperAdmin role exists — HO/Apostle only.)
        - _Requirements: 11.1, 11.3_
    - [x] 34.2 Month selector with future-block
        - Default current YYYY-MM; reject future month; reload all tabs on change.
    - [x] 34.3 Month-scope data load
        - Load `cashbook_period` where `congregation_id IN (scoped congIds)` AND year/month; then `cashbook_line_item` for periodIds (skip when empty); active `officers`; `user_hierarchy_access` (Overseers/Elders) for display.

- [x] 35. Governance tab - HO consolidated rollup
    - [x] 35.1 Per-Overseership per-Eldership per-Congregation rows
        - Rows: In Progress, Awaiting Audit, Audit Approved, Submitted to Overseer, Overseer Approved, Overseer Rejected, Submitted to HO, HOReviewed, Last Edit. Money via captureTotals. totalWeeks via oacWeeks.
        - _Requirements: 11.1_
    - [x] 35.2 Drill-down hierarchy
        - Expand HO -> Overseership -> Eldership -> Congregation -> Week -> Service. Each week navigates to `/audit/:periodId`. Not Captured placeholders.
    - [x] 35.3 Submission Summary across all Overseerships
        - Captured/total badges, totals Members/Officers/Burial/Expenses, grand total, per-week per-service breakdown. HO grand total.

- [x] 36. HO review approval (final write — approve-only)
    - [x] 36.1 Approval gate - individual congregation-month
        - For status=`SubmittedToHO`, show Approve with an optional review comment (captured in the `HO_REVIEW` audit_log entry — no new `cashbook_period` column, so the write can't fail on a missing column). Require `hasPermission(role, "ho.review")` (new matrix entry, HO="A"). Approve: `update status="HOReviewed" where congregation_id=? and year=? and month=? and status="SubmittedToHO"` + log `HO_REVIEW` (comment in the log). Optimistic lock (`.eq(status,"SubmittedToHO")`) → 0 rows = already actioned. NO reject branch.
        - _Requirements: 11.1, 11.5_
    - [x] 36.2 Batch approve to HOReviewed
        - "Approve All Submitted to HO" enabled only when `submittedToHO>0 && inProgress=awaitingAudit=auditApproved=submittedToOverseer=overseerApproved=overseerRejected=0` (all ready). Require `ho.review`. Idempotent `.eq(status,"SubmittedToHO")` → `HOReviewed`. Log `HO_REVIEW` per congregation-month. Never writes any status before SubmittedToHO; `HOReviewed` is terminal.
        - _Requirements: 11.1, 11.5_

- [x] 37. Secretary role (congregational) + HO Risk & Audit
    - [x] 37.1 SecretaryReview at `/secretary` (congregational scope like Auditor)
        - Resolve congregation_id from user_hierarchy_access. Load last 2 closed months (cashbook_period where status=HOReviewed AND congregation_id=..., order by year/month desc limit 2). If no HOReviewed exists yet, fallback to OverseerApproved or SubmittedToHO for dev.
        - Display: Header Month-over-Month comparison (current closed vs prior), with increase/decrease % and absolute diff highlighted (green up, red down).
        - Weekly summaries: Per week combined AM+PM total (sum of all services that week), no tithing type breakdown. Show week label (Week 1-5), service count, weekly total.
        - Totals per month: Members total, Officers total, Burial total, Expenses total, Grand total. Banking view: Cash vs Deposit/EFT totals if bank data available, else just grand total.
        - No transactional line items (cashbook_line_item) displayed - consolidated only. Read-only, no writes.
        - _Requirements: Secretary role agenda - monthly finance meeting_
    - [x] 37.2 HO Risk & Audit tab (inside HOReview)
        - Risk & Audit as second tab in HOReview: audit_log where entity_id IN (periodIds + monthly_close keys) limit 100 order desc, resolve actors→roles, include MONTH_SUBMIT, OVERSEER_APPROVE/REJECT, MONTH_SUBMIT_TO_HO, HO_REVIEW with comment display, fallback to status transitions.
    - [ ] 37.3 Census placeholder (deferred - not MVP for Secretary)
        - Census tab not needed for Secretary - defer to later slice. Secretary sees tithing totals only.
        
- [x] 38. Workspace verification
    - Run `tsc --noEmit` and `vite build`; zero errors, no Treasurer/Dexie/sync files touched. Verify HO approve uses optimistic lock, batch is idempotent, and writes only `HOReviewed` from `SubmittedToHO` (terminal; no reject branch).
    - _Requirements: 11 (all)_

## Notes (HO slice)

- Online-only, district-segregated scope. Approve-only final write in the Option B chain (`HOReviewed` is terminal). Reuses existing `HO_REVIEW` audit action — no new action types.
- No Edge Function.
- Do NOT touch Treasurer PWA files.

## Task Dependency Graph (HO slice)

```json
{
  "waves": [
    { "id": 0, "tasks": ["33.1", "33.2"] },
    { "id": 1, "tasks": ["34.1", "34.2"] },
    { "id": 2, "tasks": ["34.3"] },
    { "id": 3, "tasks": ["35.1", "35.3"] },
    { "id": 4, "tasks": ["35.2", "36.1"] },
    { "id": 5, "tasks": ["36.2", "37.1"] },
    { "id": 6, "tasks": ["37.2", "37.3"] },
    { "id": 7, "tasks": ["38"] }
  ]
}

# Slice 6.5 complete - Rebuild done, HO admin CRUD restored

# Slice 7(d) - Interim Officer (Pseudo Officer) + HO Dashboard Apostleship-split - MVP Fast

Scope: Interim officers at congregation level, HO queue at Overseership drill-down + Apostleship top grouping for HO dashboard. No bank formats.

- [ ] 39. Interim Officer schema + permissions + git commit rebuild
    - [ ] 39.1 Git commit rebuild: run `git status`, `git diff --stat`, `git add src/App.tsx src/lib/permissions.ts src/ho/ src/review/ src/elder/ src/chairperson/ src/secretary/ src/settings/ .kiro/` and commit `feat: restore all role portals + HO admin CRUD with hamburger menu - rebuild complete (6 slices + 6.5)` - DO THIS FIRST before new code
    - [ ] 39.2 Add officer_status handling: pending_ho_approval, active, inactive. Use existing officers columns if exist (status/service_status) or add is_interim boolean + requested_by + request_reason + requested_at. If migration needed, add via Supabase or use metadata JSONB column.
    - [ ] 39.3 Permissions: officer.interim_add (Treasurer/Chairperson/Overseer = A, HO = V), ho.interim_approve (HO = A)

- [ ] 40. Treasurer/Chairperson interim add flow
    - [ ] 40.1 At treasurer capture (/treasurer or capture component), officer dropdown shows active + pending interim (greyed badge "Pending HO"). Add button "Request Interim Officer" -> modal/form: first_name, last_name, initials, rank (Priest/Underdeacon), congregation (auto), reason text. Creates officer with status=pending_ho_approval, is_interim=true, requested_by=congregation_id.
    - [ ] 40.2 Capture can use interim officers for tithing capture immediately after creation (treated as normal officer but marked interim in reports with *). Show interim badge in weekly summaries.

- [ ] 41. HO Interim approval queue + Apostleship-split dashboard (quick win)
    - [ ] 41.1 Apostleship-split top grouping: In HO dashboard Governance tab, add top tier District -> Apostleship -> Overseership -> Eldership -> Congregation. Currently drill is Overseership->Eldership->Congregation. Add Apostleship grouping from hierarchy_levels where level=Apostleship. Show per Apostleship totals (Members/Officers/Burial/Expenses/Grand) + SubmittedToHO vs HOReviewed counts. Filter dropdown: All Apostleships | specific Apostleship -> filters Overseerships below. This is the district dashboard with values split by Apostleships you requested.
    - [ ] 41.2 HO Interim queue: In HO dashboard, add third tab or section under Governance: "Pending Interim Officers" grouped by Apostleship->Overseership->Congregation, with requester, date, reason, officer details (name, rank). Approve/Reject buttons with comment. Approve sets officer_status=active (is_interim=false or keep interim flag but active), audit log HO_INTERIM_APPROVE. Reject sets inactive + reason HO_INTERIM_REJECT.
    - [ ] 41.3 Display: Interim officers list shows pending count badge in sidebar (e.g., "Dashboard (3 pending interim)")

- [ ] 42. Verification
    - [ ] 42.1 tsc --noEmit PASS, vite build PASS, interim flow: Treasurer request -> HO queue (Apostleship-split dashboard shows pending) -> approve -> officer appears active in capture dropdown
    - [ ] 42.2 No Treasurer Dexie/sync touched except officer dropdown, git diff clean for rebuild commit