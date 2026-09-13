---
inclusion: always
---

# OAC Cashbook — Technical Architecture & Invariants

> Reflects the CURRENT hybrid architecture after the Next.js -> Vite migration.
> Documents WHAT the system does. Do not silently "fix" logic recorded here; known
> defects and migration gaps are called out explicitly at the end.

## Stack (current)

- **Vite 5 + React 18 + TypeScript** — static, installable PWA SPA (no Next.js server).
- **vite-plugin-pwa (Workbox)** — service worker, precache app shell, `registerType: 'prompt'`.
- **Dexie.js (IndexedDB)** — offline-first Local_Store for the field Capture_App.
- **Supabase** (Postgres + Auth + RLS + Storage) — system of record; client via
  `@/lib/supabase/client` using `import.meta.env` (Vite envPrefix accepts `VITE_` and
  legacy `NEXT_PUBLIC_`).
- **Supabase Edge Functions (Deno)** — the Security_Backend: `verify-turnstile` and
  `admin-write`, holding secrets that never reach the client bundle.
- **Host-level security headers** — `vercel.json` + `public/_headers` (replaces the
  old `next.config.mjs` headers).
- **react-router-dom** — client routing; a client-side route guard replaces the old
  Next.js `middleware.ts`.
- Deployed on Vercel.

Entry: `index.html` -> `src/main.tsx` -> `src/App.tsx`. The `/capture` and `/admin`
layouts are lazy-loaded (code-split). Vendor deps (`@supabase/supabase-js`, `dexie`,
`react-router-dom`) are split into their own chunks via `build.rollupOptions.output.manualChunks`.

## Roles (canonical, unchanged — src/lib/types.ts)

`HO, Apostle, Overseer, Elder, Chairperson, Treasurer, Auditor, Secretary`

Roles are NEVER hardcoded in pages/components. All checks go through
`@/lib/permissions.ts` (permission matrix from permission_matrix_v3.txt).

## Permission Codes (unchanged — types.ts / permissions.ts)

`V`=View, `C`=Create, `E`=Edit, `A`=Approve, `S`=Submit, `X`=Export, `M`=Manage,
`O`=Override, `R`=Reply, `T`=Totals-Only (Secretary), `-`=No access.

- `hasPermission` = code is anything except `-`.
- `T` (Totals-Only): UI MUST hide line-item detail and proof images (Secretary).
- `O` (Override): Elder/Chairperson self-review exception; MUST be logged as
  `SELF_REVIEW_EXCEPTION` in `audit_log` (online via `logSelfReviewException`; offline
  it is queued in Dexie and flushed by the Sync_Engine on reconnect).
- Admin management (users/congregations/officers/bulk import/audit logs) = `M` for
  **HO only**.
- `expenses.approve_over_500` = `A` for **Elder only**.

## Hierarchy Model (unchanged canonical levels)

`Conference > Apostolate > District > Apostleship > Overseership > Eldership > Congregation`

`hierarchy_levels` is self-referential via `parent_id`. Managed levels in the UI:
**District, Apostleship, Overseership**.

Parent-assignment invariants (create AND edit):
- District: no parent. Apostleship: parent MUST be a District. Overseership: parent
  MUST be an Apostleship. Non-District nodes require a parent; `name`/`code` required.
- Congregations attach to an Overseership via `overseership_id`, with denormalized
  `eldership_id`, `apostleship_id`, `district_id`.

## Role -> Dashboard Route (getDashboardRoute, unchanged)

HO -> /admin; Apostle, Overseer -> /review; Elder -> /elder; Chairperson ->
/chairperson; Treasurer -> /treasurer; Auditor -> /audit; Secretary -> /reports;
fallback -> /dashboard.

## Routing & Environmental Split (current)

- `/capture/*` — **offline-first** field capture. Reads/writes go to the Dexie
  Local_Store first (zero network latency); the Sync_Engine reconciles later.
- `/admin/*` — **online-only** Head Office. Reads live from Supabase; when offline it
  renders an explicit offline-unavailable state and exposes no admin data.

### Client route guard (`src/lib/routeGuard.ts`, replaces middleware.ts)
- `resolveAccess()` — online: `getUserAccess()` (Supabase). Offline: derives a
  provisional access record from the active Offline_Session (fail-closed if none).
- `canEnterCapture(role)` = `hasPermission(role, "capture.create")` (Elder/Chairperson/
  Treasurer). `canEnterAdmin(role)` = `hasPermission(role, "admin.manage_users")` (HO).
- All decisions flow through `permissions.ts`; Supabase RLS remains the authority.

## Offline PIN Authentication (src/services/)

- `crypto.ts` — PBKDF2-SHA256 (210k iterations) via WebCrypto with a per-user random
  salt; domain-separated derivations for the PIN hash vs the HMAC key; PIN-keyed HMAC
  over the credential's integrity-protected fields; constant-time comparison. Raw PIN
  is never stored.
- `authService.ts` lifecycle:
  1. **activateOffline** (online-only, Turnstile-gated): authenticate, load active
     access, derive salt+hash, compute HMAC, persist Cached_Credential in Dexie.
  2. **unlockOffline**: integrity (HMAC) check first, then PIN verify; failed-attempt
     lockout (MAX 5 -> `lockedUntil`, requires online re-auth); establishes a
     provisional in-memory Offline_Session on success.
  3. **enforceTTL / isTtlExpired**: 12-hour offline session TTL.
  4. **revalidateOnReconnect**: re-check status + access window + server role;
     reconcile role; delete the credential on revoke; restart TTL. Any failure is
     non-authorizing.
  5. **signOut**: clears the session.
