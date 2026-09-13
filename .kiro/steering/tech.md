---
inclusion: always
---

# OAC Cashbook — Technical Architecture & Invariants

> Extracted from the existing Next.js codebase (HO dashboard drill-down, hierarchy
> management, Turnstile hardening) and canonical type/permission definitions.
> This documents CURRENT behavior. Do not silently "fix" logic recorded here;
> known defects are called out explicitly under "Known Issues".

## Stack

- Next.js 15.5 (App Router), React, TypeScript
- Supabase (Postgres + Auth + RLS + Storage)
- Client auth via `@/lib/supabase/client`; SSR/middleware via `@supabase/ssr`
- Privileged server routes use `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS
- Cloudflare Turnstile for login bot protection
- Deployed on Vercel

## Roles (canonical, from src/lib/types.ts)

`HO, Apostle, Overseer, Elder, Chairperson, Treasurer, Auditor, Secretary`

Roles are NEVER hardcoded in pages/components. All checks go through
`@/lib/permissions.ts` (permission matrix derived from permission_matrix_v3.txt).

## Hierarchy Model (canonical levels)

`Conference > Apostolate > District > Apostleship > Overseership > Eldership > Congregation`

The `hierarchy_levels` table is self-referential via `parent_id`. Managed levels
in the Hierarchy Management UI are strictly: **District, Apostleship, Overseership**
(constant `LEVEL_ORDER`).

### Parent-assignment invariants (hierarchy management)
- **District**: has NO parent (parent_id null; conceptually under Conference).
- **Apostleship**: parent MUST be a District.
- **Overseership**: parent MUST be an Apostleship.
- Non-District nodes REQUIRE a parent selection; creation is rejected client-side
  ("Please select a parent") and `name`/`code` are required.
- Congregations attach to an Overseership via `congregations.overseership_id`, and
  also carry denormalized `eldership_id`, `apostleship_id`, `district_id`.

## Permission Codes (from types.ts / permissions.ts)

`V`=View, `C`=Create, `E`=Edit, `A`=Approve, `S`=Submit, `X`=Export, `M`=Manage,
`O`=Override, `R`=Reply, `T`=Totals-Only (Secretary), `-`=No access.

- `hasPermission` = code is anything except `-`.
- `T` (Totals-Only) means the UI MUST hide line-item detail and proof images.
  Applies to Secretary on capture.view / banking.view / census.view.
- `O` (Override) is a Chairperson/Elder self-review exception and MUST be logged via
  `logSelfReviewException` -> `audit_log` with `action_type = SELF_REVIEW_EXCEPTION`.
- Admin management functions (users, congregations, officers, bulk import, audit logs)
  are `M` for **HO only**; every other role is `-`.
- Expense approval over 500 (`expenses.approve_over_500`) is `A` for **Elder only**.

## Role -> Dashboard Route (getDashboardRoute)

- HO -> /admin
- Apostle, Overseer -> /review
- Elder -> /elder
- Chairperson -> /chairperson
- Treasurer -> /treasurer
- Auditor -> /audit
- Secretary -> /reports
- fallback -> /dashboard

## Route Protection (middleware.ts ROUTE_ROLE_MAP)

First-pass gate; fine-grained checks still happen in-page via permissions.ts.
Empty array = any authenticated user with active access.

- /admin -> HO only
- /elder -> Elder
- /treasurer -> Treasurer
- /chairperson -> Chairperson
- /capture, /oac -> Treasurer, Chairperson, Elder
- /audit -> Auditor, Chairperson, Elder, HO
- /review -> Overseer, Apostle, HO
- /monthly-close -> Elder, Overseer, HO
- /census -> Treasurer, Elder, Chairperson, HO, Apostle, Overseer, Secretary
- /dashboard, /settings, /reports, /messages -> any active user (features gated in-page)

Middleware invariants:
- Unauthenticated on a protected route -> redirect /login.
- No active `user_hierarchy_access` -> redirect /login with restricted-access error.
- Access date window enforced: block if `start_date > now` OR `end_date < now`.
- Wrong role for route -> redirect to the role's own dashboard (not an error page).
- Authenticated user hitting /login -> redirected to their dashboard.

## Login Flow (LoginForm.tsx) — ordered, fail-closed

0. Turnstile: if `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, a token is required; POST to
   `/api/auth/verify-turnstile`. On non-success, abort before authentication.
1. Supabase `signInWithPassword`.
2. Load single active `user_hierarchy_access`; if none, sign out + restricted error.
3. Date window: `start_date > now` -> "not yet started"; `end_date < now` -> "expired";
   both sign the user out.
