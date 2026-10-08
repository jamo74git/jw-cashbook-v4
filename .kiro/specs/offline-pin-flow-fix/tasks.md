# Implementation Plan

> Derived strictly from the approved `design.md` (which reproduces `bugfix.md`'s
> authoritative `isBugCondition(X)`). This is an orchestration correction, not a feature.
>
> **Hard constraints (apply to every task).** Keep the existing WebCrypto PBKDF2-SHA256 +
> PIN-keyed HMAC primitives in `src/services/crypto.ts` **untouched** — no bcrypt, no new
> crypto dependency, no server-side `pin_hash` column, no writes to `auth.users`/`profiles`.
> Fix surface is confined to `src/features/auth/*`, `src/services/authService.ts`,
> `src/db/schema.ts`, and one read-merge-write in `src/utils/cacheLoader.ts`. Do **NOT**
> touch `src/components/CashbookForm.tsx`, `src/db/captureRepo.ts`, or
> `src/utils/syncEngine.ts`. Fail closed throughout. Never delete or overwrite another
> user's credential (multi-user coexistence, 3.8).
>
> Tasks prefixed with `*` are OPTIONAL (pure-logic unit/property tests). They encode the
> Correctness Properties and are recommended, but the fix can be implemented and verified
> without them via the mandatory build/typecheck checkpoint (task 10).

## Overview

This is a confined, per-user orchestration bugfix. It corrects how the offline PIN
login flow resolves and targets the relevant user (per-user credential lookup,
per-user mode routing, staged credential refresh with rebind-at-unlock, and an
explicit "online-required" screen) without changing the underlying crypto primitives
or the capture/sync surfaces. The work is scoped to `src/features/auth/*`,
`src/services/authService.ts`, `src/db/schema.ts`, and one read-merge-write in
`src/utils/cacheLoader.ts`, and it fails closed throughout.

## Tasks

---

- [x]* 1. Write bug condition exploration tests (BEFORE implementing the fix)
  - **Property 1: Bug Condition** - Per-user offline PIN flow is correct and usable
  - **CRITICAL**: These tests MUST FAIL / misbehave on the UNFIXED code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails** at this stage
  - **GOAL**: Surface counterexamples that demonstrate defects A, B, C, D from the design
  - **Scoped PBT Approach**: these are deterministic, identity-keyed decisions; scope each property to the concrete seeded credential set / connectivity so counterexamples are reproducible
  - Use Vitest; exercise Dexie via `fake-indexeddb` (or equivalent in-memory adapter); WebCrypto runs unmodified under Node ≥ 20
  - Encode the design's "Exploratory Bug Condition Checking" cases:
    - **D-suppress-setup**: seed a credential for `userB`; drive `handleAuthenticated` for `userA` (no credential) — unfixed routes to dashboard (PinSetup suppressed)
    - **D-wrong-unlock**: seed `userB` then `userA`; call `unlockOffline(pin)` with no `userId` — unfixed validates against `toArray()[0]` (wrong user)
    - **D-offline-prompt**: seed `userB` only; open offline intending `userA` — unfixed shows `pin-unlock` against `userB`
    - **A-skip**: first online login, click Skip — unfixed persists no credential (later offline dead-end)
    - **B-offline-deadend**: offline, empty store — unfixed renders the password form (expected `online-required`)
    - **C-no-refresh**: credential for `userA` with stale role; online login with a new server role — unfixed leaves cached role unchanged
  - Run on UNFIXED code and **document the counterexamples found** (these drive the fix)
  - **EXPECTED OUTCOME**: tests FAIL (this is correct — it proves the bug exists)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x]* 2. Write preservation property tests (BEFORE implementing the fix)
  - **Property 2: Preservation** - Non-buggy flow unchanged
  - **IMPORTANT**: Follow the observation-first methodology — observe behavior on UNFIXED code for `NOT isBugCondition(X)` inputs, then lock it in
  - Property-based: generate random `(credentialSet, authUserId, pin, online)` filtered to `NOT isBugCondition(X)`; assert the fixed flow's screen/unlock outcome will match the original's
  - Capture the design's "Preservation Checking" cases:
    - unlock + lockout: correct PIN unlocks; wrong PIN increments `failedAttempts` and locks at `MAX_FAILED_ATTEMPTS` (3.1)
    - crypto unchanged: `derivePinHash`/`computeHmac`/`verifyPin`/`verifyHmac` identical for identical inputs; store holds only `pinHash`/`salt`/`hmac` — no raw PIN (3.2, 3.6)
    - fail-closed: each failed step (bad auth, no access, out-of-window, HO with no districts, tampered HMAC, TTL) blocks and never reaches a dashboard (3.3)
    - dashboard routing: valid in-window online login routes via `getDashboardRoute(role)` (3.4)
    - revoke/expire: `revalidateOnReconnect` on a revoked user deletes the credential and ends the session (3.5)
    - multi-user coexistence: operating on `userA` never mutates/deletes `userB`'s credential (3.8)
  - Run on UNFIXED code — **EXPECTED OUTCOME**: tests PASS (confirms the baseline to preserve)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 3. Extend the Dexie schema with per-user pointer and staged-refresh fields
  - File: `src/db/schema.ts`
  - Add `lastActiveUserId?: string | null` to the `SyncMeta` interface (non-indexed; `syncMeta` is keyed only by `key`, so **no Dexie version bump**)
  - Add staged-refresh fields to `CachedCredential`, **outside** the HMAC-protected set: `pendingRole?: Role | null`, `pendingAccessStartDate?: string | null`, `pendingAccessEndDate?: string | null`, `pendingRefreshedAt?: string | null`
  - Do NOT alter the HMAC-protected field set or any index; no version bump
  - _Design: schema.ts changes (a)+(b); HMAC-Refresh Decision option 4_
  - _Requirements: 2.3, 3.2, 3.6, 3.8_

