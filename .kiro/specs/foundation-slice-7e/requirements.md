# Requirements Document

## Introduction

Foundation Slice 7e establishes the organisational, licensing, and governance backbone the
OAC Cashbook needs before go-live, and reconciles the codebase with the **real** database as
captured by the read-only drift audit (`docs/drift-report.md`, live pre-launch project
`cwdyixafvylzgtpsfmwr`, test data only). These requirements are **derived from** the approved
design at `.kiro/specs/foundation-slice-7e/design.md` and are traceable to it.

The work is split into two cleanly separable groups:

- **Phase A — Drift & Security Hardening (ship-first, foundation-independent):** correct the
  type-layer fiction in `src/lib/types.ts`, fix the `syncEngine.ts` proof-status enum casing,
  repair the two broken `SECURITY DEFINER` functions, close the wide-open cashbook RLS hole,
  add RLS policies to the fully-locked census tables, lock down anonymous `EXECUTE` and
  `search_path` on definer functions, add covering indexes for the 26 unindexed foreign keys,
  drop the single confirmed duplicate index, and enable leaked-password protection.
- **Phase B — Foundation Structure (builds on Phase A):** reconcile the hybrid hierarchy into
  one fixed canonical chain, promote District to a first-class table with UAM parameters,
  introduce `provinces`, `coa_global`, geo columns, virtual eldership, per-Overseership
  licensing, `ho_access_scopes` (superseding `ho_district_assignments`), automated per-District
  UAM reviews with a hard approve-gate, and a new `SUPER_ADMIN` platform tier with its Edge
  Functions.

Three previously-open design items are now **stakeholder-signed-off** and are encoded here as
firm acceptance criteria (not options):

1. Sync writes `proof_status = "Deposited"` (never the invalid lowercase `"uploaded"`); the
   `proof_status` enum stays three values (`Pending|Deposited|NA`) for Phase A. Any
   `Uploaded`/`Attached` enum member is **deferred to Phase B**.
2. `ho_access_scopes` **supersedes** `ho_district_assignments`: Phase B copies existing
   `ho_district_assignments` rows into `ho_access_scopes` as District-level scopes, verifies the
   copy, and only then drops the old table.
3. All "unused index" drops are **deferred** except the one confirmed duplicate on `officers`
   (`idx_officer_code_cong`, duplicate of `officers_congregation_id_officer_code_key`). The
   eight "unused" indexes are retained.
4. Eldership is a **virtual, time-bounded tag** via `elder_assignments` only and is **not** a
   node in the fixed chain. The fixed chain is exactly
   `COA_Global → Province → District → Apostleship → Overseership → Congregation`.

> **Scope note:** This is a design/requirements artifact only. It describes intended behaviour.
> Nothing is migrated or executed by this document; all DDL/config referenced in the design is
> illustrative of intent, applied only after sign-off.

## Glossary

- **COA_Global**: The single top-of-church root node (church top-level; **not** abbreviated
  "COF"). Modelled as the `coa_global` table (one row expected) and the `COA_Global`
  `scope_level` used by `SUPER_ADMIN` access rows.
- **Province**: A new **organizational** (not geographic) tier directly beneath COA_Global.
  Modelled as the `provinces` table.
- **District**: Promoted to a first-class `districts` table beneath Province. Carries UAM
  parameters (`uam_frequency_months`, `last_uam_review_at`, `next_uam_review_due_at`).
- **Apostleship**: Organisational tier beneath District (existing `apostleships` table reused,
  with a `district_id` parent FK).
- **Overseership**: Organisational tier beneath Apostleship (existing `overseerships` table
  reused, with an `apostleship_id` parent FK). The grain at which licensing is priced.
- **Congregation**: Leaf of the chain, parented by Overseership via `overseership_id`, with
  denormalised `district_id`/`apostleship_id`/`overseership_id`.
- **Eldership (virtual)**: An Elder's care of one or more congregations, expressed only as a
  **time-bounded tag** in `elder_assignments`. It is **not** a hierarchy node;
  `congregations.eldership_id` is a demoted denormalised convenience, not the authority.
- **UAM (User Access Management review)**: An automated, per-District access-review control.
  While a District in an HO's scope has an overdue or open UAM, that HO's cashbook
  approve/submit actions are hard-gated off (view remains allowed) until an Apostle rep signs
  the review off.
