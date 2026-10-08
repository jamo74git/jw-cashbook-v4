# Offline PIN Flow Fix — Bugfix Design

## Overview

The offline PIN authentication flow (`/login` → `LoginPage`) is meant to let a field
user set an offline PIN on their first successful **online** login and later **unlock
offline** against a locally cached credential (Dexie `credentials` store, keyed by
`userId`). The approved `bugfix.md` establishes that every decision in this flow is
currently made against a **global** view of the credential store rather than the
**authenticating user's own** credential, which produces four defects (A, B, C, D).

The fix is an orchestration correction, not a feature. It makes every PinSetup /
unlock / refresh decision key off the authenticating user's own credential via
`db.credentials.get(userId)`, plumbs the authenticated `userId` through
`AuthenticatedContext`, resolves the offline "relevant user" through a single
`lastActiveUserId` pointer, replaces the offline dead-end with an explicit
"sign in online first" screen, and refreshes an existing credential's server-derived
fields on online login **without breaking the PIN-keyed HMAC integrity binding**.

The fix surface is confined to `src/features/auth/*`, plus narrowly scoped changes to
`src/services/authService.ts` and `src/db/schema.ts`. The existing WebCrypto
PBKDF2-SHA256 + PIN-keyed HMAC primitives (`src/services/crypto.ts`) are untouched. The
flow fails closed throughout, and no user's credential is ever deleted or overwritten on
behalf of another user.

## Glossary

