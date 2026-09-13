# Implementation Plan: Hybrid Offline Architecture

## Overview

This plan migrates the OAC Cashbook app from Next.js (App Router) to a Vite + React + vite-plugin-pwa SPA with an offline-first Capture_App, an online-only Admin_App, offline PIN authentication, a Dexie-backed Local_Store + Sync_Engine, and a Supabase Edge Function Security_Backend — while preserving every load-bearing invariant.

Implementation language is **TypeScript** throughout (SPA, Dexie, Auth_Service, Sync_Engine) with **Deno/TypeScript** for Supabase Edge Functions. Property-based tests use **fast-check** with a minimum of 100 iterations, each tagged `// Feature: hybrid-offline-architecture, Property {n}: {property_text}`. The existing `@/lib/permissions.ts` gate and `@/lib/types.ts` enums are reused verbatim.

Tasks build incrementally: repo hygiene first, then the Vite/PWA shell and router split, the Local_Store, the offline PIN Auth_Service, the Security_Backend + headers, the Sync_Engine, then final wiring and preserved-invariant regression coverage.

## Tasks

- [ ] 1. Git tracking cleanse and `.gitignore` update (preparatory)
  - **This task changes git repository tracking state, not just files on disk.**
  - Update `.gitignore` to ignore `.env.local` (and other `.env*.local`), `.next/`, `.next.nosync`, `node_modules/`, build output (`dist/`, `dev-dist/`), and OS/editor cruft.
  - Run `git ls-files` to enumerate currently-tracked files that the updated `.gitignore` should exclude; **surface the exact list of files to be untracked to the user and obtain explicit confirmation BEFORE running any `git rm --cached`.**
  - Untrack (without deleting from disk) using `git rm --cached <file>` for each confirmed file. Verify `.env.local` is not tracked (`git ls-files --error-unmatch .env.local` must fail) and confirm it never appears in a commit.
  - Do not stage/commit unrelated files; stage only `.gitignore` and the untracking changes.
  - _Requirements: steering security guardrails (never commit secrets; `.env.local` untracked)_

- [ ] 2. Scaffold Vite + React + TypeScript project and path alias
  - [ ] 2.1 Initialize Vite + React + TypeScript build config
    - Add Vite config with `@vitejs/plugin-react`, React 18+, and the `@ -> /src` path alias in both `vite.config.ts` and `tsconfig.json` so `@/lib/types`, `@/lib/permissions`, `@/lib/supabase/client` imports remain valid.
    - Create `index.html` → `src/main.tsx` mounting `<App/>`; add `package.json` scripts (build, preview, test).
    - _Requirements: 1.1, 1.4_
  - [ ] 2.2 Configure vite-plugin-pwa with per-asset-class caching
    - Add vite-plugin-pwa with `registerType: 'prompt'`, an installable `manifest` (name, icons reusing `public/nac-logo.png`, `display: standalone`), and `workbox.globPatterns` precaching the app shell + JS/CSS chunks + fonts + icons.
    - Configure `workbox.runtimeCaching`: static images/logo → `CacheFirst`; Supabase Admin API calls + Supabase Auth + Edge Function calls → `NetworkOnly` (never cached); reference lookup fetches → `StaleWhileRevalidate` (online only). Capture data is not served by the SW.
    - _Requirements: 1.1, 1.2, 2.4, 2.5_