- **Super Admin (`SUPER_ADMIN`)**: A new **platform-operator** tier above HO, scoped to
  `COA_Global`. Assignable (not a hardcoded email) and supports multiple colleagues. Holds `M`
  on new `platform.*` modules; holds `-` on `admin.*`, so "HO is the only admin" is preserved.
- **License**: A per-Overseership entitlement row (`status ∈ {Active, Expired, Suspended}`,
  `term_start`/`term_end`, `renewal_due_at`, `max_ho_users`, `auto_renew`, `issued_by`). Only a
  Super Admin issues/renews it.
- **Access scope (`ho_access_scopes`)**: An HO's authorised scope at District or Apostleship
  grain, granted by a Super Admin. Supersedes `ho_district_assignments`.
- **Period vs Service**: The real financial grain is the **period** (`cashbook_period`: year,
  month, week, status). "AM"/"PM" is the **service** stored as a text column on the period, not
  a separate table. The fictional `CashbookService` interface does not correspond to any real
  table.
- **Definer functions**: The `SECURITY DEFINER` Postgres functions `get_my_role()`,
  `get_my_hierarchy_ids()`, `get_or_create_period()`, `can_capture_period()`.
- **Verification gate**: `tsc --noEmit` PASS and `vite build` PASS after any client/type change,
  with **no change** to the Dexie Local_Store structure or Sync_Engine behaviour/semantics.
- **Permission matrix**: The `Record<Role, PermCode>` table in `src/lib/permissions.ts`; the
  single source of truth for role capability checks.

## Requirements

### Requirement 1: Verification gate for all client/type changes

**User Story:** As a maintainer, I want every TypeScript/code change in this slice to compile
and build cleanly without disturbing offline capture, so that reconciling the type layer never
regresses the field app.

#### Acceptance Criteria

1. WHEN any client or type change in this spec is applied, THE Build_System SHALL complete
   `tsc --noEmit` with no errors.
2. WHEN any client or type change in this spec is applied, THE Build_System SHALL complete
   `vite build` successfully.
3. THE Phase_A_Changes SHALL leave the Dexie Local_Store structure (stores and versioning in
   `src/db/schema.ts`) unchanged.
4. THE Phase_A_Changes SHALL leave Sync_Engine behaviour unchanged except for the single
   literal proof-status value correction defined in Requirement 3.
5. WHERE a change alters Sync_Engine control flow, retry/backoff, conflict detection, or the
   local store shape, THE Phase_A_Changes SHALL exclude that change from scope.

### Requirement 2: Realign `src/lib/types.ts` to the real database shape (Phase A)

**User Story:** As a developer, I want the shared types to match the live database, so that
reads and writes stop throwing latent enum and column errors.

#### Acceptance Criteria

1. THE Type_Layer SHALL define `ServiceStatus` as exactly the seven real values `Draft`,
   `Submitted`, `AuditApproved`, `SubmittedToOverseer`, `Rejected`, `SubmittedToHO`,
   `HOReviewed`.
2. THE Type_Layer SHALL define `PROOF_STATUSES` as exactly the three real values `Pending`,
   `Deposited`, `NA`.
3. THE Type_Layer SHALL remove the `CashbookService` interface and the fictional columns
   `service_type`, `service_date`, `locked_at`, `service_id`, `income_type`, and
   `proof_image_url`.
4. THE Type_Layer SHALL define `CashbookLineItem` with the real columns `id`, `period_id`,
   `section`, `officer_id`, `is_officer`, `item_type`, `item_count`, `amount`, `payment_type`,
   `manual_reference`, `receipt_number`, `transaction_date`, `proof_status`, `proof_reference`,
   and `approved`.
5. THE Type_Layer SHALL define a `CashbookPeriod` interface keyed on the financial-month grain
   (`id`, `congregation_id`, `year`, `month`, `week`, `service`, `status`) to replace reporting
   references to the removed `CashbookService` type.
6. WHERE existing code referenced the removed `CashbookService` type, THE Type_Layer SHALL
   provide `CashbookPeriod` as the replacement reference.

### Requirement 3: Correct the Sync_Engine proof-status value (Phase A)

**User Story:** As a field user, I want proof uploads to sync without errors, so that captured
proof reaches Supabase on reconnect.

#### Acceptance Criteria

