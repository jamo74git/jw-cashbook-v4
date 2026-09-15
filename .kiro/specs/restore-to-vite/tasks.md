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