- [ ] 3. Build the app shell, code-split layouts, and router guard
  - [ ] 3.1 Create App shell with lazily-imported Capture and Admin layouts
    - In `src/App.tsx`, host the router with `lazy(() => import('./capture/CaptureLayout'))` and `lazy(() => import('./admin/AdminLayout'))` so the two layouts are distinct chunks; keep router guard, `permissions.ts`, `types.ts`, Auth_Service bootstrap, and Local_Store init in the always-loaded core.
    - Serve Capture_App exclusively under `/capture` and Admin_App exclusively under `/admin`.
    - _Requirements: 1.1, 2.1, 2.2_
  - [ ] 3.2 Implement the client-side router guard (replaces middleware.ts)
    - Create `src/lib/routeGuard.ts` with `resolveAccess()` (online → `getUserAccess()`; offline → derive from active Offline_Session Cached_Credential), `canEnterCapture(role)` (true if any `capture.*` grants non-`-` via `hasPermission`), `canEnterAdmin(role)` (`admin.*` = `M`, i.e. HO only), and `redirectTargetFor(role)` = `getDashboardRoute(role)`.
    - All decisions route through `@/lib/permissions.ts`; no inline role string comparisons. Deny non-permitted capture roles; route non-HO away from `/admin` to their dashboard.
    - _Requirements: 2.6, 2.7, 10.1, 10.6_
  - [ ]* 3.3 Write unit tests for the router guard
    - Test `canEnterAdmin` HO-only, `canEnterCapture` per capture role, and `redirectTargetFor` per role via the matrix (no hardcoded roles).
    - _Requirements: 2.6, 2.7, 10.1_
  - [ ] 3.4 Implement Admin_App offline-unavailable state
    - When offline under `/admin`, render an explicit offline-unavailable panel and issue no Supabase reads and no Local_Store reads for admin data.
    - _Requirements: 2.4, 2.5_
  - [ ] 3.5 Implement SW update flow preserving unsynced records
    - Wire the `prompt` update flow (update-available prompt → `skipWaiting` + `clientsClaim`) so the new bundle activates and cleans only the old asset precache; the Dexie/IndexedDB database is never cleared on activation.
    - _Requirements: 1.5_

- [ ] 4. Checkpoint - shell and routing
  - Ensure the project builds, the PWA registers, and all tests pass. Ask the user if questions arise.

- [ ] 5. Initialize the Dexie Local_Store schema and reference cache
  - [ ] 5.1 Define the Dexie database and versioned schema
    - Create `src/lib/localStore.ts` declaring database `oac_cashbook_local` version 1 with stores and indexes exactly as designed: `credentials: "userId"`, `congregations: "id, district_id, overseership_id"`, `hierarchyLevels: "id, parent_id, level_type"`, `captureQueue: "localId, localStatus, congregationId, createdAt, serverId"`, `lineItems: "localId, serviceLocalId"`, `syncMeta: "key"`.
    - Define TypeScript record types (`CachedCredential`, `CongregationLookup`, `HierarchyLookup`, `QueuedRecord`, `lineItems` child, `SyncMeta`) reusing `@/lib/types` enums (`Role`, `ServiceStatus`, `LineSection`, `IncomeType`, `HierarchyLevel`) rather than inline literals.
    - _Requirements: 3.1, 3.4, 11.1, 11.6, 13.1_
  - [ ] 5.2 Implement capture persistence helpers
    - Add write/read helpers that persist a capture record to `captureQueue` (+ child `lineItems`) with `localStatus='pending'`, `capturedByUserId`, `capturedRole`, `createdAt`; read pending/queued records offline from Dexie.
    - _Requirements: 3.2, 3.3, 3.4, 3.5_
  - [ ]* 5.3 Write property test for captured-record identity/role retention
    - **Property 10: Captured records retain identity and role at capture time**
    - Generate random records, enqueue, simulate restart (reopen store), assert identity + capture-time role retained until sync confirmed.
    - **Validates: Requirements 3.4, 3.5**
  - [ ] 5.4 Implement the reference cache loader
    - Create `src/lib/referenceCache.ts` with `refreshLookups()` (online only; pull `congregations` + `hierarchy_levels` scoped by RLS into Dexie lookup stores; stamp `syncMeta.lastReferenceRefreshAt`) and `getCongregations()` / `getHierarchy()` reading from Dexie offline.
    - _Requirements: 3.3, 11.1, 11.6, 13.1, 13.2_
  - [ ]* 5.5 Write unit tests for reference-cache mapping
    - Assert Supabase `congregations`/`hierarchy_levels` rows map into the Dexie lookup shape correctly (self-referential `parent_id`, denormalized ids).
    - _Requirements: 11.1, 11.6_