4. HO users: MUST have >=1 row in `ho_district_assignments`, else sign out.
5. Route via `getDashboardRoute(role)`.

## Cloudflare Turnstile (security hardening)

- Client widget `src/components/Turnstile.tsx` renders ONLY if
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is present; otherwise renders nothing.
- Server verify `src/app/api/auth/verify-turnstile/route.ts`:
  - If `TURNSTILE_SECRET_KEY` is unset -> returns success (dev bypass).
  - Missing token -> 400. Cloudflare siteverify failure -> 403. Exception -> 500.
  - Sends `remoteip` from `x-forwarded-for`.
- **Fail-closed in prod, fail-open in dev** is the intended contract: both secret and
  site key must be set in production.

## Security Headers (next.config.mjs, applied to all routes)

- X-Frame-Options: SAMEORIGIN
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy: camera=(), microphone=(), geolocation=()
- Strict-Transport-Security: max-age=31536000; includeSubDomains
- X-XSS-Protection: 1; mode=block

## Privileged Admin API Routes (service-role pattern)

All `/api/admin/*` routes (e.g. create-hierarchy, update-hierarchy) follow the SAME
authorization gate — this pattern MUST be preserved on any new admin route:

1. Require `SUPABASE_SERVICE_ROLE_KEY` (else 500 "Server config error").
2. Require `Authorization: Bearer <token>` (else 401).
3. Resolve user via `supabaseAdmin.auth.getUser(token)` (else 401).
4. Look up `user_hierarchy_access` (status active); role MUST equal `HO` (else 403).
5. Validate required body fields (else 400).
6. Perform DB write with the service-role client (bypasses RLS).

create-hierarchy required fields: `name, code, level_type` (parent_id optional).
update-hierarchy required: `id`, plus at least one of `name`/`code`.

## HO Data Segregation

- HO users are scoped by `ho_district_assignments`. `getHODistrictIds(userId)`
  returns their district IDs; all HO queries must filter to these districts (RLS
  performs the actual row filtering).
- `canAccessCongregation` order: direct `congregation_id` match -> HO district check ->
  `user_congregation_assignments` -> Overseer/Apostle see-all fallback.

## HO Dashboard Drill-Down (admin/dashboard/page.tsx)

- Access gated: non-HO -> "Access denied".
- Drill order: District -> Apostleship -> Overseership -> Congregation, with a
  breadcrumb path and up/root navigation.
- Rollup of congregation IDs under a node walks `hierarchy_levels.parent_id`:
  - Overseership: `congregations.overseership_id == node.id`.
  - Apostleship: overseerships whose parent is the node, then their congregations.
  - District: apostleships under node -> overseerships -> congregations.
- Period stats bucket statuses: draft=Draft, submitted=Submitted, approved=AuditApproved,
  toHO=[SubmittedToHO, HOReviewed].
- Month filter defaults to current YYYY-MM; periods loaded from `cashbook_period`
  filtered by year+month.

## Service Status Flow (canonical, types.ts)

`Draft -> PendingAudit -> AuditApproved | AuditRejected -> SubmittedToOverseer ->
OverseerApproved | OverseerRejected -> SubmittedToHO -> HOReviewed`

## Audit Actions (types.ts)

CAPTURE, SUBMIT, AUDIT_APPROVE, AUDIT_REJECT, OVERSEER_APPROVE, OVERSEER_REJECT,
HO_REVIEW, SELF_REVIEW_EXCEPTION, BULK_IMPORT, CENSUS_UPDATE, MONTH_SUBMIT,
CORRECTION, UNLOCK.

## Enumerations (types.ts)

- Service types: AM, PM
- Income types: Cash, EFT, DirectDebit
- Line sections: Members, Officers, Burial, Expenses
- Proof statuses: Pending, Uploaded, Deposited
- Census staleness flags: GREEN, ORANGE, RED

## Known Issues (documented, NOT auto-fixed — preserve until a spec addresses them)

1. **HO dashboard stat key mismatch**: `getStats()` returns `toHO`, but the summary
   cards and drill grid read `s.toOverseer` / `item.stats.toOverseer`, which is
   undefined -> "Submitted Up"/"Submitted" always renders "—".
2. **Table name inconsistency**: dashboard queries `cashbook_period`; shared types
   define `cashbook_service` (+ views `v_cashbook_service`, `v_cashbook_month`).
   Confirm the true source table before building reports.
3. **`getUserAccess` ordering**: primary access record selected with `limit(1)` and no
   `order`, so "primary" among multiple active rows is non-deterministic. Middleware
   orders by `created_at asc` — client/middleware may disagree.
