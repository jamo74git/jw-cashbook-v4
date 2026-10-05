# Implementation Plan: Foundation Slice 7e — Hierarchy, Licensing, UAM & Drift/Security Reconciliation

> **Design signed off Oct 5 — execution approved for Phase A + Phase B against the live
> project `cwdyixafvylzgtpsfmwr`. Supabase dev branch waived** (Pro plan required; tables
> empty, no meaningful data at risk). Migrations are applied via `apply_migration`
> directly against the live project. The design SQL is illustrative of intent; each
> applied migration is reconciled against the real schema before it runs.
>
> Grounded on `docs/drift-report.md` (authoritative description of the live DB), the
> approved `design.md`, and `requirements.md` in this spec directory.

## Overview

Two cleanly separable phases. **Phase A (Drift & Security Hardening)** corrects the type
layer, fixes the sync proof-status literal, repairs the two broken `SECURITY DEFINER`
functions, closes the cashbook RLS hole, scopes the locked census tables, hardens the
definer functions, adds FK covering indexes, and enables leaked-password protection. It
ships first and is foundation-independent. **Phase B (Foundation Structure)** builds on
Phase A: the fixed canonical chain, geo columns, virtual eldership, per-Overseership
licensing, `ho_access_scopes` (superseding `ho_district_assignments`), per-District UAM
with a hard approve-gate, and the new `SUPER_ADMIN` platform tier plus its Edge Functions.

Guiding principle: the database is the authority (RLS + definer functions); the client
permission matrix mirrors it. Phase A re-establishes that truth; Phase B extends it
without weakening the non-negotiable invariants.

**Scope guard:** This plan contains ONLY Phase A (design anchors A1–A8) and Phase B
foundation (B1–B8) work from this spec. It deliberately excludes any Vite/Next migration
work and any hybrid-offline / Sync_Engine architectural work — those live in separate
specs (`restore-to-vite`, `hybrid-offline-architecture`). The only sync touch here is the
single literal proof-status value correction in A8, which changes no sync behaviour.

**Verification gate (every client/type change):** `tsc --noEmit` PASS and `vite build`
PASS, with **no change** to the Dexie Local_Store structure (`src/db/schema.ts`) or
Sync_Engine behaviour/semantics.

## Tasks

### Phase A — Drift & Security Hardening

- [x] 1. Repair `get_my_role()` definer function (A1)
  - Rewrite `public.get_my_role()` as `plpgsql`, `stable`, `security definer`, with pinned
    `set search_path = ''`.
  - Read the caller's role only from `user_hierarchy_access` rows where `status = 'active'`
    AND `start_date <= now()` AND (`end_date IS NULL` OR `end_date >= now()`); never
    reference the non-existent `user_profiles` table.
  - Select the highest privilege rank first via a CASE ladder ordering `SUPER_ADMIN` (9) →
    `HO` (8) → `Apostle` (7) → `Overseer` (6) → `Elder` (5) → `Chairperson` (4) →
    `Treasurer` (3) → `Auditor` (2) → `Secretary` (1); use `start_date DESC` as the
    tiebreaker among equal-rank rows; `limit 1`.
  - Return `null` when no active in-window row exists (fail-closed).
  - Add the in-body `auth.role() = 'anon'` guard that `raise exception ... using errcode =
    '42501'` (permission-denied), never a null/safe return — the second of two layers with
    the `REVOKE EXECUTE FROM anon` in Task 5.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.3, 8.5_

  - [ ]* 1.1 Write property test for role resolution
    - **Property 4: Role resolution is fail-closed**
    - Assert: role returned only from active in-window rows; null otherwise; highest
      privilege rank wins with `start_date DESC` tiebreak among equal-rank rows; no
      reference to a non-existent table.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 20.1**

- [x] 2. Repair `get_my_hierarchy_ids()` definer function (A2)
  - Rewrite `public.get_my_hierarchy_ids()` to never reference the non-existent `hierarchy`
    table; `security definer` with pinned `set search_path = ''`.
  - Resolve the caller's active in-window scope, then return congregation ids by traversing
    **downward** to descendant congregations using the congregations' denormalised
    `overseership_id` / `apostleship_id` / `district_id` columns, plus the direct
    `congregation_id` scope branch.
  - Include the HO explicit-district-assignments branch via `ho_district_assignments` for
    Phase A.
  - Add the design's Phase-B swap note in a SQL comment: once Phase B lands, this branch
    swaps `ho_district_assignments` → `ho_access_scopes` (performed in Task 13, after rows
    are copied).
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 2.1 Write property test for hierarchy resolution
    - **Property 8: Chain integrity (traversal correctness)**
    - Assert: correct downward direction AND correct resulting congregation-id set for each
      scope level (direct / Overseership / Apostleship / District / HO assignments).
    - **Validates: Requirements 5.3, 5.5, 11.6, 11.7**