- [ ] 6. Implement the WebCrypto offline PIN cryptography core
  - [ ] 6.1 Implement PBKDF2 derivation and per-user salt generation
    - Create `src/lib/auth/crypto.ts`: `derivePinHash(pin, salt, iterations)` via WebCrypto `crypto.subtle` (`importKey` → `deriveBits`, SHA-256), `generateSalt()` via `crypto.getRandomValues`, and base64 encode/decode. Never store the raw PIN or a reversible form.
    - _Requirements: 4.2, 4.5, 15.1, 15.2_
  - [ ]* 6.2 Write property test for PIN verification round-trip
    - **Property 2: PIN verification round-trip accepts the correct PIN**
    - Generate random PIN + salt + iteration count; derive at activation and re-derive at unlock; assert match.
    - **Validates: Requirements 4.2, 5.1, 5.2**
  - [ ] 6.3 Implement PIN-keyed HMAC integrity binding
    - Add `computeHmac(fields, pin)` / `verifyHmac(...)` over the canonical serialization of `{ pinHash, salt, kdfIterations, role, accessStartDate, accessEndDate, activatedAt }` using a PIN-derived HMAC key (distinct derivation from the verification hash).
    - Add a constant-time comparison helper for hash/HMAC checks.
    - _Requirements: 4.4, 15.3_
  - [ ]* 6.4 Write property test for tampered-credential rejection
    - **Property 3: Tampered credential never authorizes**
    - Generate a valid credential, mutate an integrity-protected field without the PIN, assert integrity check fails.
    - **Validates: Requirements 4.4, 5.4, 15.3, 15.4**

- [ ] 7. Implement the Auth_Service lifecycle
  - [ ] 7.1 Implement online offline-PIN activation
    - Create `src/lib/auth/authService.ts` `activateOffline({ email, password, turnstileToken?, pin })`: online-only — verify Turnstile via Edge Function, authenticate with Supabase, load the active Access_Record, derive salt+`pinHash`, compute `hmac`, write the Cached_Credential (role metadata + Access_Window). Reject if offline.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [ ] 7.2 Implement offline PIN unlock with lockout
    - Add `unlockOffline(pin)`: verify HMAC first (else require re-activation), derive submitted-PIN hash with stored salt, constant-time compare; on match establish an Offline_Session scoped to cached role; on mismatch reject and increment `failedAttempts`; at configured max set `lockedUntil` and lock until online re-auth.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 10.6, 15.4_
  - [ ]* 7.3 Write property test for wrong-PIN rejection
    - **Property 1: Offline unlock never accepts a wrong PIN**
    - Generate a PIN + a different PIN + random salt; assert unlock with the different PIN rejects and establishes no Offline_Session.
    - **Validates: Requirements 5.1, 5.3**
  - [ ]* 7.4 Write property test for failed-attempt lockout
    - **Property 8: Failed-attempt lockout triggers at the configured maximum**
    - Generate random failure sequences; assert lockout engages once the count reaches the configured maximum.
    - **Validates: Requirements 5.5**
  - [ ] 7.5 Implement offline session TTL enforcement
    - Add `enforceTTL(now)`: end the Offline_Session when `now` exceeds activation time + offline TTL without a successful Reconnect_Revalidation, requiring online re-auth.
    - _Requirements: 6.1, 6.2, 12.6_
  - [ ]* 7.6 Write property test for offline session TTL
    - **Property 6: Offline session never outlives its TTL**
    - Generate random activation time, TTL, and now; assert session ends when now > activation + TTL.
    - **Validates: Requirements 6.1, 6.2**
  - [ ] 7.7 Implement reconnect re-validation and deactivation invalidation
    - Add `revalidateOnReconnect()`: re-check Access_Record `status`, Access_Window, and server role against Supabase; reconcile server role into the Cached_Credential and re-scope the session; block (fail-closed) on non-active/out-of-window/failed re-validation; invalidate the credential when the user is deactivated/revoked. Add `signOut()` clearing active Offline_Session state.
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 12.5, 15.5, 15.6_
  - [ ]* 7.8 Write property test for reconnect fail-closed behavior
    - **Property 7: Reconnect re-validation fails closed**
    - Generate random status/window/failure combinations; assert non-active OR out-of-window OR incomplete re-validation ends the session and never extends it.
    - **Validates: Requirements 6.4, 6.6, 12.5**