1. WHEN the Sync_Engine writes a proof status during sync, THE Sync_Engine SHALL write a valid
   `proof_status` enum member and SHALL use the value `Deposited`.
2. THE Sync_Engine SHALL NOT write the invalid lowercase value `uploaded` at any proof write
   site.
3. THE Sync_Engine SHALL apply the corrected value at the three write sites and the mirrored
   local `db.lineItems` update identified in the design.
4. WHERE a new `Uploaded` or `Attached` enum member is desired, THE Phase_A_Changes SHALL defer
   that enum change to Phase B and SHALL keep the Phase A enum at three values.

### Requirement 4: Repair `get_my_role()` to read real role data (Phase A)

**User Story:** As a security owner, I want role resolution to read the real role source and
fail closed, so that RLS policies depending on it evaluate correctly.

#### Acceptance Criteria

1. THE Role_Resolution_Function SHALL read the caller's role from `user_hierarchy_access`.
2. THE Role_Resolution_Function SHALL NOT reference the non-existent `user_profiles` table.
3. WHEN resolving a role, THE Role_Resolution_Function SHALL return a role only from a row where
   `status = 'active'` AND `start_date <= now()` AND (`end_date IS NULL` OR `end_date >= now()`).
4. IF no active, in-window access row exists for the caller, THEN THE Role_Resolution_Function
   SHALL return null.
5. WHEN multiple active in-window rows exist, THE Role_Resolution_Function SHALL return the role
   with the highest privilege rank, where the privilege rank orders the role set from
   `SUPER_ADMIN` (highest) down through `HO`, `Apostle`, `Overseer`, `Elder`, `Chairperson`,
   `Treasurer`, `Auditor`, to `Secretary` (lowest).
6. WHEN multiple active in-window rows share the same highest privilege rank, THE
   Role_Resolution_Function SHALL select a deterministic primary row by ordering on `start_date`
   descending as the tiebreaker.

### Requirement 5: Repair `get_my_hierarchy_ids()` to use real tables and correct traversal (Phase A)

**User Story:** As a security owner, I want the congregation-id resolver to use the real chain
and traverse in the correct direction, so that scope checks return the right congregations.

#### Acceptance Criteria

1. THE Hierarchy_Resolution_Function SHALL NOT reference the non-existent `hierarchy` table.
2. WHEN the caller has a direct `congregation_id` scope, THE Hierarchy_Resolution_Function SHALL
   return that congregation id.
3. WHEN the caller's scope is `Overseership`, `Apostleship`, or `District`, THE
   Hierarchy_Resolution_Function SHALL return the congregation ids at or under that scope using
   the congregations' denormalised `overseership_id`/`apostleship_id`/`district_id` columns.
4. WHEN the caller holds explicit HO district assignments, THE Hierarchy_Resolution_Function
   SHALL include the congregations in those districts.
5. THE Hierarchy_Resolution_Function SHALL traverse from the caller's scope downward to
   descendant congregations AND SHALL return exactly the set of descendant congregation ids that
   are correct for the caller's scope, so that the requirement is satisfied only when both the
   traversal direction is correct AND the resulting congregation ids are correct.
6. WHERE the live data carries a legacy `Eldership` `scope_level` during Phase A, THE
   Hierarchy_Resolution_Function SHALL resolve those callers' congregations via the
   denormalised `congregations.eldership_id` as a transitional branch, AND THE
   Phase_B_Changes SHALL remove this branch when eldership becomes virtual via
   `elder_assignments` (Requirement 13).

### Requirement 6: Close the wide-open cashbook RLS hole (Phase A)

**User Story:** As a security owner, I want cashbook rows gated by scope, so that no
authenticated user can read or modify another congregation's financial data.

#### Acceptance Criteria

1. THE Cashbook_RLS SHALL remove the blanket permissive policies that use `USING (true)` and
   `WITH CHECK (true)` on `cashbook_period` and `cashbook_line_item`.
2. WHEN an authenticated user selects or modifies a `cashbook_period` row, THE Cashbook_RLS
   SHALL permit the operation only if the row's `congregation_id` is in
   `get_my_hierarchy_ids()`.
3. WHEN an authenticated user selects or modifies a `cashbook_line_item` row, THE Cashbook_RLS
   SHALL permit the operation only if the parent period's `congregation_id` is in
   `get_my_hierarchy_ids()`.
