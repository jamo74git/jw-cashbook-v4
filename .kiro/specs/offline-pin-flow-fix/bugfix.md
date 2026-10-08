# Bugfix Requirements Document

## Introduction

The OAC Cashbook PWA offers offline PIN authentication for field capture (`/capture`). A
field user (e.g. a Treasurer) is meant to set an offline PIN during their first
successful **online** login so that, later, they can **unlock offline** against a locally
cached credential (Dexie `credentials` store). Offline auth is a provisional convenience
gate; Supabase RLS + reconnect re-validation remain authoritative (Steering invariant
#10).

**Reported symptom.** A Treasurer is never left with a usable offline PIN after online
login, and a later offline attempt dead-ends: the app either prompts for a PIN that was
never set (and may be bound to someone else's credential), or shows a password form that
cannot authenticate without a connection, with no guidance to go online first.

**Standalone bugfix.** This is a bug-condition–methodology bugfix. It is NOT a new
feature and is explicitly NOT task B1 (SUPER_ADMIN role) of the `foundation-slice-7e`
spec.

### Concrete repro (verified scenario)

Observed on a browser that already held a cached credential from a prior/other user:

1. Logged in **online** as `treasurer@bosmont.test` (a non-HO Treasurer). The PIN-setup
   screen was **NOT** shown; the user went straight to the dashboard.
2. Logged out, went **offline**. `LoginPage` showed the **PIN-unlock** prompt.
3. **Expected:** first online login with **no Dexie credential for that user** should
   show `PinSetup`; offline with **no credential for that user** should show a "sign in
   online first" message (never a PIN prompt).

The treasurer had never set their own PIN, yet (step 1) was denied setup and (step 2)
was prompted to unlock — against a credential that is not theirs.

**Verified root causes (confirmed by reading the committed code).** The current
`LoginPage` already routes offline + zero-credential to `password` mode rather than a PIN
prompt, so the literal "offline requests a PIN" wording reflects the user-observed
effect, not a single line. The decisive, verifiable defect is that **the
offline-credential decisions are not keyed to the authenticating user.** The Dexie
`credentials` store is keyed by `userId` (so multiple users can coexist on one device),
but all decision logic ignores identity:

- **Identity-blind — PinSetup suppressed.** `LoginPage.handleAuthenticated`
  (`src/features/auth/LoginPage.tsx`) branches on a **global** `db.credentials.count()`
  (`existing > 0`). If **any** credential exists (a prior/other user, or a stale record),
  the just-authenticated user skips `PinSetup` and routes straight to the dashboard — so
  a user who has never set *their own* PIN is never offered setup.
- **Identity-blind — offline mode.** `LoginPage`'s initial-mode effect also uses the
  **global** `db.credentials.count()` to choose `pin-unlock`, so offline it can present a
  PIN prompt bound to **someone else's** credential.
- **Identity-blind — unlock target.** `unlockOffline(pin)` with no `userId`
  (`src/services/authService.ts`) selects `(await db.credentials.toArray())[0]` — the
  first/any credential, not the current user's.
- **`userId` not plumbed.** `AuthenticatedContext` (returned by `LoginForm`) does not
  include the authenticated `userId` (`data.user.id` is discarded), so `LoginPage`
  currently *cannot* key the decision to the user who just authenticated. The fix must
  plumb `userId` through `AuthenticatedContext` and base PinSetup/unlock decisions on the
  per-user credential (`db.credentials.get(userId)`), not a global count/first-record.

This explains the repro: a pre-existing credential (count > 0) on that browser suppressed
`PinSetup` for the treasurer AND caused the offline PIN prompt — against a credential that
is not the treasurer's.

The previously captured, independent defects remain in scope:

- **A — Skip leaves no credential.** `PinSetup`'s "Skip" button
  (`src/features/auth/LoginPage.tsx`) calls `onDone(role)` and navigates to the dashboard
  WITHOUT calling `activateOffline`, so no `CachedCredential` is persisted. The user is
  now set up for an offline dead-end.
- **B — Offline with no credential dead-ends.** `LoginPage`'s initial-mode effect sends
  `(!online && credCount === 0)` to the `password` form. That form (`LoginForm`) calls
  `supabase.auth.signInWithPassword`, which cannot complete offline, and surfaces a
  generic "Invalid email or password" / network error with no instruction to connect to
  the internet and set up offline access first.
- **C — Credential not refreshed on online login.** `handleAuthenticated` navigates
  straight to the dashboard whenever a credential already exists (`existing > 0`) and
  never refreshes the cached credential's server-derived fields (role, access window) on
  that online login; any such refresh MUST preserve the PIN-keyed HMAC integrity binding.

(Entry point confirmed single: only `LoginPage` is routed at `/login` in `App.tsx`;
`OtpLoginForm.tsx` is Next.js-coupled legacy and is not routed — rules out a bypassing
entry point. The initial `online` flag from `useOnlineStatus` seeds from
`navigator.onLine`; mode selection must not strand a user on a transient value.)

### Bug Condition — C(X)

Let `X` describe the auth-flow decision state. Credential existence is now expressed
**per authenticating user**, not as a global count.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X = {
    online: boolean,                    // navigator connectivity at the decision point
    authenticatingUserId: string|null,  // id of the user who just authenticated (online),
                                        //   or the user the offline screen is intended for
    credentialExistsForThisUser: boolean, // a CachedCredential keyed to authenticatingUserId
                                        //   exists in the Dexie `credentials` store
    anyCredentialExists: boolean,        // ANY CachedCredential exists on the device
                                        //   (possibly a different/stale user)
    action: enum                        // "pinSetupSkipped" | "offlineEntry" | "onlineLogin"
  }
  OUTPUT: boolean

  RETURN
    // A: first online login, no credential FOR THIS USER, user skips -> nothing persisted
    (X.online = true  AND X.credentialExistsForThisUser = false AND X.action = "pinSetupSkipped")
    // B: offline with nothing cached FOR THIS USER -> unusable password form / wrong prompt, no guidance
    OR (X.online = false AND X.credentialExistsForThisUser = false AND X.action = "offlineEntry")
    // C: online login with an existing credential FOR THIS USER -> never refreshed
    OR (X.online = true  AND X.credentialExistsForThisUser = true  AND X.action = "onlineLogin")
    // D: identity mismatch — a credential exists for a DIFFERENT user but not this one,
    //    yet the global decision logic treats "any credential exists" as this user's
    OR (X.credentialExistsForThisUser = false AND X.anyCredentialExists = true
          AND X.action IN { "onlineLogin", "offlineEntry" })
END FUNCTION
```

### Property — Fix Checking

```pascal
// F' = login/unlock flow AFTER the fix
FOR ALL X WHERE isBugCondition(X) DO
  result <- loginFlow'(X)
  ASSERT
    // A: a usable CachedCredential (keyed to authenticatingUserId) is persisted
    //    before any route onward, so no later offline dead-end is reachable
    (X.action = "pinSetupSkipped" IMPLIES NOT reachesOfflineDeadEnd(result))
    // B: an explicit "sign in online first" screen is shown; never a PIN
    //    prompt and never an unusable password-only dead-end
    AND (X.action = "offlineEntry" AND X.credentialExistsForThisUser = false IMPLIES
          result.screen = "online-required"
          AND NOT result.promptsPin
          AND NOT result.deadEnd)
    // C: the cached credential's role/access window are refreshed from the
    //    server AND the PIN-keyed HMAC integrity binding is preserved
    AND (X.action = "onlineLogin" AND X.credentialExistsForThisUser = true IMPLIES
          result.credentialRefreshed AND result.integrityBindingValid)
    // D: every decision is keyed to authenticatingUserId's OWN credential, never a
    //    global count or first-record; a different user's credential must not
    //    suppress this user's PinSetup nor drive an unlock prompt against it
    AND (X.credentialExistsForThisUser = false AND X.anyCredentialExists = true IMPLIES
          (X.online = true  IMPLIES result.screen = "pin-setup")
          AND (X.online = false IMPLIES result.screen = "online-required" AND NOT result.promptsPin))
END FOR
```

### Preservation Goal — Preservation Checking

```pascal
// F = flow BEFORE the fix, F' = flow AFTER the fix
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT loginFlow(X) = loginFlow'(X)
END FOR
// i.e. offline + credentialExistsForThisUser still goes to PIN-unlock and validates
// locally against THAT user's credential; first online login with no credential for the
// user still offers "Set PIN" via the existing PBKDF2-SHA256 + PIN-keyed HMAC activation;
// every failure still fails closed.
```

**Hard constraints shaping the fix.** Keep the existing WebCrypto PBKDF2-SHA256 +
PIN-keyed HMAC crypto (`src/services/crypto.ts`); no bcrypt or new crypto dependency. No
server-side `pin_hash` column and no writes to `auth.users`/`profiles` — the credential
lives only in the Dexie `credentials` store. Fail closed throughout. Do not touch
`src/components/CashbookForm.tsx`, `src/db/captureRepo.ts`, or `src/utils/syncEngine.ts`.
Keep the fix surface to `src/features/auth/*` and, only if strictly necessary,
`src/services/authService.ts` and `src/db/schema.ts`.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user authenticates online for the first time with no cached credential for that user AND chooses "Skip" on the PIN-setup screen THEN the system navigates to the dashboard without persisting any Cached_Credential, leaving no PIN set.

1.2 WHEN a user opens the app offline AND no Cached_Credential exists for that user THEN the system shows the password login form, which cannot authenticate without a connection, and provides no instruction to connect online first, dead-ending the user.

1.3 WHEN a user authenticates online AND a Cached_Credential already exists for that user THEN the system navigates straight to the dashboard without refreshing the cached credential's server-derived fields (role and access window).

1.4 WHEN a Treasurer has reached state 1.1 (no credential persisted) and later attempts to unlock offline THEN the system cannot validate any PIN because no credential exists to validate against, so offline capture is unreachable.

1.5 WHEN a user authenticates online AND a Cached_Credential exists for a DIFFERENT user (any credential is present on the device) but none exists for the authenticating user THEN the system branches on the global db.credentials.count() (existing > 0), suppresses the PIN-setup screen, and routes straight to the dashboard, so the authenticating user is never offered setup for their own credential.

1.6 WHEN the app opens offline AND a Cached_Credential exists for a DIFFERENT user but none exists for the intended user THEN the system's initial-mode effect uses the global db.credentials.count() to select pin-unlock and presents a PIN prompt, and unlockOffline(pin) with no userId validates against (await db.credentials.toArray())[0] — the first/any credential, not the intended user's.

1.7 WHEN LoginForm completes online authentication THEN the system discards data.user.id and returns an AuthenticatedContext without a userId field, so LoginPage cannot key its PinSetup/unlock decisions to the user who just authenticated.

### Expected Behavior (Correct)

2.1 WHEN a user authenticates online for the first time with no Cached_Credential for that user THEN the system SHALL present the offline-PIN setup screen and SHALL persist a Cached_Credential (keyed to the authenticating userId) via the existing PBKDF2-SHA256 + PIN-keyed HMAC activation before routing onward, such that no later offline dead-end is reachable from a skipped setup.

2.2 WHEN a user is offline AND no Cached_Credential exists for the relevant user THEN the system SHALL display an explicit "connect to the internet and sign in online to set up offline access" message, SHALL NOT prompt for a PIN, and SHALL NOT present a password form that cannot complete.

2.3 WHEN a user authenticates online AND a Cached_Credential already exists for that user THEN the system SHALL refresh that user's cached credential's server-derived fields (role and access window) on that login while preserving the PIN-keyed HMAC integrity binding, then route to the role-appropriate dashboard.

2.4 WHEN a user is offline AND a valid Cached_Credential exists for the relevant user THEN the system SHALL present the PIN-unlock screen and validate the entered PIN against that user's locally cached credential.

2.5 WHEN a user authenticates online AND a Cached_Credential exists for a DIFFERENT user but none exists for the authenticating user THEN the system SHALL base its decision on the authenticating user's own credential (db.credentials.get(userId)), SHALL present the PIN-setup screen, and SHALL NOT let another user's credential suppress setup.

2.6 WHEN the app opens offline AND a Cached_Credential exists for a DIFFERENT user but none exists for the intended user THEN the system SHALL NOT present a PIN prompt bound to another user's credential and SHALL instead show the explicit "sign in online first" screen.

2.7 WHEN LoginForm completes online authentication THEN the system SHALL include the authenticated userId (data.user.id) in AuthenticatedContext, and LoginPage SHALL key its PinSetup/unlock decisions to that per-user credential rather than a global count or first-record.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user is offline with a valid Cached_Credential and enters the correct PIN THEN the system SHALL CONTINUE TO unlock and establish a provisional offline session, including the existing failed-attempt lockout after MAX_FAILED_ATTEMPTS.

3.2 WHEN offline PIN setup or validation runs THEN the system SHALL CONTINUE TO use the existing WebCrypto PBKDF2-SHA256 hashing and PIN-keyed HMAC integrity check, with no new crypto dependency (no bcrypt) and no server-side pin_hash column.

3.3 WHEN any step in the online-login, offline-unlock, or reconnect re-validation chain fails THEN the system SHALL CONTINUE TO fail closed (sign out / block) and never fall through to a dashboard.

3.4 WHEN a user successfully authenticates online with valid, in-window access (including the HO district-assignment check) THEN the system SHALL CONTINUE TO route to the role-appropriate dashboard via getDashboardRoute.

3.5 WHEN reconnect re-validation detects a revoked or expired user THEN the system SHALL CONTINUE TO invalidate the cached credential and end the session.

3.6 WHEN the raw PIN is handled THEN the system SHALL CONTINUE TO never persist it, storing only the PIN hash, salt, and HMAC in the Dexie credentials store.

3.7 WHEN this fix is implemented THEN the system SHALL CONTINUE TO leave src/components/CashbookForm.tsx, src/db/captureRepo.ts, and src/utils/syncEngine.ts unchanged.

3.8 WHEN multiple users' credentials coexist on one device THEN the system SHALL CONTINUE TO retain each user's Cached_Credential keyed by userId, with per-user decisions never deleting or overwriting another user's credential.