- [x] 3. Close the cashbook RLS hole (A3)
  - Drop the blanket permissive policies (`USING (true)` / `WITH CHECK (true)`) on
    `cashbook_period` and `cashbook_line_item`.
  - Add scope-gated policies: `cashbook_period` select/write permitted only when
    `congregation_id IN (select public.get_my_hierarchy_ids())`.
  - Add `cashbook_line_item` select/write policies gated via `EXISTS` on the parent
    `cashbook_period`'s `congregation_id` being in `get_my_hierarchy_ids()`; wrap
    `auth.*()` as `(select auth.uid())` per advisor guidance.
  - Leave per-role verb logic (treasurer write, auditor approve, secretary totals-only) in
    `permissions.ts`; RLS enforces scope only.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 3.1 Write property test for cashbook scope isolation
    - **Property 3: Cashbook scope isolation**
    - Assert: no authenticated user can select/modify a cashbook row for a congregation
      outside `get_my_hierarchy_ids()`.
    - **Validates: Requirements 6.2, 6.3, 6.4**

- [x] 4. Add scoped RLS policies to the locked census tables (A4)
  - Keep row-level security enabled on `priest_census` and `priest_census_log` (do NOT
    disable RLS).
  - Add `priest_census` select/write policies scoped by `congregation_id IN (select
    public.get_my_hierarchy_ids())` (organizational assignment, not own-record or role
    alone).
  - Add `priest_census_log` policy gated via `EXISTS` on the parent `priest_census` row's
    `congregation_id` being in `get_my_hierarchy_ids()`.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 4.1 Write property test for census scoping
    - **Property 11: Census tables scoped, not locked**
    - Assert: census tables readable/writable by scoped roles (policies present) and never
      fully locked; RLS remains enabled.
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

- [x] 5. Harden the four SECURITY DEFINER functions (A5)
  - `REVOKE EXECUTE ... FROM anon` on `get_my_role()`, `get_my_hierarchy_ids()`,
    `get_or_create_period(uuid, text, text, uuid)`, and `can_capture_period(uuid)`.
  - Pin `set search_path = ''` on `get_or_create_period` and `can_capture_period` (A1/A2
    already set it on the two rewritten functions).
  - Keep `SECURITY DEFINER` but ensure the bodies re-check caller scope via
    `get_my_hierarchy_ids()` so elevated privilege cannot be abused post-authentication.
  - Document in a comment that the anon hard-block for `get_my_role()` is two-layer: this
    `REVOKE` plus the in-body `auth.role()` guard from Task 1.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 5.1 Write property test for definer lockdown
    - **Property 5: Definer functions locked down**
    - Assert: no `anon` EXECUTE on the four functions; all have pinned `search_path`;
      `get_my_role()` raises permission-denied for an anon caller (defense-in-depth).
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.5**

- [x] 6. Add FK covering indexes and drop only the confirmed duplicate (A6)
  - Create a covering index for each of the 26 unindexed foreign-key columns enumerated
    from the linter output (e.g. `cashbook_line_item.period_id`,
    `cashbook_line_item.officer_id`, `cashbook_attachment.line_item_id`,
    `congregations.overseership_id/apostleship_id/district_id`,
    `user_hierarchy_access.user_id`, `ho_district_assignments.district_id`, …).
  - Drop ONLY the confirmed duplicate `officers` index `idx_officer_code_cong` (duplicate of
    `officers_congregation_id_officer_code_key`).
  - Retain the eight "unused" indexes; defer any drop pending Phase-B query-plan evaluation.
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 7. Enable leaked-password protection (A7) — **BLOCKED / DOCUMENTED (requires Supabase Pro plan)**
  - Leaked-password protection (HaveIBeenPwned check) is a **paid-tier Auth feature** not available
    on the project's current Free tier. **Will be enabled on Pro post-award.** Documented as a known
    limitation per Supabase pricing — this is infrastructure, not code. The advisor finding
    `auth_leaked_password_protection` will persist until it is enabled on Pro.
  - _Requirements: 10.1 (deferred — infra/plan dependency, not a code gap)_