4. IF a congregation is outside the caller's `get_my_hierarchy_ids()`, THEN THE Cashbook_RLS
   SHALL deny select and modify operations on that congregation's cashbook rows.
5. THE Cashbook_RLS SHALL leave per-role verb logic (treasurer write, auditor approve,
   secretary totals-only) enforced in `permissions.ts` while enforcing scope at the RLS layer.

### Requirement 7: Add RLS policies to the locked census tables (Phase A)

**User Story:** As a security owner, I want member-census tables to be scoped-readable rather
than fully locked, so that authorised roles can access census data while others cannot.

#### Acceptance Criteria

1. THE Census_RLS SHALL add scoped policies to `priest_census` and `priest_census_log` while
   keeping row-level security enabled.
2. WHEN an authenticated user accesses `priest_census`, THE Census_RLS SHALL scope access by the
   user's organizational assignment, permitting the operation only if the row's
   `congregation_id` is in `get_my_hierarchy_ids()` (membership in the congregations the user is
   assigned to), and SHALL NOT scope by own-record ownership or role alone.
3. WHEN an authenticated user accesses `priest_census_log`, THE Census_RLS SHALL permit the
   operation only if the parent census row's `congregation_id` is in `get_my_hierarchy_ids()`.
4. THE Census_RLS SHALL NOT disable row-level security on either census table.

### Requirement 8: Lock down the SECURITY DEFINER functions (Phase A)

**User Story:** As a security owner, I want definer functions hardened, so that anonymous
callers cannot invoke them and their search path cannot be hijacked.

#### Acceptance Criteria

1. THE Definer_Hardening SHALL revoke `EXECUTE` from the `anon` role on `get_my_role()`,
   `get_my_hierarchy_ids()`, `get_or_create_period()`, and `can_capture_period()`.
2. THE Definer_Hardening SHALL set a pinned empty `search_path` on all four definer functions.
3. IF an anonymous caller invokes any of the four definer functions after hardening, THEN THE
   Definer_Hardening SHALL hard-block the call with a permission-denied error and SHALL NOT allow
   the function to execute with a restricted or safe result, where the hard-block is achieved by
   BOTH (a) revoking `EXECUTE` from the `anon` role per criterion 8.1 AND (b) an in-body
   `auth.role()` check.
4. WHERE a definer function retains `SECURITY DEFINER`, THE Definer_Hardening SHALL re-check the
   caller's scope via `get_my_hierarchy_ids()` so the elevated privilege cannot be abused after
   authentication.
5. WHEN `get_my_role()` is invoked, THE Role_Resolution_Function SHALL check `auth.role()` and
   SHALL raise a permission-denied error (not return null or a safe value) if the caller's
   `auth.role()` is `anon`, providing defense-in-depth beyond the `EXECUTE` revoke.

### Requirement 9: Add FK covering indexes and drop only the confirmed duplicate (Phase A)

**User Story:** As a performance owner, I want the 26 unindexed foreign keys covered and only
the confirmed redundant index removed, so that joins scale without accidentally dropping an
index a new reader will need.

#### Acceptance Criteria

1. THE Index_Changes SHALL add a covering index for each of the 26 unindexed foreign-key
   columns identified by the linter.
2. THE Index_Changes SHALL drop the confirmed duplicate `officers` index `idx_officer_code_cong`
   (duplicate of `officers_congregation_id_officer_code_key`).
3. THE Index_Changes SHALL retain the eight "unused" indexes rather than dropping them, where the
   confirmed duplicate `idx_officer_code_cong` is a separate ninth unused index, so that after
   dropping that duplicate the eight retained unused indexes remain untouched.
4. WHERE an index is reported "unused" and is not the confirmed duplicate, THE Index_Changes
   SHALL defer any drop pending Phase-B query-plan evaluation.

### Requirement 10: Enable leaked-password protection (Phase A)

**User Story:** As a security owner, I want leaked-password protection enabled, so that
compromised passwords are rejected at sign-up and change.

#### Acceptance Criteria

1. THE Auth_Settings SHALL enable leaked-password protection in Supabase Auth.

### Requirement 11: Establish the fixed canonical hierarchy chain (Phase B)

**User Story:** As a platform owner, I want one fixed, typed hierarchy chain, so that scope
resolution and reporting are correct and unambiguous.

#### Acceptance Criteria

