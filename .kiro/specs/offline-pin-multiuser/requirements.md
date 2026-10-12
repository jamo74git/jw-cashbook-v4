# Requirements Document

## Introduction

This spec is a QA follow-up to `offline-pin-flow-fix` (branch `fix/offline-pin-flow-fix`). That
fix made the offline PIN flow per-user correct at the credential/unlock layer: `unlockOffline`
targets a resolved user, a `lastActiveUserId` pointer was added, and an "online-required" screen
replaced the offline dead-end. However, QA on a shared device surfaced that the offline experience
is still single-user and the authenticated identity is not restored offline.

### QA Evidence (observed)

- Two Treasurers set up PINs online on the same laptop (e.g. `treasurer@bosmont.test` and
  `treasurer2@other.test`), each assigned to a different congregation.
- Offline (wifi off), the login screen only prompts for a PIN for the last user; there is no
  account picker, so only the most-recent user can unlock.
- After an offline unlock, the dashboard header renders `Role:` blank, `Scope: 0 Congregations`,
  an avatar with no initials (blue dot, no "TR"), and an account dropdown showing "." instead of
  the email and role.
- The capture screen DOES load the correct officers for the last congregation offline, so officer
  caching works; congregation metadata and user profile do not survive offline.

### Root Cause (confirmed in code)

- `AppHeader` and all dashboards resolve identity through `getUserAccess()`, which calls
  `supabase.auth.getUser()` and queries Supabase directly. Offline there is no Supabase session,
  so it returns `null` and the header falls back to empty role, 0 scope, and a "." display name.
- `getUserAccess()` has no offline fallback. `routeGuard.resolveAccess()` has a provisional offline
  path from the in-memory session, but it carries no email, congregation id, congregation name, or
  display initials, and `AppHeader` does not use it.
- The offline `OfflineSession` (and the Dexie `credentials` store) hold `userId`, `role`, and the
  access window - but no profile (email, congregation, initials) needed to render identity offline.
- There is no persisted list of offline-capable users, so the login UI cannot present a picker.
- The Dexie `congregations` store already caches `{ id, name, code, ... }` for all congregations,
  so congregation names ARE recoverable offline once the user's congregation id is known.

### Decisions (defaults; override by editing this section)

- D1 (Security): PIN verification and the PIN-keyed HMAC integrity binding REMAIN in the existing
  Dexie `credentials` store and `src/services/crypto.ts`. The new offline-user record holds only
  non-secret profile/display data (email, role, display name/initials, congregation id, congregation
  name, lastSyncAt). No PIN hash, salt, or HMAC is duplicated into the profile store.
- D2 (Supersede): The offline account picker REPLACES the "online-required" screen whenever at least
  one offline user exists. The "online-required" screen is retained only when zero offline users are
  cached.
- D3 (Congregations): The existing `congregations` Dexie store (which already carries `name`) is the
  source of congregation names offline. No separate `congregations_cache` store is introduced unless
  design shows the existing store is insufficient.
- D4 (Scope framing): The header is primarily for the Treasurer/Elder/Chairperson capture personas on
  shared devices. Scope count is derived from the user's cached congregation assignment and never
  shows 0 when a cached congregation is known.

### Users

Two or more Treasurers (and other capture-capable roles: Elder, Chairperson) sharing one physical
device, each tied to a different congregation, who need to unlock and work offline as themselves.

### Out of Scope

- Server-side schema changes (no new Supabase columns; no writes to `auth.users`/`profiles`).
- Changes to the crypto primitives, capture form, capture repo, or sync engine.
- The online login gate (Turnstile -> auth -> active access -> HO district), which is unchanged.

## Glossary

- **Offline user profile**: A per-user Dexie record of non-secret display/profile data (email, role,
  display name, initials, congregation id, congregation name, lastSyncAt) used to render identity
  offline. Holds no PIN material.
- **Cached credential**: The existing `credentials` store record holding the PIN hash, salt, KDF
  iterations, and PIN-keyed HMAC used to verify a PIN offline. Owned by `offline-pin-flow-fix`.
- **Usable cached credential**: A credential that exists for a `userId` and can be used to unlock
  offline (not absent).
- **Account picker**: The offline login UI that lists offline users (with a usable cached credential)
  so one can be selected before PIN entry.
- **Offline session**: The in-memory provisional session established after a successful offline
  unlock; not authoritative (RLS and reconnect re-validation are).
- **Online-required screen**: The fail-closed screen (from `offline-pin-flow-fix`) shown offline when
  no offline unlock is possible; it renders no PIN or password input.
- **Scope count**: The number of congregations shown in the header for the current user.
- **Identity hydration**: Populating the UI's current-user identity (email, role, initials,
  congregation) from cached data while offline instead of from Supabase.

## Requirements

### Requirement 1: Persist an offline user profile on online login