- [x] 4. Plumb `userId` and the access window through `AuthenticatedContext`
  - File: `src/features/auth/LoginForm.tsx`
  - Add `userId: string` to the `AuthenticatedContext` interface from `data.user.id`; also surface the access window (`accessStartDate`/`accessEndDate`) already queried in the online gate's access step
  - In `handleSubmit`, after the four-step gate succeeds, pass `{ userId: data.user.id, email, password, role, turnstileToken, accessStartDate, accessEndDate }` to `onAuthenticated`
  - Keep `password` transient (in-memory only, never persisted); leave the Turnstile → auth → active access → HO district gate and its fail-closed sign-outs unchanged
  - _Design: LoginForm.tsx — plumb userId_
  - _Requirements: 2.7, 3.3, 3.4_

- [x] 5. Add per-user targeting, staged refresh, and rebind-at-unlock to the auth service

  - [x] 5.1 Target the resolved user in `unlockOffline(pin, userId?)` and commit staged refresh
    - File: `src/services/authService.ts`
    - Load the credential via `db.credentials.get(userId)` — never `(await db.credentials.toArray())[0]`
    - Preserve the existing integrity-first → PIN verify → lockout ordering and `MAX_FAILED_ATTEMPTS` lock exactly (3.1); integrity still runs against the **currently stored** HMAC-protected fields first
    - On successful unlock only: if `pending*` fields are present, recompute the HMAC with the entered PIN over the new protected set (rebind-at-unlock), write the committed `role`/access fields + `activatedAt = pendingRefreshedAt` + new `hmac`, and clear all `pending*`; wrap the commit so a failure aborts and leaves the prior valid credential intact
    - Set `syncMeta.global.lastActiveUserId = credential.userId` on success
    - _Design: authService.ts step 1; HMAC-Refresh Decision option 4_
    - _Requirements: 2.3, 2.4, 2.7, 3.1, 3.6_

  - [x] 5.2 Add `stageCredentialRefresh(userId, { role, accessStartDate, accessEndDate })`
    - File: `src/services/authService.ts`
    - If no credential exists for `userId`, return (caller handles PinSetup); otherwise write only the `pending*` fields and `pendingRefreshedAt`, leaving the HMAC-protected set and `hmac` untouched (binding stays valid)
    - Set `syncMeta.global.lastActiveUserId = userId`
    - _Design: authService.ts step 3_
    - _Requirements: 2.3, 2.5_

  - [x] 5.3 Set `lastActiveUserId` on successful `activateOffline`
    - File: `src/services/authService.ts`
    - On successful activation set `syncMeta.global.lastActiveUserId = auth.user.id` (activation already writes a fresh HMAC over fresh server fields, so no staged refresh is needed here)
    - _Design: authService.ts step 2_
    - _Requirements: 2.1, 2.7_

