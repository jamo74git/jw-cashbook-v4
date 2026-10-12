# Implementation Plan

> Derived strictly from the approved `design.md`. This is a QA follow-up feature on top of
> `offline-pin-flow-fix`: it adds a per-user offline profile, a multi-user account picker, an
> offline-aware identity resolver, and a header refactor.
>
> **Hard constraints (apply to every task).** PIN material and verification stay in the existing
> `credentials` store + `src/services/crypto.ts` (Decision D1) - the new `offlineUsers` store holds
> only non-secret display/scope data. Do **NOT** modify `src/services/crypto.ts`,
> `src/components/CashbookForm.tsx`, `src/db/captureRepo.ts`, or `src/utils/syncEngine.ts`. No new
> runtime crypto dependency, no server-side pin-hash column, no writes to `auth.users`/`profiles`.
> Fail closed throughout. Per-user writes must never modify or delete another user's profile or
> credential. Preserve everything delivered by `offline-pin-flow-fix`.
>
> Tasks prefixed with `*` are OPTIONAL (property/behavior tests). They encode the Correctness
> Properties and are recommended, but the feature can be implemented and verified without them via
> the mandatory build/typecheck/preservation checkpoint (task 10). No mandatory task depends on an
> optional one.

## Overview

The offline flow is single-user and identity-blind after unlock. This plan persists each user's
profile on online login, lets the operator pick among all cached users offline, unlocks per-user
(reusing the flow-fix `unlockOffline(pin, userId)`), and hydrates identity so the header shows the
correct initials, email, role, congregation name, and a non-zero scope. Work is scoped to the auth
feature, a new identity module, the Dexie schema (additive v3 store), the route guard, and the app
header.

## Tasks

---

- [ ] 1. Add the `offlineUsers` profile store to the Dexie schema (v3)
  - File: `src/db/schema.ts`
  - Add the `OfflineUserProfile` interface: `userId` (pk), `email`, `role`, `displayName`,
    `initials`, `congregationId`, `congregationName`, `scopeLevel`, `hierarchyId`, `lastSyncAt`
  - Declare `offlineUsers!: Table<OfflineUserProfile, string>` and add
    `this.version(3).stores({ offlineUsers: "userId" })`
  - Additive bump only: do NOT alter existing stores, indexes, or the HMAC-protected `CachedCredential`
    set; no data migration (new empty store). Store holds NO PIN hash / salt / HMAC
  - _Design: Components and Interfaces 1; Data Models_
  - _Requirements: 1.1, 1.5_

- [ ] 2. Capture congregation + scope at online login via `AuthenticatedContext`
  - File: `src/features/auth/LoginForm.tsx`
  - Extend the active-access `select` to also fetch `congregation_id, hierarchy_id, scope_level`
  - Add `congregationId: string | null`, `hierarchyId: string | null`, `scopeLevel: HierarchyLevel`
    to `AuthenticatedContext` and pass them through the `onAuthenticated(...)` call
  - Leave the Turnstile -> auth -> active access -> HO district gate, ordering, and fail-closed
    sign-outs unchanged; `password` stays transient
  - _Design: Components and Interfaces 2_
  - _Requirements: 1.1_