- Offline auth is a **convenience gate, not the authority** — RLS + reconnect
  re-validation remain authoritative.

## Local_Store (Dexie: `oac_cashbook_local`, v1)

Stores: `credentials` (userId), `congregations` (id, district_id, overseership_id),
`hierarchyLevels` (id, parent_id, level_type), `officers` (id, congregation_id),
`captureQueue` (localId, localStatus, congregationId, createdAt, serverId),
`lineItems` (localId, serviceLocalId), `syncMeta` (key).

- Line items carry offline proof as a `Blob` (`proofBlob`, `proofFileName`,
  `proof_status`), uploaded to Supabase Storage by the Sync_Engine on reconnect.
- `src/db/captureRepo.ts` is the local data layer (service + line-item CRUD, officers,
  override-audit queueing). `src/utils/cacheLoader.ts` populates the reference stores
  (officers/congregations/hierarchyLevels) during an active online session.

## Sync Engine (src/utils/syncEngine.ts, statusFlow.ts)

- `syncPending()` processes pending/failed queue records ordered by `createdAt`.
- Exponential backoff (`backoffDelayMs`, `isDueForRetry`); failures retained + retried.
- Conflict detection (`isDownstreamOf`): if the server has advanced past the locally
  captured status, the record is marked `conflict` and an auditable record is written —
  server state is never overwritten.
- `isValidTransition` enforces the directional Service_Status_Flow; CORRECTION/UNLOCK
  are HO-only.
- Proof blobs uploaded before the line-item upsert; override-audit records flushed to
  `audit_log`.

## Service Status Flow (canonical, unchanged)

`Draft -> PendingAudit -> AuditApproved | AuditRejected -> SubmittedToOverseer ->
OverseerApproved | OverseerRejected -> SubmittedToHO -> HOReviewed`. Only HO may raise
corrections / unlock a month.

## Security_Backend — Supabase Edge Functions (supabase/functions/)

- **verify-turnstile**: missing token -> 400; Cloudflare verify failure -> 403; secret
  unset -> dev bypass success; sends `remoteip` from `x-forwarded-for`.
- **admin-write** (HO-only privileged writes; consolidates the old `/api/admin/*`):
  service-role key present (500) -> `Authorization: Bearer` (401) -> `auth.getUser`
  (401) -> active `user_hierarchy_access` role `HO` (403) -> validate body (400) ->
  write with service-role client. Service-role key stays server-side only.
- Deploy via Supabase CLI; secrets: `TURNSTILE_SECRET_KEY` (SUPABASE_URL /
  SUPABASE_SERVICE_ROLE_KEY are auto-provided to deployed functions).

## Security Headers (host-level: vercel.json + public/_headers)

X-Frame-Options: SAMEORIGIN; X-Content-Type-Options: nosniff; Referrer-Policy:
strict-origin-when-cross-origin; Permissions-Policy: camera=(), microphone=(),
geolocation=(); Strict-Transport-Security: max-age=31536000; includeSubDomains;
X-XSS-Protection: 1; mode=block. NOTE: these apply only on hosts that honor them
(Vercel / `_headers`-aware hosts); a plain static server applies none.

## HO Data Segregation (unchanged)

HO scoped by `ho_district_assignments`; `getHODistrictIds(userId)` returns districts;
RLS performs row filtering. `canAccessCongregation` order: direct `congregation_id` ->
HO district check -> `user_congregation_assignments` -> Overseer/Apostle see-all.

## Audit Actions & Enumerations (unchanged — types.ts)

Audit: CAPTURE, SUBMIT, AUDIT_APPROVE, AUDIT_REJECT, OVERSEER_APPROVE,
OVERSEER_REJECT, HO_REVIEW, SELF_REVIEW_EXCEPTION, BULK_IMPORT, CENSUS_UPDATE,
MONTH_SUBMIT, CORRECTION, UNLOCK. Service types: AM, PM. Income types: Cash, EFT,
DirectDebit. Line sections: Members, Officers, Burial, Expenses. Proof statuses:
Pending, Uploaded, Deposited. Census staleness: GREEN, ORANGE, RED.

## Migration Status & Known Issues (do NOT auto-fix; preserve until a spec addresses)

**Migration status (as of the Vite/PWA build):**
- Typecheck (`tsc --noEmit`) and `vite build` pass. The app has NOT been runtime-tested
  end-to-end; the offline->online sync loop has not been exercised against a live
  Supabase; Edge Functions are written but NOT deployed and NOT runtime-tested.
- No automated tests yet (the design's 11 correctness properties are unwritten).
- Still Next.js-coupled and quarantined from the app tsconfig (NOT ported):
  `src/features/auth/OtpLoginForm.tsx`, `src/components/ThemeProvider.tsx`. Also
  `src/lib/supabase/server.ts` is dead Next-only code retained by request — remove or
  port it.
- Reference cache (officers/congregations/hierarchy) populates on online login only;
  offline capture needs at least one prior online session for congregation context.

**Pre-existing domain issues (still open):**
1. **Table naming**: some code references `cashbook_period`; shared types define
   `cashbook_service` (+ views `v_cashbook_service`, `v_cashbook_month`). Confirm the
   true source table before building reports; the Sync_Engine currently writes
   `cashbook_service` / `cashbook_line_item`.
2. **`getUserAccess` ordering**: primary access selected with `limit(1)` and no order,
   so "primary" among multiple active rows is non-deterministic.