- [ ] 8. Realign `src/lib/types.ts` and correct the Sync_Engine proof literal (A8)
  - [ ] 8.1 Realign `src/lib/types.ts` to the real schema
    - Define `SERVICE_STATUSES` / `ServiceStatus` as exactly the seven real values
      (`Draft`, `Submitted`, `AuditApproved`, `SubmittedToOverseer`, `Rejected`,
      `SubmittedToHO`, `HOReviewed`).
    - Define `PROOF_STATUSES` as exactly `Pending`, `Deposited`, `NA`.
    - Delete the `CashbookService` interface and the fictional columns `service_type`,
      `service_date`, `locked_at`, `service_id`, `income_type`, `proof_image_url`.
    - Redefine `CashbookLineItem` with the real columns (`id`, `period_id`, `section`,
      `officer_id`, `is_officer`, `item_type`, `item_count`, `amount`, `payment_type`,
      `manual_reference`, `receipt_number`, `transaction_date`, `proof_status`,
      `proof_reference`, `approved`).
    - Add the `CashbookPeriod` interface (`id`, `congregation_id`, `year`, `month`, `week`,
      `service`, `status`, …) as the replacement reference for removed `CashbookService`
      usages.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ] 8.2 Correct the Sync_Engine proof-status literal
    - Replace the invalid lowercase `proof_status: "uploaded"` with `"Deposited"` at the
      three write sites in `syncEngine.ts` and the mirrored local `db.lineItems` update.
    - Change the literal value ONLY — no change to Dexie store shape, control flow,
      retry/backoff, conflict detection, or ordering. Leave `PeriodStatus` in
      `src/db/schema.ts` untouched.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 8.3 Run the verification gate
    - Run `tsc --noEmit` (PASS) and `vite build` (PASS) after 8.1/8.2; confirm no Dexie
      structural change and no Sync_Engine behavioural diff.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 8.4 Write property test for verification gate + sync proof value
    - **Property 1: Verification gate holds** and **Property 10: Valid proof-status on sync**
    - Assert: build/typecheck pass with no Dexie/sync semantic diff; every proof write uses
      a valid enum member (never `"uploaded"`).
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.4**

- [ ] 9. Checkpoint — Phase A complete
  - Ensure all tests pass, ask the user if questions arise. Confirm Phase A is deployable on
    its own (types, sync literal, definer functions, RLS, indexes, auth setting) before any
    Phase B work begins.

### Phase B — Foundation Structure

- [ ] 10. Add the `SUPER_ADMIN` role and extend the permission matrix (B1)
  - [ ] 10.1 Add the role and new permission modules
    - Add `SUPER_ADMIN` to `ROLES` in `src/lib/types.ts` (platform tier above HO, scoped to
      `COA_Global`).
    - In `src/lib/permissions.ts` add a `SUPER_ADMIN` column to every existing module key
      and add the new modules: `platform.manage_licenses`, `platform.manage_access_scopes`,
      `platform.manage_super_admins`, `platform.manage_provinces`,
      `platform.manage_districts` (all `M` for `SUPER_ADMIN`, `-` for everyone else);
      `uam.review_submit` (`A` for HO), `uam.review_signoff` (`A` for Apostle),
      `license.view_warning` (`V` for SUPER_ADMIN and HO).
    - Keep `admin.*` at `M` for HO and `-` for `SUPER_ADMIN` (preserve "HO is the only
      admin"); ensure every module key defines a value for all nine roles so
      `Record<Role, PermCode>` compiles.
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 19.1, 19.2, 19.3_

  - [ ] 10.2 Wire routing and the platform route guard
    - Add the `SUPER_ADMIN → "/platform"` case to `getDashboardRoute()`.
    - Add `canEnterPlatform(role) = hasPermission(role, "platform.manage_licenses")` to the
      route guard, routing the decision through `permissions.ts`.
    - When no `SUPER_ADMIN` is assigned / a non-super user hits platform routes, surface an
      explicit forbidden/permission-denied response — never a silent redirect to a dashboard
      or login.
    - _Requirements: 17.7, 17.8, 17.9_

  - [ ]* 10.3 Write property test for permission-matrix completeness and admin disjointness
    - **Property 2: Permission matrix completeness and admin disjointness**
    - Assert: every module key defines all nine roles incl. `SUPER_ADMIN`; `admin.*` is `M`
      for HO and `-` for `SUPER_ADMIN`; `platform.*` is `M` for `SUPER_ADMIN` and `-` for HO.
    - **Validates: Requirements 17.3, 17.4, 17.5, 17.6, 19.1**

- [ ] 11. Create the canonical chain tables, geo columns, and agreement trigger (B2)
  - [ ] 11.1 Create the chain tables and parent FKs
    - Create `coa_global` (single root row expected), `provinces` (required `coa_global_id`),
      and `districts` (required `province_id`, plus UAM params `uam_frequency_months`
      CHECK (3,6), `last_uam_review_at`, `next_uam_review_due_at`).
    - Add `apostleships.district_id` and `overseerships.apostleship_id` parent FKs (reuse the
      existing 0-row tables).
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ] 11.2 Add congregation geo columns
    - Add `congregations.address`, `congregations.country`, `congregations.continent`; keep
      `gps_location` (lng/lat) unchanged.
    - _Requirements: 12.1, 12.2_

  - [ ] 11.3 Create the chain-agreement trigger
    - Create `congregations_chain_agreement()` + a `BEFORE INSERT OR UPDATE` trigger on
      `congregations` that resolves overseership → apostleship → district and rejects writes
      where the denormalised `apostleship_id`/`district_id` disagree with the resolved chain
      (raise with errcode `23514`). Enforced in the DB, not the app layer.
    - _Requirements: 11.6, 11.7_

  - [ ] 11.4 Data-preserving re-point of existing rows
    - Seed one `coa_global`, the required `provinces`/`districts`, link the existing
      `apostleships`/`overseerships`, and re-point the two existing congregations'
      denormalised `district_id`/`apostleship_id`/`overseership_id` to the new typed rows.
      No destructive drop of `congregations`/`officers`/`cashbook_*`.
    - _Requirements: 11.8_

  - [ ]* 11.5 Write property test for chain integrity
    - **Property 8: Chain integrity**
    - Assert: every congregation resolves to exactly one province/district/apostleship/
      overseership; no orphan or cross-level parents; the trigger rejects disagreeing writes.
    - **Validates: Requirements 11.6, 11.7, 5.3, 5.5**