- **Bug_Condition (C)**: The auth-flow decision state in which a PinSetup / offline-entry
  / online-login decision is made against a global credential view (or against a
  different user's credential) instead of the authenticating user's own credential — the
  formal `isBugCondition(X)` from `bugfix.md`.
- **Property (P)**: The desired post-fix behavior for inputs where C holds — a usable
  per-user credential is offered/persisted, offline-with-no-credential shows an explicit
  online-required screen (never a PIN prompt or unusable password form), an existing
  credential is refreshed with its HMAC binding preserved, and every decision is keyed to
  the authenticating `userId`.
- **Preservation**: Behaviors that must remain identical for `NOT C` inputs — offline
  unlock against the correct per-user credential, PBKDF2 + PIN-keyed HMAC crypto, the
  failed-attempt lockout, fail-closed semantics, raw-PIN never persisted, dashboard
  routing via `getDashboardRoute`, and multi-user credential coexistence.
- **Cached_Credential**: A `CachedCredential` row in the Dexie `credentials` store, keyed
  by `userId` (`src/db/schema.ts`). Holds `pinHash`, `salt`, `kdfIterations`, `hmac`,
  `role`, `accessStartDate`, `accessEndDate`, `activatedAt`, `failedAttempts`,
  `lockedUntil`.
- **AuthenticatedContext**: The object `LoginForm` passes to `onAuthenticated` after a
  successful online login. Carries `email`, `password` (transient, in-memory only),
  `role`, `turnstileToken`. The fix adds `userId`.
- **lastActiveUserId**: A new pointer stored in `syncMeta.global` recording the id of the
  user who most recently authenticated online / activated / unlocked offline. Used to
  resolve the "relevant user" for offline mode selection (there is no authenticated
  Supabase user offline).
- **PIN-keyed HMAC binding**: The HMAC over the credential's integrity-protected fields,
  keyed by a PIN-derived key (`computeHmac`/`verifyHmac` in `src/services/crypto.ts`).
  Recomputing it requires the raw PIN, which a password-only online login does not have.
- **Rebind-at-unlock (staged refresh)**: The mechanism by which server-derived fields
  gathered during a password-only online login are staged on the credential and
  committed into the HMAC-protected set (with the HMAC recomputed) at the next offline
  unlock, where the PIN is in hand.

## Bug Details

### Bug Condition

The bug manifests whenever an offline-credential decision (show PinSetup, choose the
initial offline mode, or pick the unlock target) is driven by a **global**
`db.credentials.count()` / first-record lookup instead of the **authenticating user's
own** `db.credentials.get(userId)`, and whenever `AuthenticatedContext` discards
`data.user.id` so `LoginPage` cannot key its decision to that user. It also manifests
when `PinSetup`'s Skip strands the user with no persisted credential, and when offline
entry with no credential for the relevant user dead-ends on an unusable password form.

**Formal Specification** (reproduced from `bugfix.md`, the authoritative source):

```
FUNCTION isBugCondition(X)
  INPUT: X = {
    online: boolean,
    authenticatingUserId: string|null,
    credentialExistsForThisUser: boolean,   // CachedCredential keyed to authenticatingUserId
    anyCredentialExists: boolean,            // ANY CachedCredential on the device
    action: enum   // "pinSetupSkipped" | "offlineEntry" | "onlineLogin"
  }
  OUTPUT: boolean

  RETURN
    // A: first online login, no credential FOR THIS USER, user skips -> nothing persisted
    (X.online = true  AND X.credentialExistsForThisUser = false AND X.action = "pinSetupSkipped")
    // B: offline with nothing cached FOR THIS USER -> unusable password form / wrong prompt
    OR (X.online = false AND X.credentialExistsForThisUser = false AND X.action = "offlineEntry")
    // C: online login with an existing credential FOR THIS USER -> never refreshed
    OR (X.online = true  AND X.credentialExistsForThisUser = true  AND X.action = "onlineLogin")
    // D: identity mismatch — a credential exists for a DIFFERENT user but not this one,
    //    yet global decision logic treats "any credential exists" as this user's
    OR (X.credentialExistsForThisUser = false AND X.anyCredentialExists = true
          AND X.action IN { "onlineLogin", "offlineEntry" })
END FUNCTION
```

### Examples

- **Defect D / A (verified repro):** A browser holds a prior/other user's credential.
  `treasurer@bosmont.test` logs in online. `handleAuthenticated` branches on the global
  `db.credentials.count()` (`existing > 0`), suppresses `PinSetup`, and routes straight to
  the dashboard. The treasurer never gets to set their own PIN. (`credentialExistsForThisUser = false`, `anyCredentialExists = true`, `action = "onlineLogin"`.)
- **Defect D / B:** The same browser goes offline. The initial-mode effect uses the global
  `db.credentials.count()` to choose `pin-unlock`, prompting for a PIN bound to the other
  user; `unlockOffline(pin)` with no `userId` validates against
  `(await db.credentials.toArray())[0]` — the wrong record.
- **Defect A:** A fresh browser, first online login, user clicks **Skip** on `PinSetup`.
  `onDone(role)` navigates to the dashboard without calling `activateOffline`; no
  credential is persisted. Later offline the user cannot unlock.
- **Defect B:** A fresh browser opened offline with no credential. The initial-mode effect
  sends `(!online && credCount === 0)` to the password form, which calls
  `supabase.auth.signInWithPassword` — impossible offline — surfacing a generic error with
  no instruction to go online first.
- **Defect C:** A user with their own credential logs in online after a role change.
  `handleAuthenticated` sees `existing > 0` and navigates to the dashboard; the cached
  `role`/access window are never refreshed.
- **Edge (identity, offline):** `lastActiveUserId` points to a user with no credential
  (e.g. they skipped setup). Offline entry must show the online-required screen, never a
  PIN prompt against someone else's record.

## Expected Behavior

### Preservation Requirements

**Unchanged behaviors** (must be byte-for-byte equivalent for `NOT C` inputs):

- Offline with a valid credential **for the relevant user** + correct PIN still unlocks
  and establishes a provisional offline session, including the failed-attempt lockout
  after `MAX_FAILED_ATTEMPTS` (`bugfix.md` 3.1).
- Offline PIN setup / validation still uses the existing WebCrypto PBKDF2-SHA256 hashing
  and PIN-keyed HMAC integrity check — no bcrypt, no new crypto dependency, no
  server-side `pin_hash` column (3.2).
- Every failure in online-login / offline-unlock / reconnect re-validation still fails
  closed and never falls through to a dashboard (3.3).
- A successful online login with valid, in-window access (including the HO
  district-assignment check) still routes via `getDashboardRoute` (3.4).
- Reconnect re-validation of a revoked/expired user still invalidates the credential and
  ends the session (3.5).
- The raw PIN is still never persisted; only `pinHash`, `salt`, `hmac` (and work factor)
  are stored (3.6).
- `src/components/CashbookForm.tsx`, `src/db/captureRepo.ts`, and
  `src/utils/syncEngine.ts` are left unchanged (3.7).
- Multiple users' credentials still coexist, keyed by `userId`; per-user decisions never
  delete or overwrite another user's credential (3.8).

**Scope.** All inputs where `isBugCondition(X)` is false are unaffected: offline unlock
of the relevant user's own credential, first online login with no credential offering
"Set PIN", and every fail-closed path behave exactly as before.

> The actual expected correct behavior for buggy inputs is defined in the Correctness
> Properties section (Property 1 and its sub-properties). This section records what must
> NOT change.

## Hypothesized Root Cause

Confirmed by reading the committed code (`LoginPage.tsx`, `LoginForm.tsx`,
`authService.ts`, `schema.ts`):

1. **Identity-blind decisions (root cause).** All PinSetup / offline-mode / unlock
   decisions use a global view of the store:
   - `LoginPage.handleAuthenticated` branches on `db.credentials.count()` (`existing > 0`).
   - The initial-mode effect chooses `pin-unlock` from the same global `credCount > 0`.
   - `unlockOffline(pin)` with no `userId` selects `(await db.credentials.toArray())[0]`.
   The Dexie store is keyed by `userId` and supports multi-user coexistence, but none of
   the decision logic consults the per-user record.

2. **`userId` not plumbed.** `AuthenticatedContext` (returned by `LoginForm`) omits
   `data.user.id`, so `LoginPage` has no identity to key decisions on even if it wanted
   to.

3. **Skip persists nothing.** `PinSetup`'s Skip calls `onDone(role)` and navigates
   without `activateOffline`, leaving no credential and a future offline dead-end.

4. **Offline-with-no-credential routes to an unusable password form.** The initial-mode
   effect sends `(!online && credCount === 0)` to `LoginForm`, which cannot authenticate
   offline and gives no "go online first" guidance.

5. **No refresh on online login.** `handleAuthenticated` navigates away whenever a
   credential exists and never refreshes its server-derived fields. (And the existing
   `revalidateOnReconnect` mutates HMAC-covered fields *without* recomputing the HMAC — a
   latent integrity break noted below.)

## Correctness Properties

Property 1: Bug Condition — Per-user offline PIN flow is correct and usable

_For any_ input `X` where the bug condition holds (`isBugCondition(X)` returns true), the
fixed login/unlock flow SHALL produce a result keyed to the authenticating (or relevant)
user's own credential such that: (A) a skipped first-time setup leaves no reachable
offline dead-end; (B) offline with no credential for the relevant user shows an explicit
online-required screen and never a PIN prompt or unusable password form; (C) an existing
credential's role and access window are refreshed on online login while the PIN-keyed
HMAC binding remains valid; and (D) every decision is keyed to the authenticating
`userId`'s own credential, so a different user's credential never suppresses this user's
PinSetup nor drives an unlock prompt against it.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**

Property 2: Preservation — Non-buggy flow unchanged

_For any_ input `X` where the bug condition does NOT hold (`isBugCondition(X)` returns
false), the fixed flow SHALL produce the same observable result as the original flow:
offline unlock of the relevant user's own credential still succeeds (with the same
lockout), first online login with no credential still offers "Set PIN" via the existing
PBKDF2-SHA256 + PIN-keyed HMAC activation, dashboard routing is unchanged, and every
failure still fails closed.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

