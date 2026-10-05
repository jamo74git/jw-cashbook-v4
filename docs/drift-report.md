# OAC Cashbook — Schema Drift & Reality Report

> **Status:** Read-only audit, point-in-time. No schema or code changes were made producing this.
> **Project:** cwdyixafvylzgtpsfmwr (Supabase, prod, **pre-launch** — test data only).
> **Captured:** 2026-10-04 via hosted Supabase MCP (read-only token).
> **Data volume:** congregations 2, officers 10, user_hierarchy_access 10, cashbook_period 10,
> cashbook_line_item 64, hierarchy_levels 8, apostleships 0, overseerships 0.
> Pre-launch test data = **free to restructure**.

This document records the **actual live database** versus what the code and docs assume.
It supersedes the stale "Known Issues" notes in steering until those are reconciled.

---

## 1. Live table inventory (17 tables + 1 view)

Tables the dump/migrations never documented are marked **(undocumented)**.

| Table | Notes |
|-------|-------|
| cashbook_period | Real financial-month grain. year, month, week, service(text), week_key, status(enum) |
| cashbook_line_item | Richer than dump (see section 4) |
| cashbook_attachment | Proof lives here (file_url), + transaction_date, bank_reference, congregation_id |
| congregations | Has gps_location only — **no address/country/continent** |
| hierarchy_levels | Generic self-referential tree (8 rows, one per level + 2 congregations) |
| apostleships **(undocumented)** | Dedicated table, 0 rows. apostleship_level_id, code, name, district_level_id |
| overseerships **(undocumented)** | Dedicated table, 0 rows. overseership_level_id, code, name |
| apostleship_executives **(undocumented)** | Exec assignments: apostleship_id, user_id, exec_name, email, mobile_no, is_active |
| overseership_executives **(undocumented)** | Exec assignments: overseership_id, user_id, executive_role, ... |
| congregation_settings **(undocumented)** | proof_mandatory, allow_chair_submit, expense_approval_threshold, theme_default |
| officers | rank(enum officer_role), service_status(text), initials, mobile_number, start/end_date |
| priest_census / priest_census_log | **RLS enabled, ZERO policies — fully locked** (see section 5) |
| user_hierarchy_access | Access rows: role(text), scope_level(text), status(text), start/end_date |
| ho_district_assignments | HO to district segregation |
| user_congregation_assignments | Multi-congregation elder assignments |
| audit_log | **Singular** (not audit_logs) |
| v_congregation_month_status (view) | total_periods, approved_count, all_approved — **not** v_cashbook_service/v_cashbook_month |

**Hybrid hierarchy reality:** structure is split across hierarchy_levels (generic tree) **AND**
dedicated apostleships / overseerships tables **AND** their *_executives tables. Any
foundation work must reconcile these, not assume a single model.

---

## 2. [CRITICAL] Broken SECURITY DEFINER functions (reference phantom tables)

Confirmed absent: public.hierarchy, public.user_profiles (and profiles).

| Function | References | Problem |
|----------|-----------|---------|
| get_my_hierarchy_ids() | public.hierarchy | Table **does not exist** -> function throws. Also walks descendants (parent_id = h.id), wrong direction for "my congregation ids". |
| get_my_role() | public.user_profiles | Table **does not exist** -> function throws. (Roles actually live in user_hierarchy_access.role.) |

**Blast radius:** these are called inside the role-based RLS on cashbook_period and
cashbook_line_item (treasurer write period, secretary read period/line, elder submit,
auditor update). Those policies cannot evaluate correctly.

---

## 3. [CRITICAL] Cashbook RLS is effectively wide open

Both cashbook_period and cashbook_line_item carry a blanket **Auth all policy with
USING (true) WITH CHECK (true)** for role authenticated, alongside the (broken) role
policies. Because permissive policies are OR'd:

> **Any authenticated user can SELECT/INSERT/UPDATE/DELETE every congregation's periods and
> line items**, regardless of role, congregation scope, or status.

This both masks the broken role policies and is a confidentiality/integrity hole. Must be
closed before licensing/UAM is layered on.

---

## 4. Type-layer fiction (src/lib/types.ts) vs real columns

### 4a. cashbook_period.status enum — real = **7 values**
Draft | Submitted | AuditApproved | SubmittedToOverseer | Rejected | SubmittedToHO | HOReviewed