- [ ] 12. Model virtual eldership (B3)
  - Create `elder_assignments` (`elder_user_id`, `congregation_id`, `start_date`, nullable
    `end_date`, `assigned_by`, `reason`) with CHECK (`end_date IS NULL OR end_date >=
    start_date`) and indexes on elder and congregation.
  - Demote `congregations.eldership_id` to a denormalised convenience (not authoritative);
    allow an Elder to hold concurrent assignments across multiple congregations.
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ]* 12.1 Write property test for virtual eldership
    - **Property 9: Eldership is virtual**
    - Assert: eldership never appears as a chain node; Elder→congregation expressed only via
      time-bounded `elder_assignments`; date-window invariant holds.
    - **Validates: Requirements 13.1, 13.2, 13.3**

- [ ] 13. Implement per-Overseership licensing (B4)
  - [ ] 13.1 Create the licensing schema
    - Create `license_status` enum (`Active`/`Expired`/`Suspended`) and `licenses`
      (`overseership_id`, `status`, `max_ho_users`, `term_start`, `term_end`,
      `renewal_due_at`, `auto_renew`, `issued_by`) with CHECK (`term_end > term_start`), a
      partial unique index enforcing one `Active` license per overseership, and an index on
      `overseership_id`.
    - _Requirements: 14.1, 14.2, 14.3, 14.7_

  - [ ] 13.2 Implement the approve-gate and warning predicates
    - Approve-gate (fail-closed): allow HO approve for a congregation **iff** its
      overseership has an `Active` license with `now() <= term_end`; deny write/approve when
      `Expired`/`Suspended` (view allowed).
    - Immediate-deny: when `now() > term_end`, deny HO write/approve immediately in the
      RLS/approve-gate check regardless of the stored `status` label — do NOT wait for a
      background process to flip `status` to `Expired`.
    - Warning banner shown **iff** `status = Active AND 0 <= term_end - now() <= 30 days`.
    - _Requirements: 14.4, 14.5, 14.6, 14.8_

  - [ ]* 13.3 Write property test for licensing approve-gate and warning window
    - **Property 7: Licensing approve-gate and warning window**
    - Assert: approve permitted iff Active and `now() <= term_end`; warning iff within 30
      days of `term_end`; immediate deny when `now() > term_end` regardless of stored label.
    - **Validates: Requirements 14.4, 14.5, 14.6, 14.8**