### Sub-properties (per-defect, for traceability)

- **P1-A (Skip, defect A).** _For any_ first online login with no credential for the
  authenticating user where the user skips setup, no later offline state reachable from
  that skip presents a PIN prompt or an unusable password dead-end; offline entry resolves
  to the online-required screen. **Validates: 2.1.**
- **P1-B (Offline no-credential, defect B).** _For any_ offline entry where no credential
  exists for the relevant user, the result screen is `online-required`, with no PIN prompt
  and no password-only dead-end. **Validates: 2.2, 2.6.**
- **P1-C (Refresh + integrity, defect C).** _For any_ online login where a credential
  exists for the authenticating user, that credential's `role`/access window are refreshed
  from the server and the credential's HMAC still verifies against the entered PIN at the
  next unlock (binding valid). **Validates: 2.3.**
- **P1-D (Identity keying, defect D).** _For any_ decision where a credential exists for a
  different user but not the authenticating/relevant user, the decision is based on
  `db.credentials.get(thisUserId)`: online ⇒ `pin-setup`; offline ⇒ `online-required` with
  no PIN prompt. **Validates: 2.5, 2.6, 2.7.**
- **P1-E (Unlock target, defect D).** _For any_ offline unlock, `unlockOffline` validates
  against the resolved user's credential (`db.credentials.get(userId)`), never the
  first/arbitrary record. **Validates: 2.4, 2.7.**

## Fix Implementation

### Changes Required

Assuming the root-cause analysis is correct, the fix touches four files. Crypto
primitives (`src/services/crypto.ts`) are **not** changed.