- src/lib/types.ts ServiceStatus (9 values) is **WRONG**: no PendingAudit, AuditRejected,
  OverseerApproved, OverseerRejected. There is a single Rejected.
- src/db/schema.ts PeriodStatus (4 values) is **WRONG**: missing the Overseer/HO states.
- **Latent failure:** any write of PendingAudit / AuditRejected / OverseerApproved /
  OverseerRejected throws a Postgres enum error. (The dashboards' writes of
  SubmittedToOverseer/SubmittedToHO/HOReviewed are valid and succeed.)

### 4b. proof_status enum — real = **3 values**
Pending | Deposited | NA  (**not** Pending | Uploaded | Deposited)

- src/lib/types.ts PROOF_STATUSES is **WRONG** (Uploaded is not a real value).
- **Latent failure:** src/utils/syncEngine.ts writes proof_status: "uploaded" (lowercase,
  not in enum) -> enum-write error on sync.

### 4c. CashbookService interface is fiction
Columns it declares that **do not exist**: service_type, service_date, locked_at,
service_id, income_type, proof_image_url. Real grain is the financial month
(cashbook_period); AM/PM is the service **text** column. Proof is cashbook_attachment.file_url.

### 4d. cashbook_line_item real shape (richer than dump; no income_type/proof_image_url)
Real: id, period_id, section, officer_id, item_type, item_count, amount, proof_status(enum),
payment_type, manual_reference, receipt_number, is_officer, transaction_date, proof_reference, approved.

---

## 5. Security advisor findings (fix before foundation)

- [CRITICAL] priest_census + priest_census_log: **RLS enabled, 0 policies** -> no API read/write
  possible for member-census data (confirmed relrowsecurity=true, policy_count=0).
- [WARN] get_or_create_period, can_capture_period, get_my_role, get_my_hierarchy_ids:
  SECURITY DEFINER + **executable by anon** -> unauthenticated callers can invoke
  get_or_create_period (creates Draft periods). Revoke anon EXECUTE / set SECURITY INVOKER.
- [WARN] 5 functions have **mutable search_path** (should be pinned, e.g. set search_path='').
- [WARN] Auth **leaked-password protection disabled**.

## 6. Performance advisor findings (scale-time, non-blocking now)

- **26 foreign keys, 0 covering indexes.** (The earlier information_schema FK count of 0 was
  a join artifact; the linter authoritatively reports 26 FKs — all unindexed.)
- cashbook_period / cashbook_line_item: **multiple permissive policies** per role/action
  (the Auth all + role policies overlap — see section 3).
- 20 RLS policies re-evaluate auth.*() per row (wrap as (select auth.uid())).
- Duplicate index on officers (idx_officer_code_cong = officers_congregation_id_officer_code_key).
- 8 unused indexes.

---

## 7. Foundation gap (target tables — none exist yet)

Absent: provinces, districts (dedicated), licenses, ho_access_scopes, elder_assignments,
uam_reviews, coa_global, elderships. "District" exists only as a hierarchy_levels row +
denormalized congregations.district_id. audit_log is singular.

---

## 8. Fix inventory (for the forthcoming foundation spec — NOT yet applied)

1. Rewrite src/lib/types.ts to real DB shape (drop CashbookService fiction; ServiceStatus
   -> 7 real values; PROOF_STATUSES -> Pending|Deposited|NA; real cashbook_line_item shape).
2. Fix syncEngine.ts proof_status casing ("uploaded" -> valid enum value).
3. Repair/replace get_my_role() (read from user_hierarchy_access) and
   get_my_hierarchy_ids() (correct table + traversal direction).
4. Remove/replace the Auth all cashbook policies; make role policies the real gate.
5. Add priest_census / priest_census_log RLS policies (or disable RLS if intentional).
6. Revoke anon EXECUTE on the 4 SECURITY DEFINER functions; pin search_path.
7. Add covering indexes for the 26 FKs; drop duplicate/unused indexes.
8. Enable leaked-password protection.
9. Foundation tables: coa_global, provinces, licensing (licenses per Overseership),
   ho_access_scopes, elder_assignments (virtual tag), uam_reviews; add
   congregations.address/country/continent for the geo dashboard.

> **Verification gate for any type fixes (when applied):** tsc --noEmit PASS and
> vite build PASS, with no changes to the Dexie local store or Sync_Engine behavior.
