# Requirements Document

## Introduction

The OAC Cashbook application was migrated from Next.js to Vite + React + vite-plugin-pwa with an offline-first Dexie layer, WebCrypto PIN auth, a sync engine, and Supabase Edge Functions. The migration preserved the infrastructure but **purged every working role page** (they lived in the Next.js `src/app/...` tree) and rebuilt only a thin capture stub. This spec restores the full working application onto the new stack — reusing the existing offline/auth/sync/edge infrastructure — so no church business rules or screen behavior are lost. All original code is preserved in git commit `f6145ff1` and is the source of truth for historical behavior.

This document is requirements-only. Requirement 1 (Treasurer Capture Flow) is grounded directly in the recovered historical pages. Later role requirements will each be reconfirmed against their `f6145ff1` source during their implementation slice, to avoid a single error-prone pass.

## Scope Decisions (confirmed)

- Drop the legacy `oac/[period]` page entirely.
- Restore `OtpLoginForm` (OTP/magic-link) alongside password + offline PIN auth.
- Expand the `admin-write` Edge Function to cover officer and user create/update/list (replacing the old Next.js `/api/admin/*` routes).
- Sequence: Treasurer Capture first, then Auditor, Elder, Chairperson, Overseer/Apostle review, Secretary reports, Census, Monthly-close, HO admin suite, shared shell/settings.

## Glossary

- **Period**: a `cashbook_period` row keyed by congregation + week_key + service (AM/PM), obtained via the `get_or_create_period` RPC. Holds `status`, `week_key`, `year`, `month`, `week`, `submitted_at`.
- **OAC Week**: church week numbering — Week 1 is the **2nd Sunday** of the month; the final week is the **1st Sunday of the next month**. `week_key` format `YYYY-MM-Wn`.
- **Line Item**: a `cashbook_line_item` row (FK `period_id`) with `section`, `is_officer`, `item_type`, `payment_type`, `amount`, `officer_id`, `receipt_number`, `manual_reference`, `transaction_date`, `proof_status`, `proof_reference`.
- **Attachment**: a `cashbook_attachment` row (FK `line_item_id`) with `file_url`, `transaction_date`, `bank_reference`, `congregation_id`, `uploaded_by`.
- **Section**: Members | Officers | Burial | Expenses.
- **Item type**: EFT | DirectDebit | Cash | CashPending | CashBanked | Burial | Expense.
- **Cash lifecycle**: Cash → CashPending → CashBanked (banked once a deposit proof + date is captured).
- **Proof bucket**: Supabase Storage bucket `cashbook-proofs`.
- **proof_mandatory**: per-congregation toggle in `congregation_settings`.
- **Offline session / Local_Store / Sync_Engine**: existing Dexie + authService + syncEngine infrastructure.

## Requirements

### Requirement 1: Treasurer Capture Flow (offline-first)

**User Story:** As a Treasurer, I want to capture a week's tithing, burial, expenses and banking for a chosen congregation/week/service — online or offline — so that records are entered accurately with proof and dates, balanced, and submitted for audit.

#### Acceptance Criteria