---

#### File: `src/features/auth/LoginForm.tsx` — plumb `userId`

Add the authenticated user id to the handoff context. Password remains transient
(in-memory only, never persisted), exactly as today.

```ts
export interface AuthenticatedContext {
  userId: string;          // NEW — data.user.id from signInWithPassword
  email: string;
  password: string;        // transient; used only by activateOffline, never persisted
  role: Role;
  turnstileToken: string | null;
}
```

In `handleSubmit`, after Step 4 succeeds, include the id already available on `data.user`:

```ts
if (onAuthenticated) {
  onAuthenticated({ userId: data.user.id, email: email.trim(), password, role, turnstileToken });
} else {
  navigate(getDashboardRoute(role));
}
```

No other `LoginForm` logic changes; the four-step online gate (Turnstile → auth →
active access → HO district check) and its fail-closed sign-outs are preserved (3.3, 3.4).

---

#### File: `src/db/schema.ts` — `lastActiveUserId` pointer + optional staged-refresh fields

**(a) `SyncMeta` gains a pointer** used to resolve the offline "relevant user". Adding a
non-indexed property to `syncMeta` (whose store is keyed only by `key`) requires **no
Dexie version bump**.

```ts
export interface SyncMeta {
  key: string;
  lastSyncAt: string | null;
  lastReferenceRefreshAt: string | null;
  schemaVersion: number;
  lastActiveUserId?: string | null;   // NEW — who last authenticated online / unlocked
}
```

> Note: `cacheLoader.refreshReferenceCache` rewrites `syncMeta.global`. Its `put` must be
> updated to preserve `lastActiveUserId` (read-merge-write), the same way it already
> preserves `lastSyncAt`. This is the only reason `cacheLoader.ts` is touched; its data
> contract is otherwise unchanged.

**(b) `CachedCredential` gains staged-refresh fields** to support rebind-at-unlock (see
the HMAC-refresh decision). These are **outside** the HMAC-protected set by design and
hold *untrusted-until-bound* server values:

```ts
export interface CachedCredential {
  // ...existing fields unchanged...
  // Staged server-derived refresh captured during a password-only online login,
  // committed into the HMAC-protected set (with HMAC recomputed) at next unlock.
  pendingRole?: Role | null;
  pendingAccessStartDate?: string | null;
  pendingAccessEndDate?: string | null;
  pendingRefreshedAt?: string | null;
}
```

Adding non-indexed properties also needs no version bump. (There is no production offline
data; the v2 upgrade already clears legacy rows.)

---

#### File: `src/services/authService.ts` — per-user targeting, staged refresh, rebind-at-unlock