**User Story:** As a Treasurer on a shared device, I want my profile to be cached when I sign in
online, so that my identity and congregation can be shown when I later work offline.

#### Acceptance Criteria

1. WHEN a user completes online authentication successfully THEN the system SHALL upsert an offline
   user profile record keyed by `userId` containing at least: email, role, display name, initials,
   congregation id (if any), congregation name (if resolvable), and a `lastSyncAt` timestamp.
2. WHEN the offline user profile is upserted THEN the system SHALL also ensure the user's
   congregation(s) are present in the cached `congregations` store so the congregation name is
   resolvable offline.
2a. WHEN the offline user profile upsert succeeds AND this is the first time this user is cached on
   this device THEN the system MAY show a subtle confirmation (e.g. "Offline access enabled for
   Bosmont"); the system SHALL NOT show this confirmation on every subsequent login (to avoid
   repeated/spam toasts).
3. WHILE the system ensures the user's congregation(s) are present in the cached `congregations`
   store THEN the system SHALL perform the operation silently in the background and SHALL NOT show a
   user toast on success for this operation.
4. IF the congregation name cannot be resolved THEN the system SHALL log a warning, SHALL NOT block
   the login, and SHALL store the profile with `congregationName` falling back to the
   `congregationId` or null.
5. WHEN a user who already has an offline profile signs in online again THEN the system SHALL update
   (not duplicate) that user's profile and refresh `lastSyncAt`.
6. IF the user has no resolvable congregation (e.g. a see-all role) THEN the system SHALL still store
   the profile with a null congregation id and SHALL NOT fail the login.
7. The system SHALL store only non-secret profile/display data in the offline user profile and SHALL
   NOT store any PIN hash, salt, or HMAC there (PIN material remains in the `credentials` store).
8. WHEN upserting one user's profile THEN the system SHALL NOT modify or delete any other user's
   offline profile or credential.

### Requirement 2: Offline multi-user account picker

**User Story:** As one of several Treasurers sharing a device, I want to pick my account from a list
when offline, so that I can unlock as myself rather than only the last person who used the device.

#### Acceptance Criteria

1. WHEN the app loads offline AND more than one offline user has a usable cached credential THEN the
   system SHALL display an account picker titled to prompt the user to choose an account to unlock.
2. WHEN the account picker is displayed THEN each entry SHALL show the user's initials in an avatar,
   the user's email, the congregation name, and the last-synced time.
3. WHEN the app loads offline AND exactly one offline user has a usable cached credential THEN the
   system SHALL auto-select that user and SHALL show a confirmation of who is being unlocked (email
   and congregation name) rather than an anonymous PIN prompt.
4. WHEN the app loads offline AND zero offline users have a usable cached credential THEN the system
   SHALL show the "online-required" screen (no PIN prompt, no password form) per `offline-pin-flow-fix`.
5. WHEN a user is selected from the picker THEN the system SHALL present a PIN entry bound to that
   selected user only.
6. WHILE a specific user is selected for unlock THEN the system SHALL provide a "Switch user" action
   that returns to the account picker without unlocking.
7. The account picker SHALL only list users for whom a usable cached credential exists; a profile
   without a corresponding credential SHALL NOT be offered for offline unlock.

### Requirement 3: Per-user targeted offline unlock

**User Story:** As a Treasurer, I want my PIN to unlock only my account, so that the shared device
keeps each person's access separate and correct.

#### Acceptance Criteria

1. WHEN a user is selected and enters their PIN THEN the system SHALL verify the PIN against that
   selected user's credential (never against an arbitrary or first-stored credential).
2. WHEN the correct PIN for the selected user is entered THEN the system SHALL unlock that user and
   establish the offline session as that user.
3. WHEN an incorrect PIN for the selected user is entered THEN the system SHALL reject the unlock,
   preserve the existing lockout/failed-attempt behavior from `offline-pin-flow-fix`, and SHALL NOT
   unlock any other user.
4. WHEN two different users each enter their own correct PIN (in separate attempts) THEN each attempt
   SHALL unlock the corresponding user with that user's role and congregation.
5. The system SHALL continue to treat the offline session as provisional (fail-closed): reconnect
   re-validation and Supabase RLS remain authoritative.
6. WHEN a user sets their offline PIN online successfully THEN the system SHALL show a confirmation
   message (toast or inline) that includes the user's email and congregation name, e.g. "Offline PIN
   set for treasurer@bosmont.test - Bosmont. You can now work offline."
7. IF setting the offline PIN fails (for example the credential store write fails) THEN the system
   SHALL show a failure message (toast or inline), e.g. "Failed to set offline PIN. Please try again
   while online.", AND the system SHALL NOT create an offline user profile that lacks a usable cached
   credential (so the account picker stays consistent per Requirement 2 Criterion 7).

### Requirement 4: Offline identity hydration

**User Story:** As a Treasurer working offline, I want the app to know who I am after I unlock, so
that every screen shows my role, scope, and congregation instead of an empty identity.