- [ ] 14. Migrate HO access to `ho_access_scopes` (supersede `ho_district_assignments`) (B5)
  - [ ] 14.1 Create the access-scope schema
    - Create `scope_grain` enum (`District`/`Apostleship`) and `ho_access_scopes`
      (`user_id`, `grain`, nullable `district_id`/`apostleship_id`, `granted_by`) with the
      CHECK that District-grain sets `district_id` only and Apostleship-grain sets
      `apostleship_id` only; index on `user_id`.
    - _Requirements: 15.1, 15.2_

  - [ ] 14.2 Copy, verify, and conditionally retire the legacy table
    - Copy every `ho_district_assignments` row into `ho_access_scopes` as a `District`-grain
      scope.
    - Verify the copy against the source rows (counts + set equality on
      `(user_id, district_id)`) before any removal.
    - ON SUCCESS: drop `ho_district_assignments`.
    - ON FAILURE: retain `ho_district_assignments` (do NOT drop) AND roll back by deleting
      the already-copied `ho_access_scopes` District-grain rows so none are left alongside
      the retained legacy table.
    - _Requirements: 15.3, 15.4, 15.5, 15.6_

  - [ ] 14.3 Swap the definer branch to `ho_access_scopes`
    - Update `get_my_hierarchy_ids()` (from A2) so the HO-assignments branch keys off
      `ho_access_scopes` instead of `ho_district_assignments`, after 14.2 succeeds.
    - _Requirements: 5.4, 15.5_

- [ ] 15. Implement per-District UAM reviews and the hard approve-gate (B6)
  - [ ] 15.1 Create the UAM schema
    - Create `uam_status` (`open`/`submitted`/`signed_off`) and `uam_decision`
      (`keep`/`revoke`/`change`) enums; create `uam_reviews` (`district_id`, `period_start`,
      `period_due`, `status`, `opened_at`, `submitted_by/at`, `signed_off_by/at`) and
      `uam_review_items` (`uam_review_id`, `subject_user_id`, `subject_access_id`,
      `decision`, `note`) with the two supporting indexes.
    - _Requirements: 16.1, 16.9_

  - [ ] 15.2 Implement review lifecycle and due-date advance
    - On submit: set status `submitted`, record submitter. On Apostle-rep sign-off: set
      status `signed_off`, record signer, set `last_uam_review_at = now()` and
      `next_uam_review_due_at = last_uam_review_at + uam_frequency_months`.
    - _Requirements: 16.2, 16.7, 16.8_

  - [ ] 15.3 Implement the hard approve-gate at both layers
    - Create `uam_blocked_for_me()` definer helper (fail-closed) returning true when any
      District in the caller's HO scope is overdue (`now() > next_uam_review_due_at`) or has
      an open review.
    - Wrap the client approve checks (`ho.review`, `month.overseer_approve`,
      `month.submit_to_ho`) in `permissions.ts` with the UAM predicate, AND enforce the gate
      at the RLS/definer layer; deny approve/submit while allowing view.
    - Keep the gate enforced while status is `submitted` — it lifts ONLY on Apostle-rep
      sign-off, never on submission alone.
    - Add a `uam.ts` service exposing `isUamBlocked()` and the login-path blocking banner
      that identifies the due District.
    - _Requirements: 16.3, 16.4, 16.5, 16.6, 16.10_

  - [ ]* 15.4 Write property test for UAM due-date and gate correctness
    - **Property 6: UAM due-date and gate correctness**
    - Assert: `next_due = last + uam_frequency_months` for months ∈ {3,6}; approvals blocked
      iff a District in scope is overdue; view never blocked; gate lifts only on sign-off,
      not on submission.
    - **Validates: Requirements 16.2, 16.3, 16.4, 16.8, 16.10**

- [ ] 16. Create the platform and UAM Edge Functions (B7)
  - [ ] 16.1 Implement `super-admin-write`
    - Reproduce the `admin-write` gate order exactly: service-role key present (else 500) →
      `Authorization: Bearer` (else 401) → `auth.getUser` (else 401) → active
      `user_hierarchy_access` role `SUPER_ADMIN` (else 403) → body validation (else 400) →
      write with the service-role client. Handle writes to `licenses`, `ho_access_scopes`,
      `provinces`, `districts`, and Super Admin appointments. Keep the service-role key
      server-side only.
    - _Requirements: 18.1, 18.2, 18.4, 18.5_

  - [ ] 16.2 Implement `uam-cron`
    - Scheduled function that idempotently flags each District where `now() >
      next_uam_review_due_at`, opening an `open` `uam_reviews` row when none exists; also
      invokable on the HO login path to compute the blocking banner. Service-role key stays
      server-side only.
    - _Requirements: 18.3, 18.4, 18.5_