1. THE Hierarchy_Chain SHALL be exactly `COA_Global → Province → District → Apostleship →
   Overseership → Congregation`.
2. THE Hierarchy_Chain SHALL introduce the `coa_global` table expecting a single root row.
3. THE Hierarchy_Chain SHALL introduce the `provinces` table as an organizational tier with a
   required `coa_global_id` parent reference.
4. THE Hierarchy_Chain SHALL promote District to a first-class `districts` table with a required
   `province_id` parent reference.
5. THE Hierarchy_Chain SHALL add a required `district_id` parent reference to `apostleships` and
   a required `apostleship_id` parent reference to `overseerships`.
6. WHEN a congregation's denormalised `district_id` or `apostleship_id` is written, THE
   Hierarchy_Chain SHALL enforce via a BEFORE INSERT OR UPDATE database trigger on
   `congregations` that the written value agrees with the parent chain resolved through
   `overseership_id`, AND SHALL reject the write at the trigger if the value does not agree.
7. THE Hierarchy_Chain SHALL ensure every congregation resolves to exactly one province, one
   district, one apostleship, and one overseership with no orphan or cross-level parents.
8. THE Hierarchy_Chain SHALL retain existing congregation, officer, and cashbook rows,
   re-pointing the denormalised congregation `*_id` columns to the new typed rows without
   destructive drops.

### Requirement 12: Add congregation geo columns for the Slice 9 dashboard foundation (Phase B)

**User Story:** As a future dashboard consumer, I want geographic attributes on congregations,
so that the COA_Global dashboard can map and filter by country/continent.

#### Acceptance Criteria

1. THE Congregations_Table SHALL add the `address`, `country`, and `continent` columns.
2. THE Congregations_Table SHALL retain the existing `gps_location` (lng/lat) column unchanged.

### Requirement 13: Model eldership as a virtual time-bounded tag (Phase B)

**User Story:** As a platform owner, I want eldership modelled as a time-bounded assignment, so
that an Elder's changing congregation coverage never forces structural hierarchy churn.

#### Acceptance Criteria

1. THE Eldership_Model SHALL express an Elder's coverage only through the `elder_assignments`
   table linking an Elder user to a congregation for a date window.
2. THE Eldership_Model SHALL NOT represent eldership as a node in the fixed hierarchy chain.
3. WHEN an `elder_assignments` row is created, THE Eldership_Model SHALL require
   `end_date IS NULL` OR `end_date >= start_date`.
4. THE Eldership_Model SHALL allow an Elder to hold concurrent assignments across multiple
   congregations.
5. THE Eldership_Model SHALL treat `congregations.eldership_id` as a demoted denormalised
   convenience and SHALL treat `elder_assignments` as the authority.

### Requirement 14: Per-Overseership licensing (Phase B)

**User Story:** As a Super Admin, I want built-in licensing priced per Overseership, so that HO
capability is entitlement-gated and renewals are visible in advance.

#### Acceptance Criteria

1. THE Licensing_Model SHALL store a license per `overseership_id` with `status ∈ {Active,
   Expired, Suspended}`, `term_start`, `term_end`, `renewal_due_at`, `max_ho_users`,
   `auto_renew`, and `issued_by`.
2. THE Licensing_Model SHALL permit at most one `Active` license per overseership.
3. THE Licensing_Model SHALL require `term_end > term_start`.
4. WHEN a congregation's overseership license is `Active` AND `now() <= term_end`, THE
   Licensing_Model SHALL permit HO approve actions for that congregation.
5. IF a congregation's overseership license is `Expired` or `Suspended`, THEN THE
   Licensing_Model SHALL deny HO write and approve actions for that congregation while leaving
   view allowed.
6. WHILE a license is `Active` AND `term_end - now()` is within 30 days AND `term_end > now()`,
   THE Licensing_Model SHALL show HO a renewal warning banner.
7. THE Licensing_Model SHALL permit only a Super Admin to issue or renew a license.
8. IF `now() > term_end` for a congregation's overseership license, THEN THE Licensing_Model
   SHALL immediately deny HO write and approve actions for that congregation regardless of the
   stored `status` label and without waiting for a background process to set `status` to
   `Expired`.

### Requirement 15: HO access scopes supersede HO district assignments (Phase B)

**User Story:** As a Super Admin, I want HO access expressed as District/Apostleship scopes in a
single source, so that segregation is granted consistently and the legacy table is retired
safely.