1. THE capture screen SHALL resolve or create a Period via `get_or_create_period` for the user's congregation, the selected `week_key`, and the selected service (AM/PM).
2. THE week selector SHALL list OAC weeks computed as: Week 1 = the 2nd Sunday of the month, subsequent weeks per Sunday, and a final week = the 1st Sunday of the next month, each labelled like `Mar 2024 - Week 1 [09 Mar]`, defaulting to the current OAC week.
3. THE screen SHALL present five tabs — Members, Officers, Burial, Expenses, Banking — each showing its entry count.
4. WHERE the tab is Members or Officers, THE officer picker SHALL list active officers with `rank` in [Priest, Underdeacon], and entries SHALL record `officer_id` with `is_officer` true for Officers and false for Members.
5. THE income types SHALL be limited to EFT, DirectDebit, and Cash; `item_count` SHALL apply only to EFT/DirectDebit and SHALL be NULL for Cash.
6. WHEN adding an EFT or DirectDebit entry, THE screen SHALL require a transaction date (and allow an optional bank reference), and SHALL require a proof upload WHEN `congregation_settings.proof_mandatory` is true.
7. WHEN adding a Burial entry, THE screen SHALL require a receipt number and SHALL set `transaction_date` to today; WHEN adding an Expense entry, THE screen SHALL require a description and allow a user-picked date defaulting to today.
8. THE proof requirement SHALL apply to EFT, DirectDebit, Burial, and Expenses, and proof SHALL be NULL for Cash.
9. WHEN a proof image is attached, THE screen SHALL compress it client-side (resize to ~1920px, ~80% JPEG) before storing/uploading, and SHALL record it in `cashbook_attachment` with `file_url`, `transaction_date`, `bank_reference`, `congregation_id`, and `uploaded_by`, using the `cashbook-proofs` bucket and path `{congId}/{year}/{month}/{service}_{week}/{userId}/{ts}-proof.ext`.
10. THE Cash lifecycle SHALL allow a Cash/CashPending item to be marked CashBanked when a deposit proof and date are captured via the proof modal.
11. THE Banking tab SHALL present a computed view: DirectDebit/EFT/CashBanked subtotals with a BANKING TOTAL, a Cash Pending section (cash income + cash burial), and an Expenses summary — it SHALL NOT be a data-entry tab.
12. THE screen SHALL show running totals (EFT / DirectDebit / Cash cards) and a grand total of (Members + Officers + Burial) − Expenses, and SHALL group Members/Officers entries by officer with expand/collapse and a payment-type breakdown.
13. THE period SHALL be editable only WHEN its status is Draft or Rejected; otherwise all inputs SHALL be locked with a "Submitted for Audit" notice.
14. THE system SHALL NOT allow submission for audit until the period is balanced: Total Income (Members + Officers + Burial) = Banked + Expenses.
15. IF total monthly expenses exceed R500 at submission, THEN THE system SHALL require a requestor comment and an Elder approval comment before allowing submission.
16. WHEN the Treasurer submits, THE system SHALL set the period status to Submitted with `submitted_at` and soft-lock the period.
17. IF an Elder or Chairperson performs capture/submit via an Override (`O`) permission, THEN THE system SHALL log a `SELF_REVIEW_EXCEPTION` to `audit_log`.
18. WHILE offline, THE capture screen SHALL remain fully operable via the Dexie Local_Store (zero network latency), queue proof images as local Blobs, and reconcile all periods, line items, and attachments to Supabase via the existing Sync_Engine when connectivity returns, respecting the directional status flow.
19. THE capture screen SHALL derive all permission decisions (view/create/edit/submit/override) from `permissions.ts`, never from inline role checks.

### Requirement 2: Correct Data-Model Alignment

**User Story:** As a maintainer, I want the app and offline layer to use the real database schema, so that reads/writes and sync actually work against the production Supabase.

#### Acceptance Criteria

1. THE application SHALL read and write `cashbook_period`, `cashbook_line_item`, and `cashbook_attachment` (NOT `cashbook_service`).
2. THE application SHALL resolve periods via the `get_or_create_period` RPC.
3. THE application SHALL store proofs in the `cashbook-proofs` bucket (NOT `proof-images`).
4. THE Dexie Local_Store schema and the Sync_Engine SHALL map local records to `cashbook_period`/`cashbook_line_item`/`cashbook_attachment` and the `cashbook-proofs` bucket.
5. THE application SHALL read the per-congregation `congregation_settings.proof_mandatory` toggle to drive proof enforcement.
6. THE steering "known issue" regarding `cashbook_period` vs `cashbook_service` SHALL be considered resolved once the app standardizes on `cashbook_period`.

### Requirement 3: OTP / Magic-Link Login Restored

**User Story:** As a user whose account uses OTP/magic-link, I want to sign in that way, so that accounts provisioned without passwords can authenticate.

#### Acceptance Criteria

1. THE login screen SHALL offer OTP/magic-link sign-in (restored from `OtpLoginForm`) alongside password login and offline PIN unlock.
2. WHEN OTP login succeeds online, THE app SHALL run the same post-auth chain as password login (active access record, date window, HO district check) and route via `getDashboardRoute`.
3. THE OTP flow SHALL be ported to Vite APIs (react-router navigation, `import.meta.env`, Supabase JS) with no `next/*` imports.
4. WHERE Turnstile is configured, THE OTP flow SHALL verify via the `verify-turnstile` Edge Function consistent with password login.

### Requirement 4: admin-write Edge Function Expansion

**User Story:** As HO, I want officer and user administration to work in the new app, so that the purged admin API routes are fully replaced server-side.

#### Acceptance Criteria