1. **`unlockOffline(pin, userId?)` — require the resolved user (defect D / P1-E).**
   Callers now always pass `userId`; keep the signature backward-compatible but prefer the
   per-user `get`. The existing integrity-first → PIN → lockout flow is preserved (3.1).

   On **successful** unlock, additionally:
   - set `syncMeta.global.lastActiveUserId = credential.userId`;
   - **commit any staged refresh** (rebind-at-unlock), since the PIN is now in hand:

   ```
   FUNCTION unlockOffline(pin, userId):
     credential <- db.credentials.get(userId)            // never toArray()[0]
     ... existing locked / integrity / pin / lockout logic UNCHANGED ...
     ON SUCCESS:
       reset failedAttempts/lockedUntil                  // unchanged
       IF credential has a pending refresh THEN
         newFields <- { role: pendingRole,
                        accessStartDate: pendingAccessStartDate,
                        accessEndDate: pendingAccessEndDate }
         newHmac <- computeHmac(integrityMessage({ ...core, ...newFields,
                                                   activatedAt: pendingRefreshedAt }),
                                pin, salt, kdfIterations)   // PIN available here
         db.credentials.update(userId, { ...newFields, activatedAt: pendingRefreshedAt,
                                         hmac: newHmac,
                                         pendingRole: null, pendingAccessStartDate: null,
                                         pendingAccessEndDate: null, pendingRefreshedAt: null })
       END IF
       set syncMeta.lastActiveUserId = userId
       establish session (from the now-current fields)
   ```

   The integrity check still runs against the **currently stored** HMAC-protected fields
   before any commit, so a tampered record is still rejected and locked (3.1, invariant
   #10). The commit only runs after both integrity and PIN pass.

2. **`activateOffline(...)` — set the pointer.** On successful activation, also set
   `syncMeta.global.lastActiveUserId = auth.user.id`. Activation already writes a fresh
   HMAC over fresh server fields, so no staged refresh is needed there.

3. **New helper `stageCredentialRefresh(userId, serverFields)`** (called by `LoginPage`
   on online login when a credential exists):

   ```
   FUNCTION stageCredentialRefresh(userId, { role, accessStartDate, accessEndDate }):
     cred <- db.credentials.get(userId)
     IF NOT cred THEN return               // nothing to refresh; caller handles PinSetup
     db.credentials.update(userId, {
       pendingRole: role,
       pendingAccessStartDate: accessStartDate,
       pendingAccessEndDate: accessEndDate,
       pendingRefreshedAt: new Date().toISOString(),
     })
     set syncMeta.lastActiveUserId = userId
   ```

   This leaves the HMAC-protected `role`/access untouched (binding stays valid), records
   the fresh server values, and commits them at the next unlock where the PIN is present.

4. **`revalidateOnReconnect` latent-bug note.** The current implementation updates
   `role`/`accessStartDate`/`accessEndDate`/`activatedAt` directly, which are HMAC-covered,
   **without** recomputing the HMAC — so the next offline unlock's integrity check would
   fail. This is pre-existing and strictly out of this bug's scope, but the same
   rebind-at-unlock mechanism resolves it: `revalidateOnReconnect` should stage via the
   pending-* fields instead of mutating the protected set. **Recommendation:** apply the
   same staging here for consistency; if deferred, record it as a follow-up Known Issue.
   (The revoked/expired → delete-credential + end-session path, 3.5, is unchanged.)

> `integrityMessage(...)` and all crypto functions remain exactly as written. The
> HMAC-protected field set is unchanged; refresh is achieved by staging + rebinding, not
> by narrowing the HMAC.

---

#### File: `src/features/auth/LoginPage.tsx` — per-user orchestration (core fix)

Replace every global `db.credentials.count()` decision with per-user `db.credentials.get`.

**Initial-mode effect (offline relevant-user resolution).**

```
EFFECT on `online`:
  IF online THEN
    setMode("password")                      // online always starts at password
    RETURN
  // offline: resolve the relevant user via the pointer, then gate on real existence
  meta <- db.syncMeta.get("global")
  uid  <- meta?.lastActiveUserId ?? null
  cred <- uid ? await db.credentials.get(uid) : undefined
  IF cred THEN setMode("pin-unlock", target=uid)   // P1-E unlock target = uid
  ELSE        setMode("online-required")           // P1-B / P1-D: never a stray PIN prompt
```

Fail-closed: a null pointer, a missing credential, or any read error ⇒ `online-required`
(offline) and never a PIN prompt.

**`handleAuthenticated(ctx)` (online path).**

```
FUNCTION handleAuthenticated(ctx):   // ctx now includes ctx.userId
  autoRefreshReferenceCache()                        // unchanged
  existing <- await db.credentials.get(ctx.userId)   // PER-USER, not count()
  IF existing THEN
    // Defect C / P1-C: stage server-derived refresh (role/access from ctx) with
    // the HMAC binding preserved; committed at next unlock.
    await stageCredentialRefresh(ctx.userId, {
      role: ctx.role, accessStartDate: existing.accessStartDate, /* window from access */
      accessEndDate: existing.accessEndDate,
    })
    navigate(getDashboardRoute(ctx.role))            // routes with FRESH role immediately
    RETURN
  // Defect D / P1-D: no credential for THIS user -> offer setup (even if others exist)
  setAuthCtx(ctx)
  setMode("pin-setup")
```

> To refresh the access **window** (not just role), `LoginForm` already queries
> `start_date`/`end_date` in Step 2; include them in `AuthenticatedContext` (as
> `accessStartDate`/`accessEndDate`) so `stageCredentialRefresh` has the live window.
> This is a small additive change to the context shape alongside `userId`.

**PinSetup Skip (defect A / P1-A).** Keep Skip, but (1) require an explicit confirmation
that offline capture will be unavailable until a PIN is set, and (2) ensure Skip sets **no**
"setup complete" flag and persists **no** credential. Because offline mode selection now
gates on real per-user credential existence, a skipped setup resolves offline to
`online-required` — not a PIN prompt and not an unusable password form — so no offline
dead-end is reachable (P1-A). (Removing Skip entirely is an acceptable alternative; keeping
a confirmed Skip is recommended for UX parity.)

```
Skip pressed:
  confirmed <- window.confirm("Offline capture will be unavailable until you set a PIN. Continue?")
  IF confirmed THEN onDone(ctx.role)   // navigate; NO credential persisted, NO false flag
```

### Mode State Machine

States: `loading | password | pin-setup | pin-unlock | online-required`.

```
                      ┌─────────┐
                      │ loading │  (initial; resolves on `online`)
                      └────┬────┘
         online │          │          │ offline
                 ▼          │          ▼
           ┌──────────┐     │   resolve lastActiveUserId -> cred?
           │ password │◄────┘        │                 │
           └────┬─────┘          cred│exists        no cred / null / error
                │                     ▼                 ▼
   handleAuthenticated(ctx)     ┌───────────┐    ┌─────────────────┐
                │               │ pin-unlock│    │ online-required │
   get(ctx.userId)             └────┬──────┘    └────────┬────────┘
     ┌──────────┴───────────┐       │ unlock ok          │ "use password" / go online
     │ exists                │ none  │ ▼                  ▼
     ▼                       ▼  navigate(dashboard)   ┌──────────┐
 stage refresh          ┌──────────┐  [terminal]      │ password │
 navigate(dashboard)    │ pin-setup│                  └──────────┘
 [terminal]             └────┬─────┘
                     set ok  │  skip (confirmed)
                        ▼     ▼
                   navigate(dashboard) [terminal]
```

Transitions:

| From | Event | Guard | To |
|------|-------|-------|-----|
| loading | effect resolves | `online` | password |
| loading | effect resolves | offline AND `get(lastActiveUserId)` exists | pin-unlock |
| loading | effect resolves | offline AND (no pointer / no cred / read error) | online-required |
| password | `onAuthenticated(ctx)` | `get(ctx.userId)` is undefined | pin-setup |
| password | `onAuthenticated(ctx)` | `get(ctx.userId)` exists → stage refresh | → navigate(dashboard) |
| pin-setup | activate ok | — | → navigate(dashboard) |
| pin-setup | skip confirmed | — | → navigate(dashboard) (no credential persisted) |
| pin-unlock | unlock ok | — | → navigate(dashboard) |
| pin-unlock | "use password" | — | password |
| pin-unlock | locked | — | stay (error shown); offer online re-auth |
| online-required | "go online" / "use password" | — | password |
| any | `online` flips true→false | — | re-run initial-mode effect (fail-closed) |

The effect re-runs when `online` changes, so a transient `navigator.onLine` value cannot
permanently strand the user: when connectivity flips the mode is re-resolved.

### HMAC-Refresh Decision (rationale)

**Problem.** The PIN-keyed HMAC covers `role`/`accessStartDate`/`accessEndDate`/
`activatedAt` (via `integrityMessage`). Recomputing it requires the raw PIN. A password-only
online login never has the PIN, so it cannot re-sign the HMAC. Requirement 2.3 / Fix-Checking
C demands both `credentialRefreshed` **and** `integrityBindingValid`.

**Options considered.**

1. **Mutate protected fields on login without re-signing** — rejected: breaks the next
   unlock's integrity check (this is exactly the latent `revalidateOnReconnect` bug) and
   violates `integrityBindingValid`.
2. **Move server-derived fields outside the HMAC-protected set** — rejected: it preserves a
   (narrower) binding but removes the designed tamper-evidence of cached role/access that
   `crypto.ts` and Steering invariant #10 explicitly call for.
3. **Prompt for the PIN on every online login to re-sign** — rejected: poor UX and
   effectively forces re-activation on each login.
4. **Rebind-at-unlock (staged refresh)** — **chosen.** Online login stages the fresh
   server values in non-protected `pending*` fields and routes to the dashboard with the
   fresh role immediately; the protected fields and their HMAC are untouched (binding stays
   valid). At the next offline unlock, where the PIN is in hand, the staged values are
   committed into the protected set and the HMAC is recomputed with the entered PIN.

**Why option 4 satisfies the constraints.**

- **Refresh (2.3).** The credential is updated on the online login (pending fields recorded)
  and the user's current session routes with the fresh server role immediately; the cached
  authoritative fields are reconciled at the next unlock. `credentialRefreshed` holds.
- **Integrity preserved (invariant #10, 3.2, 3.6).** The HMAC-protected set and its binding
  are never invalidated; role/access remain tamper-evident because they stay under the HMAC.
  The staged `pending*` values are explicitly untrusted until the PIN re-signs them, so a
  tampered pending value cannot grant elevated offline access — the integrity check still
  runs against the protected set first, and the commit only happens after PIN + integrity
  succeed.
- **No new crypto (3.2).** Only `computeHmac`/`verifyHmac`/`derivePinHash`/`verifyPin` are
  reused; no bcrypt, no server-side `pin_hash`, no writes to `auth.users`/`profiles`.
- **Raw PIN never persisted (3.6).** The PIN is used transiently inside `unlockOffline` to
  recompute the HMAC and is never stored.

### Error / Fail-closed Handling

- Any Dexie read error during mode resolution (offline) ⇒ `online-required`; never a PIN
  prompt (fail-closed, 3.3).
- `online-required` offers only "sign in online" / "use password"; it never calls an auth
  primitive itself, so it cannot dead-end.
- `handleAuthenticated` only runs after `LoginForm`'s full online gate has passed; its
  own sign-out-on-failure branches are untouched (3.3, 3.4).
- `unlockOffline` keeps integrity-first → PIN → lockout ordering and the
  `MAX_FAILED_ATTEMPTS` lock (3.1); a tampered record is still locked, not committed.
- `revalidateOnReconnect`'s revoked/expired path still deletes the credential and ends the
  session (3.5).
- The staged-refresh commit is wrapped so a failure to recompute/write the HMAC aborts the
  commit and leaves the prior valid credential intact (never a half-written protected set).
- No code path deletes or overwrites another user's credential; all writes are keyed by the
  resolved `userId` (3.8).

## Testing Strategy

### Validation Approach

Two phases. First, surface counterexamples that demonstrate each defect on the **unfixed**
code; then verify the fix produces the Fix-Checking property for buggy inputs and preserves
behavior for non-buggy inputs. Decisions are keyed to `db.credentials.get(userId)`, so tests
seed the Dexie store with specific per-user credentials and assert the chosen screen /
unlock target. (The project uses Vitest; WebCrypto is available under Node ≥ 20, so crypto
paths run unmodified. Dexie is exercised via `fake-indexeddb` or an equivalent in-memory
adapter.)

### Exploratory Bug Condition Checking (run on UNFIXED code first)

**Goal.** Confirm the root cause by observing each defect fail before the fix.

Test cases (expected to fail / misbehave on unfixed code):

1. **D-suppress-setup.** Seed a credential for `userB`; drive `handleAuthenticated` for
   `userA` (no credential). Unfixed: routes to dashboard (PinSetup suppressed). (will fail)
2. **D-wrong-unlock.** Seed credentials for `userB` then `userA`; call `unlockOffline(pin)`
   with no `userId`. Unfixed: validates against `toArray()[0]` (wrong user). (will fail)
3. **D-offline-prompt.** Seed `userB` only; open offline intending `userA`. Unfixed: shows
   `pin-unlock` against `userB`. (will fail)
4. **A-skip.** First online login, click Skip. Unfixed: no credential persisted. (will fail
   the "credential exists after setup choice" expectation / later offline dead-ends)
5. **B-offline-deadend.** Offline, empty store. Unfixed: renders the password form.
   (will fail — expected `online-required`)
6. **C-no-refresh.** Credential exists for `userA` with stale role; online login with a new
   server role. Unfixed: cached role unchanged. (will fail)

**Expected counterexamples.** Global `count()`/first-record logic ignores identity; Skip
persists nothing; offline-empty renders an unusable password form; existing credential never
refreshed.

### Fix Checking

**Goal.** For all inputs where the bug condition holds, the fixed flow produces the
expected behavior (Property 1 / P1-A..E).

```
FOR ALL X WHERE isBugCondition(X) DO
  result := loginFlow'(X)
  ASSERT
    (X.action = "pinSetupSkipped"  IMPLIES NOT reachesOfflineDeadEnd(result))              // P1-A / 2.1
    AND (X.action = "offlineEntry" AND NOT X.credentialExistsForThisUser IMPLIES
           result.screen = "online-required" AND NOT result.promptsPin AND NOT result.deadEnd) // P1-B / 2.2,2.6
    AND (X.action = "onlineLogin"  AND X.credentialExistsForThisUser IMPLIES
           result.credentialRefreshed AND result.integrityBindingValid)                    // P1-C / 2.3
    AND (NOT X.credentialExistsForThisUser AND X.anyCredentialExists IMPLIES
           (X.online  IMPLIES result.screen = "pin-setup")
           AND (NOT X.online IMPLIES result.screen = "online-required" AND NOT result.promptsPin)) // P1-D / 2.5,2.6,2.7
END FOR
```

Representative unit/integration assertions:

- **P1-A.** After confirmed Skip, assert no credential row exists for the user AND the
  offline mode-resolver returns `online-required` (not `pin-unlock`).
- **P1-B.** Offline, empty store ⇒ `online-required`; assert no PIN input is rendered and
  the screen exposes a route back to the password form.
- **P1-C.** Seed credential + known HMAC; online login with a new role ⇒ assert `pending*`
  fields are set and the stored HMAC is unchanged; then unlock with the correct PIN ⇒
  assert `role` is updated, `pending*` cleared, and `verifyHmac` passes against the new
  protected set (binding valid).
- **P1-D.** Seed `userB` only; `handleAuthenticated(userA)` ⇒ `pin-setup`; offline resolver
  for a pointer to `userA` (no cred) ⇒ `online-required`.
- **P1-E.** `unlockOffline(pin, userA)` validates against `userA`'s credential even when
  `userB`'s is first in the store.

### Preservation Checking

**Goal.** For all inputs where the bug condition does NOT hold, the fixed flow equals the
original.

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT loginFlow(X) = loginFlow'(X)
END FOR
```

Property-based testing is recommended here: generate random credential sets, user ids,
PINs, and connectivity, filtered to `NOT isBugCondition(X)`, and assert the fixed flow's
screen/unlock outcome matches the original's for those inputs. PBT covers the input domain
(multiple coexisting users, correct/incorrect PINs, lockout thresholds) more thoroughly
than hand-written cases.

Observe-then-pin test cases (observe on unfixed code, then lock in after fix):

1. **Unlock + lockout (3.1).** Valid credential for the relevant user; correct PIN unlocks;
   wrong PIN increments `failedAttempts` and locks at `MAX_FAILED_ATTEMPTS`.
2. **Crypto unchanged (3.2, 3.6).** `derivePinHash`/`computeHmac`/`verifyPin`/`verifyHmac`
   outputs identical for the same inputs; store contains only `pinHash`/`salt`/`hmac`
   (no raw PIN).
3. **Fail-closed (3.3).** Each failed step (bad auth, no access, out-of-window, HO with no
   districts, tampered HMAC, TTL) blocks and never reaches a dashboard.
4. **Dashboard routing (3.4).** Valid in-window online login routes via
   `getDashboardRoute(role)`.
5. **Revoke/expire (3.5).** `revalidateOnReconnect` on a revoked user deletes the credential
   and ends the session.
6. **Multi-user coexistence (3.8).** Operating on `userA` never mutates/deletes `userB`'s
   credential.

### Unit Tests

- `LoginForm`: `AuthenticatedContext` includes `userId` (and access window) from `data.user`.
- `LoginPage`: mode resolution table (online→password; offline+cred→pin-unlock;
  offline+no-cred/null/error→online-required); `handleAuthenticated` per-user branch.
- `authService.unlockOffline(pin, userId)`: targets the correct record; stages→commits
  refresh; preserves lockout + integrity-first ordering.
- `authService.stageCredentialRefresh`: sets `pending*`, leaves protected HMAC untouched,
  sets `lastActiveUserId`.
- `schema`/`cacheLoader`: `refreshReferenceCache` preserves `lastActiveUserId` on its
  `syncMeta.global` write.

### Property-Based Tests

- Generate random `(credentialSet, authUserId, online)` ⇒ assert the resolved screen equals
  the identity-keyed specification (P1-D / P1-B over the generated domain).
- Generate random `(storedRole, storedWindow, serverRole, serverWindow, pin)` ⇒ stage on
  login then unlock ⇒ assert the committed credential matches the server values and
  `verifyHmac` passes (P1-C), and that an un-committed (login-only) state still verifies
  against the original protected set.
- Generate random non-buggy inputs ⇒ assert `loginFlow == loginFlow'` (Property 2).

### Integration Tests

- Full flow: online login (no cred) → PinSetup → activate → sign out → offline → pin-unlock
  → dashboard.
- Full flow: online login (no cred) → Skip (confirmed) → offline → `online-required` (no
  dead-end).
- Multi-user: `userB` cred present → online login as `userA` → PinSetup; offline with
  pointer→`userA` (no cred) → `online-required`; `userB` still unlockable.
- Refresh: role changes server-side → online login stages → offline unlock commits new role
  → `/capture` route guard sees the reconciled role.