#### Acceptance Criteria

1. THE Access_Scope_Model SHALL store `ho_access_scopes` rows at `District` or `Apostleship`
   grain, each granted by a Super Admin.
2. WHEN a scope row has grain `District`, THE Access_Scope_Model SHALL require `district_id`
   set and `apostleship_id` null; WHEN grain is `Apostleship`, THE Access_Scope_Model SHALL
   require `apostleship_id` set and `district_id` null.
3. THE Access_Scope_Migration SHALL copy every existing `ho_district_assignments` row into
   `ho_access_scopes` as a `District`-grain scope.
4. WHEN the copy completes, THE Access_Scope_Migration SHALL verify the copied scopes against
   the source `ho_district_assignments` rows before any removal.
5. WHEN verification succeeds, THE Access_Scope_Migration SHALL drop the `ho_district_assignments`
   table.
6. IF verification fails, THEN THE Access_Scope_Migration SHALL retain the
   `ho_district_assignments` table, SHALL NOT drop it, AND SHALL roll back and delete the
   already-copied `ho_access_scopes` rows so that no copied rows are left in place alongside the
   retained table.

### Requirement 16: Automated per-District UAM review with a hard approve-gate (Phase B)

**User Story:** As a governance owner, I want automated per-District access reviews that block
HO approvals until signed off, so that stale access is caught on a schedule.

#### Acceptance Criteria

1. THE District_Model SHALL carry `uam_frequency_months` (3 or 6), `last_uam_review_at`, and
   `next_uam_review_due_at`.
2. WHEN a review is signed off, THE UAM_Model SHALL set `last_uam_review_at = now()` and
   `next_uam_review_due_at = last_uam_review_at + uam_frequency_months`.
3. WHILE a District in an HO's scope is overdue (`now() > next_uam_review_due_at`) or has an open
   review, THE UAM_Model SHALL deny that HO's `ho.review` and `month.*` approve/submit actions
   for congregations in that District.
4. WHILE a District in an HO's scope is overdue or has an open review, THE UAM_Model SHALL
   permit that HO to view data.
5. THE UAM_Model SHALL enforce the approve-gate at both the permission layer and the
   RLS/definer layer, failing closed on any error.
6. WHEN an HO logs in and a District in scope is due, THE UAM_Model SHALL present a blocking
   banner identifying the District.
7. WHEN a District HO submits a review, THE UAM_Model SHALL set its status to `submitted`
   recording the submitter.
8. WHEN an Apostle representative signs a submitted review off, THE UAM_Model SHALL set its
   status to `signed_off`, advance the District due-date, and lift the approve-gate.
9. THE UAM_Model SHALL record per-user review decisions of `keep`, `revoke`, or `change`.
10. WHILE a District's review status is `submitted` and not yet `signed_off`, THE UAM_Model SHALL
    keep the approve-gate enforced for that District, so that submission alone does not lift the
    gate and the gate is lifted only on Apostle-representative sign-off per criterion 8.

### Requirement 17: Introduce the SUPER_ADMIN platform tier without weakening "HO is the only admin" (Phase B)

**User Story:** As a platform owner, I want a Super Admin tier for platform concerns that HO
must never touch, so that platform operations are separated from congregation administration.

#### Acceptance Criteria

1. THE Role_Model SHALL add `SUPER_ADMIN` as a role scoped to `COA_Global`.
2. THE Role_Model SHALL make `SUPER_ADMIN` assignable via a `user_hierarchy_access` row (not a
   hardcoded email) and SHALL support multiple concurrent Super Admin colleagues.
3. THE Permission_Matrix SHALL grant `SUPER_ADMIN` the code `M` on `platform.manage_licenses`,
   `platform.manage_access_scopes`, `platform.manage_super_admins`, `platform.manage_provinces`,
   and `platform.manage_districts`.
4. THE Permission_Matrix SHALL set the `platform.*` modules to `-` for HO and all other roles.
5. THE Permission_Matrix SHALL keep the `admin.*` modules at `M` for HO and `-` for
   `SUPER_ADMIN`.
6. THE Permission_Matrix SHALL define a value for every one of the nine roles (including
   `SUPER_ADMIN`) on every module key.