1. THE `admin-write` Edge Function SHALL support actions: create_officer, update_officer, create_user, update_user, list_users (in addition to hierarchy create/update).
2. EACH action SHALL enforce the exact gate: service-role key present (else 500) → Bearer token (else 401) → resolve user (else 401) → active `user_hierarchy_access` role HO (else 403) → validate required body (else 400) → perform the write with the service-role client.
3. THE Edge Function SHALL never expose the service-role key to the client.
4. THE required fields per action SHALL match the original Next.js routes (`create-officer`, `update-officer`, `create-user`, `update-user`, `list-users`), reconfirmed from `f6145ff1`.

### Requirement 5: Auditor Review (online-only) — grounded in f6145ff1

**User Story:** As an Auditor, I want an online dashboard of periods submitted for audit and a detailed review screen where I verify each section against its proofs and approve or reject with commentary, so that only balanced, evidenced periods advance.

#### Acceptance Criteria

**Access & scope**
1. THE audit dashboard and review screen SHALL require `hasPermission(role, "audit.view_queue")`; otherwise render "Access denied. Auditor role required."
2. THE audit views SHALL be **online-only** (read live from Supabase; no Dexie/offline path) and SHALL rely on Supabase RLS to scope data to the auditor's congregation.

**Dashboard (audit list)**
3. THE dashboard SHALL load the auditor's congregation and show a **Pending Audit** count plus a "Services Awaiting Review" list of `cashbook_period` rows where `congregation_id = user's congregation` AND `status = "Submitted"`, ordered by year/month/week descending.
4. THE dashboard SHALL show a **Recent Audit History** list of the last 10 periods with `status IN ("AuditApproved", "Rejected")`.
5. EACH list item SHALL be labelled `"{Mon} {Year} — Week {n} ({AM|PM})"` and link to the detail review at `/audit/{periodId}`.

**Detail review**
6. THE review screen SHALL load the period, its `cashbook_line_item` rows, related `cashbook_attachment` rows, and the congregation's officers, and SHALL present four sections: **Banking Detail** (Direct Debit / EFT / Cash Banked subtotals + BANKING TOTAL), **Cash Pending** (cash income + cash burial + TOTAL CASH), **Burial**, and **Expenses**, plus summary cards (EFT / Direct Debit / Cash) and a Grand Total (Income − Expenses).
7. THE review screen SHALL display officer identity **masked to the officer code only** (never full name).
8. FOR each line item requiring proof, THE screen SHALL show a proof indicator: a green clickable link opening the attachment `file_url` in a new tab when an attachment exists, or a red (missing) indicator otherwise. Bulk-deposited cash items SHALL surface their shared deposit-slip attachment.

**State-change gates**
9. THE Audit Decision panel SHALL appear only WHEN `period.status = "Submitted"` AND the user has `audit.approve` or `audit.reject`.
10. THE panel SHALL present four per-section **"Verified" checkboxes** (Banking, Cash, Burial, Expenses); **Approve SHALL be disabled until all four are checked**.
11. WHEN the auditor approves, THE system SHALL set `cashbook_period.status = "AuditApproved"` and `audit_comment` (defaulting to "Approved"), and SHALL log an `AUDIT_APPROVE` entry to `audit_log`.
12. **Reject SHALL require a non-empty comment**; WHEN the auditor rejects, THE system SHALL set `status = "Rejected"` and `audit_comment = comment`, and SHALL log an `AUDIT_REJECT` entry.
13. IF an Elder or Chairperson performs the approve/reject via an Override (`O`) permission, THEN THE system SHALL confirm and log a `SELF_REVIEW_EXCEPTION` (`assumedRole: "Auditor"`) before the write.
14. AFTER a decision, THE screen SHALL navigate back to the role's dashboard (Elder → /elder, Chairperson → /chairperson, else /audit).

**Concurrency**
15. THE approve/reject write SHALL guard against double-audit by only updating rows still in `status = "Submitted"` (a stale period already actioned SHALL NOT be overwritten).

**Privileged backend**
16. THE audit status changes SHALL be performed as direct RLS-gated Supabase updates (as in the original); NO new Edge Function is required for the auditor slice.

### Requirement 6: Elder & Chairperson Dashboards

**User Story:** As an Elder, I want the month-end submission flow; as a Chairperson, my governance view — so both roles function as before.

#### Acceptance Criteria

1. THE Elder screen SHALL let the Elder select a congregation and, WHEN all weeks for the month are AuditApproved, present a "Submit to HO" action (status → SubmittedToHO).
2. THE Elder/Chairperson SHALL be able to reach the capture view where historically permitted, with any `O` override logged as `SELF_REVIEW_EXCEPTION`.
3. THE Chairperson screen SHALL restore its historical governance view.
4. _Exact behavior SHALL be reconfirmed from `f6145ff1` during implementation._

### Requirement 7: Overseer/Apostle Review (online-only)

**User Story:** As an Overseer or Apostle, I want the consolidated hierarchy review, so I can drill down across my scope.

#### Acceptance Criteria

1. THE review screen SHALL present a consolidated view by hierarchy with drill-down to congregation → week → officer.
2. THE review screen SHALL be online-only and SHALL rely on Supabase RLS for scope.
3. _Exact behavior SHALL be reconfirmed from `f6145ff1` `review/page.tsx`._

### Requirement 8: Secretary Reports (totals-only, online)

**User Story:** As a Secretary, I want month summary reporting without line-item or proof detail, honoring the Totals-Only rule.

#### Acceptance Criteria

1. THE reports screen SHALL produce a month summary (PDF export) with totals only.
2. THE reports screen SHALL hide line-item detail and proof links for the Secretary (Totals-Only `T`).
3. _Exact behavior SHALL be reconfirmed from `f6145ff1` `reports/page.tsx`._

### Requirement 9: Priest Census

**User Story:** As a Priest, I want to capture my own monthly census, so faithfulness KPIs roll up correctly and figures are protected.

#### Acceptance Criteria

1. EACH Priest SHALL capture their own census; the Treasurer SHALL NOT edit Priest census.
2. WHEN a month's cashbook is submitted and AuditApproved, THE census for that month SHALL be locked.
3. EVERY census field change SHALL be logged (who, when, old, new) to the census audit log.
4. THE system SHALL flag staleness: no update in 3 months = Orange, 6 months = Red.
5. THE congregation census total SHALL roll up for the % faithfulness KPI.
6. _Exact fields SHALL be reconfirmed from `f6145ff1` `census/page.tsx` and structure.md._

### Requirement 10: Monthly Close

**User Story:** As Elder/Overseer/HO, I want the monthly-close screen restored, so month progression works.

#### Acceptance Criteria

1. THE monthly-close screen SHALL restore its historical behavior for the permitted roles (Elder, Overseer, HO).
2. _Exact behavior SHALL be reconfirmed from `f6145ff1` `monthly-close/page.tsx`._

### Requirement 11: HO Admin Suite (online-only)

**User Story:** As HO, I want the admin suite restored, so I can manage the organization.

#### Acceptance Criteria

1. THE admin suite SHALL restore: dashboard drill-down (District → Apostleship → Overseership → Congregation), hierarchy management, officer management, congregation management, and user management (list/create/edit/deactivate, assignments).
2. ALL admin management SHALL be HO-only (`M`), enforced by the permission matrix client-side and by the `admin-write` gate server-side.
3. HO data SHALL be district-segregated via `ho_district_assignments`, with RLS filtering.
4. Privileged writes SHALL route through the `admin-write` Edge Function (never a client-side service-role key).
5. _Exact layout and fields SHALL be reconfirmed from `f6145ff1` admin pages during implementation._

### Requirement 12: Shared Shell, Settings, and Legacy Removal

**User Story:** As a user, I want a consistent authenticated shell and settings, without dead legacy pages.

#### Acceptance Criteria

1. THE app SHALL provide a shared authenticated shell (header + sign-out) via a layout route, reused across standard pages.
2. THE settings screen SHALL be restored for the permitted roles.
3. THE legacy `oac/[period]` page SHALL NOT be reintroduced.
4. EACH restored role SHALL land on its `getDashboardRoute` destination, and those routes SHALL exist (no fall-through to /login).

### Requirement 13: Preserved Invariants

**User Story:** As a domain owner, I want all load-bearing invariants preserved across the restoration.

#### Acceptance Criteria

1. ALL access decisions SHALL derive from `permissions.ts` (no inline role comparisons).
2. HO-only admin, Secretary Totals-Only, audited self-review overrides, HO district segregation, time-bounded fail-closed access, the directional service status flow, hierarchy parent-type rules, and Supabase RLS SHALL all be preserved.
3. Online-only screens (admin, review, reports) SHALL render an offline-unavailable state when offline; offline-capable screens (capture) SHALL operate from the Local_Store.