- [x] 6. Preserve `lastActiveUserId` on the reference-cache write
  - File: `src/utils/cacheLoader.ts`
  - Change `refreshReferenceCache`'s `syncMeta.global` write to read-merge-write so `lastActiveUserId` is preserved, the same way `lastSyncAt` already is; no other data-contract change
  - _Design: schema.ts note on cacheLoader_
  - _Requirements: 2.7, 3.8_

- [x] 7. Add the accessible "online-required" screen
  - File: `src/features/auth/*` (new component, e.g. `OnlineRequired.tsx`, matching shadcn/ui patterns)
  - Explicit message: connect to the internet and sign in online to set up offline access; it must NOT render a PIN input and must NOT call any auth primitive (so it cannot dead-end)
  - Offer a route back to the password form ("use password" / "go online")
  - Accessibility: `role="alert"` for the message, focusable actions, labeled controls
  - _Design: Error / Fail-closed Handling; Mode State Machine (online-required)_
  - _Requirements: 2.2, 2.6_

- [x] 8. Rework `LoginPage` orchestration to the per-user mode state machine
  - File: `src/features/auth/LoginPage.tsx`
  - Extend `Mode` to `loading | password | pin-setup | pin-unlock | online-required`
  - Initial-mode effect (keyed on `online`, re-runs on connectivity flip so a transient `navigator.onLine` cannot strand the user):
    - online ⇒ `password`
    - offline ⇒ resolve relevant user via `db.syncMeta.get("global").lastActiveUserId`; if that user has a credential (`db.credentials.get(uid)`) ⇒ `pin-unlock` with target `uid`; else (null pointer / missing cred / any read error) ⇒ `online-required` (fail-closed, never a stray PIN prompt)
    - _Requirements: 2.2, 2.4, 2.6, 3.3_
  - `handleAuthenticated(ctx)`: replace the global `db.credentials.count()` with `db.credentials.get(ctx.userId)`; if a credential exists ⇒ `stageCredentialRefresh(ctx.userId, { role: ctx.role, accessStartDate: ctx.accessStartDate, accessEndDate: ctx.accessEndDate })` then `navigate(getDashboardRoute(ctx.role))` with the fresh role; else ⇒ `pin-setup` (even when other users' credentials exist)
    - _Requirements: 2.1, 2.3, 2.5, 2.7_
  - Pass the resolved target `userId` into `PinUnlock` → `unlockOffline(pin, userId)`
  - Confirmed-Skip in `PinSetup`: window-confirm that offline capture is unavailable until a PIN is set; on confirm call `onDone(ctx.role)` and persist **no** credential and set **no** "setup complete" flag (offline then resolves to `online-required`, so no dead-end is reachable)
    - _Requirements: 2.1_
  - Wire `online-required` into the render switch with its back-to-password action
  - _Design: LoginPage.tsx — per-user orchestration; Mode State Machine; PinSetup Skip_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.3, 3.4_

- [x]* 9. Verify the Correctness Properties against the fixed code

  - [x]* 9.1 Confirm the bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Per-user offline PIN flow is correct and usable
    - **IMPORTANT**: re-run the SAME tests from task 1 — do NOT write new tests
    - Assert P1-A..E over `isBugCondition(X)` inputs: confirmed-Skip leaves no credential and offline resolves to `online-required` (P1-A/2.1); offline empty/other-user ⇒ `online-required`, no PIN prompt (P1-B/2.2, 2.6); existing credential ⇒ `pending*` staged, stored HMAC unchanged on login, then unlock commits new role and `verifyHmac` passes against the new protected set (P1-C/2.3); `handleAuthenticated(userA)` with only `userB` cached ⇒ `pin-setup` (P1-D/2.5, 2.7); `unlockOffline(pin, userA)` targets `userA` even when `userB` is first (P1-E/2.4, 2.7)
    - **EXPECTED OUTCOME**: tests PASS (confirms the bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x]* 9.2 Confirm the preservation tests still pass
    - **Property 2: Preservation** - Non-buggy flow unchanged
    - **IMPORTANT**: re-run the SAME tests from task 2 — do NOT write new tests
    - Assert `loginFlow == loginFlow'` for `NOT isBugCondition(X)`: unlock + lockout, crypto outputs, fail-closed paths, dashboard routing, revoke/expire, multi-user coexistence all unchanged
    - **EXPECTED OUTCOME**: tests PASS (no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 10. Checkpoint — build, typecheck, and confirm untouched files
  - Run `npx tsc --noEmit` — **must PASS**
  - Run `npx vite build` — **must PASS**
  - Confirm zero diff in `src/services/crypto.ts`, `src/components/CashbookForm.tsx`, `src/db/captureRepo.ts`, and `src/utils/syncEngine.ts` (e.g. `git diff --stat` shows none of these)
  - Confirm no new crypto dependency was added (inspect `package.json`), no server-side `pin_hash` column, no writes to `auth.users`/`profiles`
  - If any check fails, fix within the allowed surface; ask the user if questions arise
  - _Requirements: 3.2, 3.6, 3.7_

---

## Task Dependency Graph

```
1  (explore, optional) ─┐
2  (preserve, optional) ─┤   both run on UNFIXED code, before any fix
                         │
3  schema.ts  ───────────┼──> 5  authService (5.1, 5.2, 5.3)
                         │          │
4  LoginForm (userId) ───┼──────────┤
                         │          │
                         ├──> 6  cacheLoader (needs 3's SyncMeta field)
                         │          │
                         ├──> 7  online-required screen
                         │          │
   3,4,5,6,7  ───────────┴──> 8  LoginPage orchestration (core fix)
                                    │
                                    ├──> 9.1 / 9.2  (optional, re-run tests 1 & 2)
                                    │
                                    └──> 10  Checkpoint (tsc + vite build + untouched-files)
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"] },
    { "wave": 2, "tasks": ["3"] },
    { "wave": 3, "tasks": ["4", "5", "6", "7"] },
    { "wave": 4, "tasks": ["8"] },
    { "wave": 5, "tasks": ["9.1", "9.2", "10"] }
  ]
}
```

- Tasks **1** and **2** have no code dependencies and must execute first (on unfixed code).
- Task **3** (schema) unblocks **5** (service), **6** (cacheLoader needs `SyncMeta.lastActiveUserId`), and feeds the credential shape used in **8**.
- Task **4** (plumb `userId`/window) and tasks **5**, **6**, **7** are prerequisites for **8** (`LoginPage` consumes `ctx.userId`, `stageCredentialRefresh`, `unlockOffline(pin, userId)`, the pointer, and the new screen).
- Task **8** is the integration point; **9** (optional) re-runs the property tests against the fixed code, and **10** is the mandatory final checkpoint.

## Notes

- **Hard constraints (reminder).** Keep the existing WebCrypto PBKDF2-SHA256 +
  PIN-keyed HMAC primitives in `src/services/crypto.ts` untouched — no bcrypt, no new
  crypto dependency, no server-side `pin_hash` column, no writes to
  `auth.users`/`profiles`. The fix surface is confined to `src/features/auth/*`,
  `src/services/authService.ts`, `src/db/schema.ts`, and one read-merge-write in
  `src/utils/cacheLoader.ts`. Do NOT touch `src/components/CashbookForm.tsx`,
  `src/db/captureRepo.ts`, or `src/utils/syncEngine.ts`. Fail closed throughout, and
  never delete or overwrite another user's credential (multi-user coexistence, 3.8).
- **Out-of-scope follow-up.** The latent `revalidateOnReconnect` concern noted in the
  design is intentionally out of scope for this bugfix and is left for a separate spec;
  this plan does not modify that path.