#### Acceptance Criteria

1. WHEN the app resolves the current user's access offline THEN the system SHALL source identity and
   access from the cached offline profile and active offline session, NOT from `supabase.auth.getUser()`.
2. WHEN an offline session is active THEN the system SHALL expose the current user's email, role,
   display name, initials, congregation id, and congregation name to the UI.
3. IF there is no active offline session while offline THEN the system SHALL resolve to no
   authenticated user (fail-closed) and SHALL route to the login/picker rather than a populated-but-wrong
   identity.
4. WHEN online THEN identity resolution SHALL behave as today (Supabase-sourced), so the online
   experience is unchanged.
5. The system SHALL route all role/permission decisions through `@/lib/permissions.ts`; no raw role
   string comparisons SHALL be introduced in the header or picker.

### Requirement 5: Header shows correct identity offline and online

**User Story:** As a user on a shared device, I want the header to show my initials, role, and
congregation after unlocking offline, so that I can trust I am acting as the right person.

#### Acceptance Criteria

1. WHEN a user is authenticated (online or offline) THEN the avatar SHALL render that user's initials
   (e.g. "TR"), never a blank or "." placeholder.
2. WHEN the account dropdown is opened THEN it SHALL show the user's email and role, never ".".
3. WHEN a user is authenticated THEN the header SHALL display the congregation name prominently
   alongside the product name (e.g. "Bosmont") in both online and offline states.
4. WHEN a user is authenticated THEN the header SHALL display the role (e.g. "Role: Treasurer").
5. The header SHALL NOT query Supabase directly for identity/scope while offline; it SHALL read from
   the hydrated offline identity and cached stores.

### Requirement 6: Congregation scope count never spuriously zero

**User Story:** As a Treasurer, I want my scope to show my congregation count correctly offline, so
that the header does not misreport "0 Congregations" when my congregation is cached.

#### Acceptance Criteria

1. WHEN a user is authenticated AND at least one congregation is known for that user from cache THEN
   the header SHALL show a scope count of at least 1 and SHALL NOT show 0.
2. WHEN computing scope offline THEN the system SHALL derive the count from the cached congregation(s)
   associated with the user, not from a live Supabase query.
3. WHEN the user has a single assigned congregation THEN the header SHALL show "Scope: 1 Congregation"
   and the congregation name.
4. WHERE the user's role is HO THEN the existing district-based header behavior SHALL be preserved
   (this spec does not change HO scope display).
5. IF no congregation is known for the user (e.g. a see-all role with none cached) THEN the header
   MAY show 0 or a role-appropriate scope, but SHALL NOT show 0 when a congregation IS cached.

### Requirement 7: Preserve offline capture and existing behavior

**User Story:** As a Treasurer, I want offline capture to keep working as before, so that fixing the
identity display does not regress the parts that already work.

#### Acceptance Criteria

1. WHEN a user unlocks offline THEN the capture screen SHALL continue to load the correct officers for
   that user's congregation.
2. The system SHALL preserve the credential/unlock behavior, lockout, HMAC integrity, staged refresh,
   and "online-required" (zero-user) behavior delivered by `offline-pin-flow-fix`.
3. The system SHALL NOT modify `src/services/crypto.ts`, `src/components/CashbookForm.tsx`,
   `src/db/captureRepo.ts`, or `src/utils/syncEngine.ts`.
4. The system SHALL NOT introduce a new runtime crypto dependency, a server-side pin hash column, or
   writes to Supabase `auth.users`/`profiles`.

### Requirement 8: Quality gates

**User Story:** As the maintainer, I want the change verified, so that it is safe to merge.

#### Acceptance Criteria

1. WHEN the change is complete THEN `tsc --noEmit` SHALL pass with no errors.
2. WHEN the change is complete THEN the production build (`vite build`) SHALL succeed.
3. WHEN the change is complete THEN the existing offline-pin-flow tests
   (`offlinePinFlow.explore` and `offlinePinFlow.preservation`) SHALL still pass.
4. WHEN new behavior is added THEN automated tests SHALL cover: profile persistence on online login,
   picker visibility rules (0 / 1 / many users), per-user unlock correctness (right vs wrong PIN per
   user), and offline identity/scope hydration (non-zero scope, correct initials/role/congregation).

## Acceptance Scenario (QA walkthrough)

1. Sign in as user A online, set a PIN. Sign out. Sign in as user B online, set a PIN. Go offline.
2. The offline screen shows BOTH A and B in a picker, each with its congregation name and last-synced time.
3. Selecting A and entering A's PIN unlocks A; the dashboard header shows A's initials, "Role:
   Treasurer", the congregation name "Bosmont", and "Scope: 1 Congregation" (not 0).
4. A wrong PIN for the selected user fails; the correct PIN per user succeeds.
5. Capture still loads the correct officers for the unlocked user's congregation.