- [ ] 17. Super Admin bootstrap seed (B8)
  - Seed at least one `SUPER_ADMIN` row in `user_hierarchy_access` with
    `scope_level = 'COA_Global'` as a one-time Phase-B bootstrap (assignable, not a hardcoded
    email). Until seeded, platform writes fail closed and no license can be issued — the
    only identity-creation step, called out for sign-off.
  - _Requirements: 17.2, 17.8, 18.1_

- [ ] 18. Cross-cutting governance and time-bounded fail-closed access
  - Ensure the new tables and gates intersect correctly with the preserved invariants:
    Elder/Chairperson Override (`O`) still logs `SELF_REVIEW_EXCEPTION` (online via
    `logSelfReviewException`, offline queued in Dexie for Sync_Engine flush); Secretary
    Totals-Only (`T`) still hides line-item detail and proof images; the directional status
    flow (`Draft → Submitted → AuditApproved → SubmittedToOverseer → SubmittedToHO →
    HOReviewed`, single `Rejected` state) is preserved and only HO may correct/unlock.
  - Ensure time-bounded access (`status = 'active'` AND within `[start_date, end_date]`) is
    enforced in the online login path, offline reconnect re-validation, and the Edge
    Function gates; any failure sets `access_denied` and signs out/blocks without falling
    through to a dashboard; an HO with zero access scopes is denied login and sees no data;
    the offline PIN session stays provisional with RLS + reconnect re-validation
    authoritative.
  - Route every check through `permissions.ts`; no direct role-string comparisons in
    pages/components.
  - _Requirements: 20.1, 20.2, 20.3, 20.4, 21.1, 21.2, 21.3, 21.4, 19.1, 19.2, 19.3_

- [ ] 19. Final checkpoint — Phase B complete
  - Ensure all tests pass, ask the user if questions arise. Re-run the verification gate for
    all client changes (`tsc --noEmit` PASS, `vite build` PASS) and confirm no Dexie/sync
    behavioural diff beyond the A8 literal correction.

## Notes

- Tasks marked with `*` are optional property/unit tests and can be skipped for a faster
  MVP; they map 1:1 to the design's eleven Correctness Properties.
- Each task cites its design anchor (A1–A8, B1–B8) and the requirement acceptance criteria
  it satisfies.
- Checkpoints (Tasks 9 and 19) provide incremental validation; Task 9 confirms Phase A is
  independently deployable before Phase B begins.
- **Ordering:** Phase A precedes Phase B. Phase B depends on the repaired definer functions
  (A1/A2 → Tasks 1, 2) and the scope-gated cashbook RLS (A3 → Task 3). The UAM and licensing
  gates (B4/B6) build on `get_my_hierarchy_ids()`; Task 14.3 edits the A2 function only after
  the B5 copy succeeds.
- **Execution status (post sign-off, Oct 5):** Tasks 1 and 2 applied via `apply_migration`
  (recorded in Supabase migration history). **Task 3 was applied manually via the Supabase SQL
  editor** because the destructive-statement confirmation would not surface in this environment —
  it is verified live but has **no migration-history entry (history gap to reconcile)**. Task 4
  onward applied via `apply_migration` where the statements are non-destructive; any task with
  `DROP`/`REVOKE` may need the same SQL-editor fallback.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "6", "7"] },
    { "id": 1, "tasks": ["1.1", "2"] },
    { "id": 2, "tasks": ["2.1", "3", "5"] },
    { "id": 3, "tasks": ["3.1", "4", "5.1"] },
    { "id": 4, "tasks": ["4.1", "8.1"] },
    { "id": 5, "tasks": ["8.2"] },
    { "id": 6, "tasks": ["8.3"] },
    { "id": 7, "tasks": ["8.4", "10.1", "11.1"] },
    { "id": 8, "tasks": ["10.2", "11.2", "11.3"] },
    { "id": 9, "tasks": ["10.3", "11.4", "12"] },
    { "id": 10, "tasks": ["11.5", "12.1", "13.1", "14.1"] },
    { "id": 11, "tasks": ["13.2", "14.2"] },
    { "id": 12, "tasks": ["13.3", "14.3", "15.1"] },
    { "id": 13, "tasks": ["15.2"] },
    { "id": 14, "tasks": ["15.3", "16.1", "16.2"] },
    { "id": 15, "tasks": ["15.4", "17"] },
    { "id": 16, "tasks": ["18"] }
  ]
}
```