- [ ] 8. Checkpoint - Local_Store and Auth_Service
  - Ensure all property and unit tests pass. Ask the user if questions arise.

- [ ] 9. Implement the Supabase Edge Function Security_Backend
  - [ ] 9.1 Implement the `verify-turnstile` Edge Function
    - Create the Deno/TS `verify-turnstile` function: accept `{ token, remoteip }`, derive `remoteip` from forwarding headers, verify with Cloudflare; missing token → reject; verification failure → reject; missing `TURNSTILE_SECRET_KEY` → dev-bypass success. Never expose the secret to the client.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - [ ] 9.2 Implement the `admin-write` Edge Function gate
    - Create the Deno/TS `admin-write` function reproducing the exact gate order: service-role key present (else 500) → bearer token (else 401) → resolve user via `auth.getUser` (else 401) → active Access_Record with role `HO` (else 403) → validate required body (else 400) → perform the write with the service-role client. Keep the service-role key server-side only.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 12.4_
  - [ ]* 9.3 Write integration/smoke tests for the Edge Functions
    - `admin-write`: representative cases for 500 (no service-role key), 401 (no bearer / unresolvable), 403 (non-HO), 400 (missing body), 200 (HO write). `verify-turnstile`: missing-token reject, verify-fail reject, dev-bypass when secret unset. Use representative examples, not PBT.
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 9.2, 9.3, 9.5, 9.6, 9.7_
  - [ ] 9.4 Configure host-level security headers
    - Add `vercel.json` `headers` (or a static `_headers` file) applying all six headers to all responses: `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` disabling camera/microphone/geolocation, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-XSS-Protection: 1; mode=block`.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ]* 9.5 Write header smoke test
    - Assert all six security headers are present on a served response.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [ ] 10. Implement the Sync_Engine reconciliation
  - [ ] 10.1 Implement the Service_Status_Flow transition validator
    - Create `src/lib/sync/statusFlow.ts` `isValidTransition(from, to, actorRole)` enforcing the directed graph from `SERVICE_STATUSES` (allow initial `null → Draft`; permit `CORRECTION`/`UNLOCK` only when `actorRole === 'HO'`; reject all other transitions).
    - _Requirements: 14.4, 14.5, 14.7_
  - [ ]* 10.2 Write property test for illegal-transition rejection
    - **Property 4: Sync never applies an illegal status transition**
    - Generate random `(from, to)` over `SERVICE_STATUSES`; assert only permitted successors (or `null→Draft`) are applied and others are rejected/flagged.
    - **Validates: Requirements 14.4, 14.5**
  - [ ]* 10.3 Write property test for HO-only corrections and unlock
    - **Property 11: HO-only corrections and unlock**
    - Generate random roles + `CORRECTION`/`UNLOCK`; assert applied only when role is HO, rejected otherwise.
    - **Validates: Requirements 14.7**
  - [ ] 10.4 Implement enqueue and the syncPending reconciliation loop
    - Create `src/lib/sync/syncEngine.ts` `enqueue(record)` (pending write) and `syncPending()`: read pending/failed ordered by `createdAt`, fetch server record, detect conflict when server status has advanced downstream (mark `conflict` + persist an auditable conflict record, never overwrite), validate transition via `isValidTransition`, upsert on valid (RLS enforces row scope), mark `synced` + store `serverId` on confirm, retain `failed` with `lastError` and exponential backoff on error.
    - _Requirements: 14.1, 14.2, 14.3, 14.5, 14.6_
  - [ ]* 10.5 Write property test for conflict detection
    - **Property 5: Conflict detection when server status has advanced**
    - Generate random local/server status pairs; assert records whose target is not downstream of current server status are marked `conflict` with an auditable record and never overwrite server state.
    - **Validates: Requirements 14.6**
  - [ ] 10.6 Implement offline override-audit enqueue and flush
    - When an Elder/Chairperson performs an `O` (Override) action offline, enqueue an auditable `SELF_REVIEW_EXCEPTION` record to the Local_Store and flush it to `audit_log` via `logSelfReviewException` on reconnect.
    - _Requirements: 10.5_
  - [ ]* 10.7 Write property test for permission-matrix authority
    - **Property 9: Every access decision derives from the permission matrix**
    - For all roles × sampled `module.function`, assert the authorization result equals `hasPermission(role, moduleFunction)` (online and within an Offline_Session), including HO-only admin `M`/`-`.
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.6**

- [ ] 11. Checkpoint - Security_Backend and Sync_Engine
  - Ensure all property, unit, and integration tests pass. Ask the user if questions arise.

- [ ] 12. Wire components together (final integration)
  - [ ] 12.1 Integrate Auth_Service, router guard, capture flow, and Sync_Engine
    - Connect the App bootstrap so: router guard consumes `resolveAccess()` (online/offline) → Capture_App writes go to the Local_Store via the persistence helpers → connectivity restoration triggers `revalidateOnReconnect()` then `referenceCache.refreshLookups()` then `syncEngine.syncPending()`. Ensure no orphaned modules remain; Admin_App reads live Supabase only.
    - _Requirements: 1.4, 2.3, 3.2, 6.3, 14.1_
  - [ ]* 12.2 Write integration tests for the end-to-end offline→online path
    - Simulate: offline unlock → offline capture (pending in Dexie) → reconnect → re-validation → sync confirmed. Also assert `/admin` renders offline-unavailable and issues no Supabase reads while offline, and that pre-existing Dexie queue records survive a simulated bundle update.
    - _Requirements: 1.5, 2.4, 3.4, 6.3, 14.1, 14.2_

- [ ] 13. Preserved-invariant regression coverage
  - [ ]* 13.1 Write regression tests for permission-matrix and HO-only admin
    - Assert every access decision derives from `permissions.ts` (no inline role comparison) and administrative management functions are HO-only (`M` for HO, `-` for all others).
    - _Requirements: 10.1, 10.3_
  - [ ]* 13.2 Write regression tests for hierarchy parent-type rules
    - Assert Apostleship requires a District parent, Overseership requires an Apostleship parent, and non-District managed levels are rejected without a parent, on create AND edit.
    - _Requirements: 11.2, 11.3, 11.4, 11.5_
  - [ ]* 13.3 Write regression tests for HO segregation and fail-closed access
    - Assert HO data is constrained to `ho_district_assignments`, an HO with zero assignments is blocked from login, the `status` active + Access_Window check is enforced in both the auth and Edge Function paths, any auth-chain failure blocks (no dashboard fallthrough), and row filtering relies on Supabase RLS.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 13.2_

- [ ] 14. Final checkpoint - full suite
  - Ensure all tests pass and the build succeeds. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Property-based tests use fast-check (min 100 iterations) tagged `// Feature: hybrid-offline-architecture, Property {n}: {property_text}` and each maps to exactly one design property. Integration/smoke tests (Edge Functions, headers, PWA/SW, admin-offline) use representative examples per the design's Testing Strategy, not PBT.
- Task 1 alters git repository tracking state; the executing agent must surface the exact untrack list and get user confirmation before running `git rm --cached`, and must verify `.env.local` is never committed.
- The permission matrix (`@/lib/permissions.ts`) and canonical enums (`@/lib/types.ts`) are reused verbatim; no invariant is weakened.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2.1", "9.1", "9.4"] },
    { "id": 1, "tasks": ["2.2", "5.1", "6.1", "9.2"] },
    { "id": 2, "tasks": ["3.1", "5.2", "5.4", "6.2", "6.3", "9.3", "9.5", "10.1"] },
    { "id": 3, "tasks": ["3.2", "3.4", "3.5", "5.3", "5.5", "6.4", "7.1", "10.2", "10.3"] },
    { "id": 4, "tasks": ["3.3", "7.2", "7.5", "7.7", "10.4", "10.6"] },
    { "id": 5, "tasks": ["7.3", "7.4", "7.6", "7.8", "10.5", "10.7"] },
    { "id": 6, "tasks": ["12.1"] },
    { "id": 7, "tasks": ["12.2", "13.1", "13.2", "13.3"] }
  ]
}
```