- [ ] 3. Add profile persistence and offline-user listing to the auth service
  - File: `src/services/authService.ts`
  - Add `persistOfflineUserProfile({ userId, email, role, congregationId, hierarchyId, scopeLevel })`:
    derive `displayName` (capitalized email prefix) and `initials` (first two chars) using the SAME
    rule the header uses today; resolve `congregationName` from `db.congregations.get(congregationId)`
    then fall back to a Supabase lookup when online; `put` into `offlineUsers` with `lastSyncAt = now`
  - The congregation-cache ensure step is SILENT/background: show NO success toast for the caching
    operation itself; on congregation-name resolution failure, log a warning, do NOT block login, and
    store `congregationName` falling back to `congregationId` (or null when there is no congregation)
    (R1.3, R1.4)
  - Return whether this was the FIRST time this `userId` was cached on the device - read a pre-upsert
    existence check (`db.offlineUsers.get(userId)` before the `put`) and return
    `{ firstTimeCached: boolean }` so the caller can show the optional first-time-only subtle
    confirmation (R1 2a)
  - Per-user write only (never touch other users' rows); wrap so a failure is non-fatal and does not
    block login
  - Add `getOfflineUsers()`: read all `offlineUsers`, filter to those with a matching `credentials`
    row (a usable credential, R2.7 - this also protects the R3.7 "no orphan profile" invariant), sort
    by `lastSyncAt` desc; pure Dexie reads, no crypto, no network
  - _Design: Components and Interfaces 3, 4_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 2.7_

- [ ] 4. Add the offline-aware identity resolver
  - File: `src/lib/identity.ts` (new)
  - Export `CurrentIdentity` and `getCurrentIdentity()`:
    - offline ⇒ `authService.getSession()`; null session ⇒ return `null` (fail-closed); else join
      `db.offlineUsers.get(session.userId)` for display/congregation, role/window from the session
    - online ⇒ `getUserAccess()` + `supabase.auth.getUser()` for email (unchanged online semantics);
      resolve `congregationName` from the cached `congregations` store (fallback Supabase)
  - Add `computeScopeCount({ scopeLevel, hierarchyId, congregationId })` over the cached
    `congregations` store: Eldership scope ⇒ count by `eldership_id`; else `congregationId` present
    ⇒ 1; else 0 (never 0 when a congregation is known)
  - Route role usage through existing types/permission helpers; no new raw role-string branching
  - _Design: Components and Interfaces 5_
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 6.1, 6.2, 6.3_

- [ ] 5. Enrich the route guard's offline access record
  - File: `src/lib/routeGuard.ts`
  - In `resolveAccess()`'s offline branch, read `db.offlineUsers.get(session.userId)` and populate
    `congregation_id`, `hierarchy_id`, and `scope_level` from the profile (fallbacks when absent);
    keep the fail-closed `null` when there is no active session
  - _Design: Components and Interfaces 6_
  - _Requirements: 4.1, 4.3_

- [ ] 6. Build the offline account picker component
  - File: `src/features/auth/AccountPicker.tsx` (new), matching shadcn/ui patterns
  - Props `{ users: OfflineUserProfile[]; onSelect: (userId) => void; onUsePassword: () => void }`
  - Title "Choose an account to unlock"; one labeled `button` per user showing an initials avatar,
    email, congregation name, and "Last synced <relative time>"
  - Accessibility: labeled controls, focusable rows, list has an accessible name; renders no PIN
    input and calls no auth primitive
  - _Design: Components and Interfaces 7 (AccountPicker)_
  - _Requirements: 2.1, 2.2_

- [ ] 7. Rework `LoginPage` for multi-user offline + profile persistence
  - File: `src/features/auth/LoginPage.tsx`
  - Extend `Mode` with `account-picker`
  - Offline initial-mode effect: `users = await getOfflineUsers()`; `0` ⇒ `online-required`; `1` ⇒
    set `unlockUserId` and go to `pin-unlock` (confirmation variant); `>1` ⇒ `account-picker`
  - `handleAuthenticated(ctx)`: call `persistOfflineUserProfile(ctx)` (non-fatal) before the existing
    credential-exists branch; keep the flow-fix `stageCredentialRefresh` / `pin-setup` behavior. Use
    the returned `firstTimeCached` flag to show an OPTIONAL first-time-only subtle confirmation
    ("Offline access enabled for <congregation>") - only on the first time this `userId` is cached on
    the device, never on subsequent logins (non-spam) (R1 2a)
  - Render `AccountPicker` for `account-picker`; selecting a user sets `unlockUserId` and goes to
    `pin-unlock`
  - PIN-set feedback in the `pin-setup` path (R3.6/R3.7):
    - On successful `activateOffline` (credential written): show a confirmation including the user's
      email and congregation name, e.g. "Offline PIN set for treasurer@bosmont.test - Bosmont. You
      can now work offline.", then navigate to the dashboard (R3.6)
    - On `activateOffline` failure: show a failure message, e.g. "Failed to set offline PIN. Please
      try again while online.", stay in a retry-while-online state (do NOT navigate as offline-ready),
      and ensure no offline-usable profile is left without a credential - the `getOfflineUsers`
      credential filter enforces this; roll back any profile written solely in this path (R3.7)
    - Messaging mechanism: prefer an existing toast util (check for `useToast` / `toast` under
      `@/components/ui`); if none exists, fall back to an inline message block with `role="alert"`
      consistent with the existing error blocks
  - `PinUnlock`: show "Unlock as <email> - <congregationName>" for the selected user, call
    `unlockOffline(pin, userId)` (per-user targeting + lockout preserved), and add a **Switch user**
    action back to `account-picker` when more than one offline user exists
  - _Design: Components and Interfaces 7 (LoginPage)_
  - _Requirements: 1.3, 1.4, 2.1, 2.3, 2.4, 2.5, 2.6, 2.7, 2a, 3.1, 3.2, 3.3, 3.4, 3.6, 3.7_

- [ ] 8. Refactor `AppHeader` to read from the identity resolver
  - File: `src/components/AppHeader.tsx`
  - Replace `getUserAccess()` + `supabase.auth.getUser()` + the direct congregation count query with
    a single `getCurrentIdentity()` call
  - Avatar renders `identity.initials` (never blank / "."); dropdown shows `identity.email` and
    `identity.role`; render `identity.congregationName` next to "OAC Management System"; banner shows
    `Role: <role>` and `Scope: <scopeCount> Congregation(s)`
  - Preserve the existing HO district-name display (online-only); make NO Supabase identity/scope
    calls while offline
  - _Design: Components and Interfaces 8_
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.3, 6.4, 6.5_

- [ ]* 9. Write property/behavior tests for the Correctness Properties
  - Reuse the Vitest + `fake-indexeddb` + jsdom harness from `offline-pin-flow-fix`; WebCrypto runs
    unmodified under Node >= 20
  - Cover the design's Correctness Properties:
    - **P1/P3 profile fidelity + isolation**: online login writes/updates (not duplicates) the user's
      profile; other users' rows untouched
    - **P2 no secret leakage**: no `offlineUsers` field is or is named for a PIN / hash / salt / HMAC
    - **P4 picker partition**: `n` in {0,1,>1} usable users ⇒ {online-required, auto-select, picker};
      profiles without a credential never listed. Includes the R3.7 case: after a profile upsert
      followed by a FAILED PIN-set (no credential written), that profile is NOT listed by
      `getOfflineUsers` - a failed PIN-set never produces an offline-usable profile without a credential
    - **P5 targeted unlock**: with `userB` first, selecting `userA` + correct PIN unlocks `userA`;
      wrong PIN fails and never unlocks `userB`; lockout preserved
    - **P6/P7 identity + scope**: `getCurrentIdentity()` yields correct initials/role/email/
      congregationName and `scopeCount >= 1` when a congregation is cached; null with no session
    - **P8 online parity**: online role + scope count match pre-change behavior
    - **PIN-set messaging** (R3.6/R3.7): a successful `activateOffline` surfaces the success message
      (email + congregation present); a failed `activateOffline` surfaces the failure message and does
      NOT navigate as offline-ready
  - _Design: Correctness Properties (incl. Property 4); Testing Strategy_
  - _Requirements: 3.6, 3.7, 8.4_

- [ ] 10. Checkpoint - build, typecheck, preservation, and confirm untouched files
  - Run `npx tsc --noEmit` (or `node ./node_modules/typescript/bin/tsc --noEmit`) - **must PASS**
  - Run `npx vite build` (or `node ./node_modules/vite/bin/vite.js build`) - **must PASS**
  - Re-run the existing `offlinePinFlow.explore` and `offlinePinFlow.preservation` suites -
    **must still PASS** (Property 9)
  - Confirm zero diff in `src/services/crypto.ts`, `src/components/CashbookForm.tsx`,
    `src/db/captureRepo.ts`, and `src/utils/syncEngine.ts`
  - Confirm no new runtime crypto dependency (inspect `package.json`), no server-side pin-hash column,
    no writes to `auth.users`/`profiles`
  - If any check fails, fix within the allowed surface; ask the user if questions arise
  - _Design: Guardrails and Files Touched; Quality gates_
  - _Requirements: 7.2, 7.3, 7.4, 8.1, 8.2, 8.3_

---

## Task Dependency Graph

```
1  schema v3 (offlineUsers) ──┬──> 3  authService (persist + getOfflineUsers)
                              ├──> 4  identity.ts (getCurrentIdentity)
                              ├──> 5  routeGuard (offline enrichment)
                              └──> 6  AccountPicker component

2  LoginForm (congregation/scope ctx) ─┐
3  authService ────────────────────────┤
6  AccountPicker ───────────────────────┴──> 7  LoginPage (multi-user offline + persist)

4  identity.ts ──────────────────────────────> 8  AppHeader (read identity)

7, 8  ──> 9*  (optional property/behavior tests)
7, 8  ──> 10  Checkpoint (tsc + vite build + preservation + untouched files)
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"] },
    { "wave": 2, "tasks": ["3", "4", "5", "6"] },
    { "wave": 3, "tasks": ["7", "8"] },
    { "wave": 4, "tasks": ["9", "10"] }
  ]
}
```

- Task **1** (schema) unblocks every profile reader/writer: **3**, **4**, **5**, **6**.
- Task **2** (login context) and task **3** (persist + `getOfflineUsers`) and task **6**
  (AccountPicker) are prerequisites for **7** (`LoginPage` consumes `ctx.congregationId`,
  `persistOfflineUserProfile`, `getOfflineUsers`, and the picker).
- Task **4** (identity) is the prerequisite for **8** (`AppHeader` reads `getCurrentIdentity`).
- Tasks **7** and **8** are the integration points; **9** (optional) adds property tests and **10**
  is the mandatory final checkpoint. No mandatory task depends on the optional task **9**.

## Notes

- **Hard constraints (reminder).** PIN material and verification stay in `credentials` +
  `src/services/crypto.ts` (D1); the `offlineUsers` store holds only non-secret display/scope data.
  Do NOT touch `src/services/crypto.ts`, `src/components/CashbookForm.tsx`,
  `src/db/captureRepo.ts`, or `src/utils/syncEngine.ts`. No new crypto dependency, no server-side
  pin-hash column, no writes to `auth.users`/`profiles`. Fail closed; never modify or delete another
  user's profile/credential; preserve all `offline-pin-flow-fix` behavior.
- **Schema version bump.** Adding the `offlineUsers` store requires a Dexie `version(3)` bump; it is
  additive (new empty store, no migration) and does not alter the credential HMAC-protected set.
- **Congregation names.** The existing `congregations` store already caches `name`, so no separate
  `congregations_cache` store is introduced (Decision D3); the denormalized `congregationName` on the
  profile is the offline-robust fallback.
- **HO scope.** HO district-scope header behavior is preserved and remains online-only; this feature
  targets the Treasurer/Elder/Chairperson capture personas (Decision D4).