7. WHEN a Super Admin signs in, THE Routing SHALL resolve the dashboard route to `/platform` and
   the route guard SHALL gate platform entry through `permissions.ts`.
8. IF no `SUPER_ADMIN` row is assigned, THEN THE Role_Model SHALL fail closed so that no
   platform write succeeds until a Super Admin is bootstrapped, AND SHALL surface an explicit
   forbidden/permission-denied response rather than silently redirecting the user.
9. IF no `SUPER_ADMIN` row is assigned AND a user attempts to access platform-tier functions,
   THEN THE Role_Model SHALL deny the attempt with an explicit forbidden/permission-denied
   response shown to the user AND SHALL NOT silently redirect the user (for example to a
   dashboard or login).

### Requirement 18: Platform and UAM Edge Functions reproduce the admin-write gate (Phase B)

**User Story:** As a security owner, I want privileged platform writes and the UAM scheduler to
reproduce the admin-write gate exactly, so that the service-role key is never exposed and every
privileged path fails closed.

#### Acceptance Criteria

1. THE Super_Admin_Write_Function SHALL enforce the gate order: service-role key present (else
   500) → `Authorization: Bearer` present (else 401) → `auth.getUser` success (else 401) →
   active `user_hierarchy_access` role `SUPER_ADMIN` (else 403) → body validation (else 400) →
   write with the service-role client.
2. THE Super_Admin_Write_Function SHALL handle writes to `licenses`, `ho_access_scopes`,
   `provinces`, `districts`, and Super Admin appointments.
3. THE UAM_Cron_Function SHALL idempotently flag each District where
   `now() > next_uam_review_due_at`, opening an `open` review when none exists.
4. THE Edge_Functions SHALL keep the service-role key server-side only and SHALL NOT expose it
   to the client bundle.
5. IF any gate step fails, THEN THE Edge_Functions SHALL deny the write and fail closed.

### Requirement 19: Permission checks route only through the permission matrix

**User Story:** As a maintainer, I want all capability checks routed through `permissions.ts`,
so that there is a single source of truth and no hardcoded role strings leak into pages.

#### Acceptance Criteria

1. THE Permission_Gate SHALL route every capability check through `permissions.ts`
   (`hasPermission`, `getPermission`, `isTotalsOnly`, `isOverrideAction`).
2. THE Application SHALL NOT compare role strings directly in pages or components.
3. THE Permission_Gate SHALL apply in the client route guard, in components, and within an
   offline session using the cached role fed to the matrix.

### Requirement 20: Access is time-bounded and enforced everywhere, fail-closed

**User Story:** As a security owner, I want access windows enforced consistently and every auth
failure to fail closed, so that revoked or expired users are reliably cut off.

#### Acceptance Criteria

1. THE Access_Control SHALL require `status = 'active'` AND the current time within
   `[start_date, end_date]` for access to be granted, enforcing this unconditionally at all
   times and independently of whether an access evaluation is currently occurring in the online
   login path, the offline reconnect re-validation, or an Edge Function gate.
2. IF any step in the login, unlock, or re-validation chain fails, THEN THE Access_Control SHALL
   set `access_denied` and SHALL NOT set `login_denied` (which is specific to the login path),
   and SHALL sign the user out or block without falling through to a dashboard.
3. WHILE an HO has zero access scopes, THE Access_Control SHALL deny login and expose no data.
4. THE Access_Control SHALL treat the offline PIN session as provisional, with Supabase RLS and
   reconnect re-validation remaining authoritative.

### Requirement 21: Governance and role-view invariants preserved

**User Story:** As a governance owner, I want the established cashbook invariants preserved, so
that overrides are audited, Secretary sees totals only, and status transitions stay directional.

#### Acceptance Criteria

1. WHEN an Elder or Chairperson uses an Override (`O`) permission, THE Audit_System SHALL log a
   `SELF_REVIEW_EXCEPTION`, online via `logSelfReviewException` and offline queued in Dexie for
   Sync_Engine flush.
2. WHERE a role holds a Totals-Only (`T`) permission, THE UI SHALL hide line-item detail and
   proof images.
3. THE Status_Flow SHALL enforce the directional transition `Draft → Submitted → AuditApproved
   → SubmittedToOverseer → SubmittedToHO → HOReviewed`, with `Rejected` as the single rejection
   state.
4. THE Status_Flow SHALL permit only HO to raise corrections or unlock a month.
