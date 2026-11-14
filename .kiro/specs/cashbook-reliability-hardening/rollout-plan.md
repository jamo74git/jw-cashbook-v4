# Cashbook Hardening — Controlled Rollout Plan (REVIEW ONLY — NOT EXECUTED)

> Prepared for review. Nothing here has been pushed, deployed, provisioned, or applied.
> Target backend for the eventual controlled run is the SHARED pre-production project
> `cwdyixafvylzgtpsfmwr` (no Docker, no spare free project — so plan assumes shared pre-prod,
> not a new project). Tranche 4 and the two-person sign-off migration are authored but UNAPPLIED.
> The migration files are NOT renamed/edited in this pass — proposed renumbering is documented only.

---

## 0. RELEASE CANDIDATE — coordinated pre-production merge to `main` (for review; NOT executed)

### Candidate
- **Candidate SHA = `8a7ccd5d`** (`feat(landing): add Beyond weekly audit strip`).
- Local `feat/treasurer-dashboard-v1` == `origin/feat/treasurer-dashboard-v1` == `8a7ccd5d`
  (0 ahead / 0 behind the remote feature branch — already pushed).
- **27 commits ahead of `origin/main` (`d34a3f51`), 0 behind** — merge to `main` is a clean
  fast-forward (merge-base == `origin/main` tip). Nothing was added after `8a7ccd5d`.
- **SHA to test = `8a7ccd5d`.**

### Exact diff against `origin/main`
- **89 files changed, +14,142 / −276.** App source (sync engine, capture/review, landing,
  role guides, storage predicates, auth/identity) + tests + the SQL set below.
- **SQL files in the diff (3 migrations + 2 test suites):**
  - `supabase/migrations/20261102210349_officers_interim_fields.sql` — **ALREADY APPLIED** to the
    shared backend (file lands in `main` for history; do NOT re-apply; its `schema_migrations`
    row exists so `supabase db push` skips it).
  - `supabase/migrations/20261012010000_tranche4_proof_access.sql` — **UNAPPLIED** (see renumber note §4).
  - `supabase/migrations/20261105120000_two_person_signoff.sql` — **UNAPPLIED**.
  - `supabase/tests/tranche4_proof_rls.test.sql`, `supabase/tests/two_person_signoff_rls.test.sql`.

### Preview sign-in verification (candidate `8a7ccd5d`)
- The branch-alias Preview resolves to the feature tip (`8a7ccd5d`), but it is behind **Vercel SSO**
  (`/login` 302 → `vercel.com/sso-api`). The agent has no Vercel session, so the check is
  **UNVERIFIED by the agent**.
- A Preview for the exact SHA **does exist** (branch tip is `8a7ccd5d`), so no new Preview is needed.
- **One check for an authorised teammate (no Cashbook credentials, no DevTools):** open the
  `8a7ccd5d` Preview, click **Sign in**, and confirm the **Cashbook sign-in form** (Email address +
  Password) appears at `/login` — not the Vercel access screen, and not the landing page remaining.
  Report pass / fail. (Clicking is the test; do not enter credentials.)
- Code-level note (already established, not re-diagnosed here): a local prod build of `8a7ccd5d` in a
  fresh browser navigates `/` → `/login` correctly; the historical "landing stays" symptom was a
  stale PWA service worker, not this source.

### SHA distinction (Preview-tested build vs branch tip)
- **App SHA under test on Preview = `8a7ccd5d`** — the last commit that changes application source;
  this is the build an authorised teammate must sign-in-verify, and the build that is merged.
- **Branch tip after this pass = a later docs-only commit** (rollout-plan + durable spec notes).
  These later commits change ONLY `.kiro/specs/**` docs — **no app source, no SQL** — so they do
  not alter the Preview build or require re-testing. The release commit to merge is `8a7ccd5d`;
  the doc commits may ride along in the fast-forward but are inert to the build.

### Pre-window gates — CONFIRM BEFORE ANY SQL (all must pass)
1. **Production Supabase target** — read the Vercel **Production** environment variables
   (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`) and confirm which Supabase project
   they resolve to. SQL is applied to THAT project. Do not apply until the target is confirmed to be
   the intended shared pre-prod `cwdyixafvylzgtpsfmwr`. (Vercel Production branch = `main` is
   confirmed; the Supabase *target* is the open item.)
2. **Migration history on that target** — on the confirmed project run
   `select version from supabase_migrations.schema_migrations order by version;` and confirm the
   expected already-applied versions are present (…, `20261102210349`) and that `20261105120000`
   and the Tranche 4 version are ABSENT. This prevents re-apply / history conflict.
3. **Authorised synthetic accounts ready** — the §5 set (Treasurer A, Chairperson, 2 Auditors,
   Elder, Overseer, DHO, Treasurer B) provisioned via the agreed Elder→Overseer→DHO bridge, each
   clearly a test identity, scoped to two congregations with a synthetic proof in each.
4. **Before-change baseline captured** — record current counts/state for the acceptance targets
   (periods, proofs, policy set) so AFTER checks compare against a known BEFORE, and refresh the
   backup snapshot (§3). Restore rehearsal remains NOT run (see Fallback below).

### Migration apply — exact filenames + method (rechecked)
Apply **one file at a time, verifying between**, so the sign-off checks pass before Tranche 4 and
the approval pause can be reasoned about:
1. `supabase/migrations/20261105120000_two_person_signoff.sql` — version `20261105120000` is **after**
   the last applied `20261102210349`, so it is **in order; apply as-is**.
2. `supabase/migrations/20261012010000_tranche4_proof_access.sql` — version is **out of order**
   (predates both `20261102210349` and the sign-off). **Renumber to
   `20261105130000_tranche4_proof_access.sql`** (version after the sign-off) at apply time — file is
   **NOT renamed in this pass**.
- **Method = manual controlled apply** (SQL editor / `psql`), each file in a single transaction,
  then record its version row: `insert into supabase_migrations.schema_migrations(version, name) …`.
  This allows verification between steps. `supabase db push` is NOT recommended for the window: it
  applies all pending migrations at once (no verify-between), and still needs the renumber + a local
  history reconcile first. Either way, `20261102210349` is already recorded and is skipped.

### Exact app + migration ORDER with approval pause (coordinated run)
> App deploy (Vercel, triggered by the merge to `main`) and DB migration (manual apply — see method
> above — against the shared pre-prod backend) are INDEPENDENT actions — Vercel runs only
> `vite build`, never migrations — so they must be sequenced deliberately. Full per-check detail is
> in §4–§8. The pre-window gates above must all pass first.

1. **Announce an APPROVAL PAUSE** and confirm no reviewer is mid-approval. The pause MUST span from
   the first migration apply until the new app is live, because: the new app approves **RPC-only**
   (direct `status` writes are blocked by the sign-off trigger), and the current/old app approves by
   direct status update. During the window, neither old nor new approval path is both-present —
   so approvals are intentionally held. Captures stay **pending**; no one-signature closure.
2. **Refresh the pre-cutover backup snapshot** immediately before the first apply (archive was
   created + contents-checked 2026-11-04; **restore rehearsal still NOT run / no disposable target —
   open dependency**, §3).
3. **Apply the sign-off migration FIRST:** `20261105120000_two_person_signoff.sql`. Then run the
   authenticated sign-off acceptance checks in §6 (bypass closure on the OLD endpoint + direct
   update; **INSERT/UPSERT cannot mint an approved row**; second sign-off + `AuditApproved` commit
   **or roll back together** via a controlled pre-commit failure + read-back; no self-approval /
   no same-person-twice / involvement incl. acting-as-Treasurer; fresh-revision; Elder referral
   leaves it pending).
4. **Apply Tranche 4 SECOND:** `20261012010000_tranche4_proof_access.sql`. **Renumber required**
   before `supabase db push`: its version `20261012010000` predates both the last-applied
   `20261102210349` AND the sign-off `20261105120000`, so it sorts out of order — give it a version
   **after `20261105120000`** (proposed `20261105130000_tranche4_proof_access.sql`, documented here,
   **file NOT renamed this pass**). Pre-check the proof object-key layout matches the policy parser
   (`folder[1]::uuid` = congregation, `folder[5]` = uploader). Then run the Tranche 4 checks in §6
   (same-proof positive+negative control; direct Storage `UPDATE` overwrite denied; broad `l4t6gw_2`
   gone; legacy cross-bucket write leak closed; scoped SELECT/INSERT/DELETE; Secretary denied).
5. **Merge app to `main`** (fast-forward `main` → `8a7ccd5d`); Vercel builds Production.
   **Confirm the Production environment's Supabase variables point at the backend just migrated**
   (the Preview/Production Supabase env is still unconfirmed — §2). Keep
   `PROGRESSIVE_DISPATCH_ENABLED=false` (automatic transfer stays off until reconnect re-validation
   + shared-device actor isolation are verified live).
6. **Verify on the DEPLOYED Production build** (exact build = `8a7ccd5d`): Sign in opens the Cashbook
   form, then the authenticated **capture**, **proof-access** (Tranche 4) and **two-person sign-off**
   checks (§6) all pass. **Keep the approval pause in effect until all three pass.** Keep
   `PROGRESSIVE_DISPATCH_ENABLED=false` (automatic dispatch stays off). Only then **lift the pause**.

### Approval pause — ownership, enforcement, recording
- **Who STARTS it:** the **release coordinator** `[assign name]` announces the pause to all reviewers
  (Auditors, Chairperson, Elder, Overseer) before gate step; the **DHO** `[assign name]` (access
  administrator) is informed. The pause is NOT started in this pass.
- **How ENFORCED during cutover:** two layers. (1) **Procedural** — reviewers are told not to start an
  approval during the window. (2) **Server** — once `20261105120000_two_person_signoff.sql` is
  applied, the trigger guard blocks the old direct-status approval path, so an old client physically
  cannot complete an approval; the new RPC path only becomes available after the `8a7ccd5d` build is
  live. Captures therefore stay **pending**; there is no one-signature closure.
- **Who LIFTS it:** the same **release coordinator**, only after step 6's three authenticated checks
  pass on the deployed build (and sign-in is teammate-verified). If any check fails → do not lift;
  go to containment (below) and Stop criteria.
- **Who RECORDS results:** a named **tester/verifier** `[assign name]` records each authenticated
  check's pass/fail (with the BEFORE/AFTER baseline) in this plan or a dated run-log appended here;
  the release coordinator signs off the lift. The Preview sign-in check is recorded by the authorised
  teammate who performs it.

### Fallback WITHOUT a restore (restore rehearsal NOT run)
Recovery is **containment**, not a DB restore (no restore rehearsal, no disposable target — §3).
- **Sign-off migration fault:** keep the trigger guard in place → approvals simply remain paused /
  pending (the agreed safe state). A prepared DOWN (drop RPC/trigger/added columns+indexes) exists
  but **reopens the direct-status bypass**, so it is NOT preferred; prefer staying paused.
- **Tranche 4 fault:** drop ONLY the specific failing new policy so that one operation fails closed
  (e.g. drop `proofs_insert_capture` to block uploads) while `proofs_select_scoped` keeps scoped
  viewing working. **Never** restore the broad `Authenticated_CRUD l4t6gw_*` policies, **never**
  re-enable `public = true` on the bucket.
- A DB restore from the refreshed archive is **last resort only** and is **unproven** — do not rely
  on it as the primary fallback.

### Stop criteria (abort the run; go to containment above / §8)
Any of §7 holds, in particular: a direct status update / INSERT / UPSERT / old endpoint reaches
`AuditApproved`; the second sign-off and the transition diverge in the read-back; after Tranche 4 a
cross-congregation user reads/writes a foreign proof, an overwrite succeeds, or the cross-bucket
write still authorises; authorised capture/proof read breaks for the owning congregation; any check
only passes with the service-role key. Fallback is **containment, not proven recovery** (§8).

### Blockers / open items (status)
- **B1 — Vercel Production branch = `main`: CONFIRMED** by owner. **Remaining:** confirm the
  Production **Supabase target** (which project the Production env resolves to) — pre-window gate 1,
  before any SQL.
- **B2 — Preview sign-in: UNVERIFIED** (OPEN). Needs the one authorised-teammate click check on the
  exact `8a7ccd5d` build; stays "unverified" until a teammate sees the Cashbook form.
- **B3 — Tranche 4 migration renumber** (OPEN): documented (`→ 20261105130000`); perform at apply time.
- **B4 — No restore rehearsal / no disposable target** (OPEN, accepted): recovery is containment, not
  restore (see Fallback). Archive is contents-verified only.
- **B5 — Durable spec notes: DONE** — committed (`requirements.md`, `design.md`, `tasks.md`,
  `next-stage-direction.md`, the tranche 2–4 drafts, and `tranche-notes-index.md`). They now travel
  into `main` on merge.
- **B6 — User-access provisioning** (Elder→Overseer→DHO): accepted pilot dependency (§5); synthetic
  test accounts provisioned as pre-window gate 3.

### Durable hardening notes — COMMITTED this pass
Committed (commit `85599926`): `requirements.md`, `design.md`, `tasks.md`, `next-stage-direction.md`
(current), and `tranche2-inspection.md`, `tranche3-migration-draftsql.txt`, `tranche3-remediationmd.txt`,
`tranche4-implementation.md`, `tranche4-proof-access-proposal.md`, `tranche4-proof-access-proposal-rev2.md`,
`tranche4b-implementation.md`, `tranche4c-implementation.md` (historical/superseded, labelled in
`tranche-notes-index.md`). Previously committed: `gap-analysis.md`, `two-person-signoff-design.md`,
`FINAL-REPORT-hardening-pass.md`, `tranche4-migration-diff.sql`, `tranche4-access-checks.md`,
`rollout-plan.md`. **Left untracked by design:** `CashbookForm.tsx` (stray duplicate), `.config.kiro`
(local tooling), scratch evidence, the root `.zip`, and the `src/audit/ProofLink.tsx` whitespace change.

---

## 1. Housekeeping state (earlier snapshot — superseded by §0)

- Branch `feat/treasurer-dashboard-v1`, **HEAD = `e2466299`** ("docs(hardening): commit durable
  design/rollout notes + ignore scratch evidence").
- **App candidate = `0ad13865`** (the hardening pass tip before housekeeping).
- `e2466299` = `0ad13865` **plus one commit** that touches only docs + `.gitignore` (the Tranche 4
  `7 -> 7` -> `7 -> 6` typo fix, tracking of `gap-analysis.md` + `two-person-signoff-design.md`,
  and scratch-ignore patterns). **App source is unchanged between the two per this pass's report.**
  Do not assert a "byte-identical build" as a tested fact — instead, if you deploy `e2466299`,
  call `e2466299` the exact Preview commit for the run.
- `src/audit/ProofLink.tsx` whitespace-only change **left untouched** (still uncommitted).
- Nothing pushed, deployed, provisioned, or applied. Remaining untracked spec files left alone.

---

## 2. Git / Vercel preflight (read-only)

### Release identities (Vercel values CONFIRMED by the project owner)
- **(a) App candidate:** `0ad13865`
- **(b) Post-housekeeping HEAD:** `e2466299`; current local HEAD `1c93b662` adds only this
  rollout-plan doc (and any later docs-only commit).
- **(c) Current Production deployment (Vercel):**
  - Deployment ID `dpl_6FXTY2HFVDf561mcYKTqJMJjhVa4` (short `6FXTY2HFV`)
  - Created Jul 23 by `jamo74git`; Environment: Production, Current
  - Source branch: `main`
  - Type: **Redeploy** of "feat: submission summary per-week values"
  - **No Git SHA is shown** — a Vercel Redeploy artifact; the Source tab shows only the file tree
    (package.json etc). The exact Git commit of the live Production build is therefore NOT
    independently verified. Do not assume it equals `origin/main` (`d34a3f51`).
  - Checked at: `vercel.com/mcom1/jw-cashbook-v4/6FXTY2HFVDf561mcYKTqJMJjhVa4/source`
    (Project → Deployments).
- **(d) Vercel Production branch:** **`main`** — confirmed at
  Project → Settings → Environments → Production → Branch Tracking.
  GitHub repo `jamo74git/jw-cashbook-v4` is connected (Project Settings → Git; connected Jul 12).
  GitHub default branch is also `main`.
- **Consequence:** `feat/treasurer-dashboard-v1` is NOT the Production branch, so pushing it
  creates a **Preview** deployment only. No Production deploy occurs unless `main` changes.
  A push does not apply DB migrations (build is `vite build` -> `dist` only).

> A clean fast-forward does NOT settle the release. Production tracks `main`, and the live
> Production artifact is a Redeploy with no verifiable SHA. Deciding what to release (merge to
> `main`) is a separate, explicit later step — not part of pushing the feature branch.

### Remote / branch facts (verified read-only)
- Remote `origin` = `github.com/jamo74git/jw-cashbook-v4`. Remote branches: `main` (default),
  `demo`, `feat/treasurer-dashboard-v1` (stale), `fix/offline-pin-flow-fix`, two `snyk-fix/*`,
  one `vercel/*`.
- **HEAD vs `origin/main`:** 24 ahead, 0 behind (merge-base = `origin/main` head `d34a3f51`).
- **HEAD vs `origin/demo`:** 95 ahead, 0 behind.

### Count reconciliation (24 = 15 + 9)
The earlier "24 ahead but 15 absent from all remotes" is reconciled:

- **(d) Unpushed (local only, on NO remote):** 15 commits = `origin/feat/treasurer-dashboard-v1..HEAD`,
  `e2466299` down through `0d1bf88d` (includes the candidate `0ad13865` and all P1–P4 hardening work).
- **(e) Pushed-but-not-in-`main`:** 9 commits that live ONLY on `origin/feat/treasurer-dashboard-v1`
  (stale remote tip `5b2c5589`), not on `main` and not on `demo`:
  - `5b2c5589` polish: shorten PIN modal header to displayName only
  - `f49de30e` polish: shorten login PIN header to name + congregation, drop email/overseership
  - `e06fa071` fix: Settings Enable offline PIN stays in session + password confirm
  - `a1d6b82a` polish: dynamic offline PIN label Change/Remove vs Set
  - `e71fe3b8` fix: dismissible offline PIN + concise header + role-titled dashboards
  - `0841eb48` feat: MVP hardening v5 grounded (hierarchy, R0 audit trail, bulk month submit, offline-pin multiuser)
  - `09416eb7` feat: MVP hardening v5 grounded (duplicate-subject commit)
  - `14efd16e` feat: Phase B Census UI + balancing evidence
  - `b2545f0e` feat: Treasurer/Chair dashboard v1 + census/growth foundation
- 15 + 9 = 24. ✓ (All 24 are ahead of `origin/main`; the 9 are already on the remote feature branch,
  the 15 are not on any remote.)

### Preview a specific commit WITHOUT changing Production
- Pushing `feat/treasurer-dashboard-v1` updates the stale remote branch (`5b2c5589` -> `e2466299`).
  If the Vercel project builds Preview deployments for branches, that produces a **Preview URL for
  `e2466299`** with **no change to the Production branch and no merge to `main`**.
- Build config (`vercel.json`): `vite build` -> `dist`, SPA rewrite, the six security headers. OK.

### Which Supabase backend Preview uses — CONFIRM BEFORE ANY WRITE TEST
- **Vercel Preview does NOT automatically inherit Production-only environment variables.** A variable
  scoped only to Production is simply absent in Preview; a Preview build can therefore have a
  different (or missing) Supabase target.
- Before trusting a Preview URL for submission/approval/proof tests, check at
  **Vercel → Project → Settings → Environment Variables** which Supabase variables
  (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, Turnstile keys, etc.) are scoped to
  **Preview**, including any **feature-branch-specific overrides**. **The Preview backend is
  UNCONFIRMED until that check is done.**
- If Preview resolves to the shared pre-prod `cwdyixafvylzgtpsfmwr`, a Preview app writes to real
  pre-prod test data — acceptable only for the controlled run, never for ad-hoc use. A
  **landing-page-only smoke test writes nothing** and is safe regardless.

---

## 3. Backup check

- The scoped pre-cutover archive was **created and contents-verified 2026-11-04** (7 tables JSON +
  13 proofs; policy/function/grant definitions captured). It is *verified-contents*, not
  *proven-restorable*.
- **Restore rehearsal NOT run**, and there is **no disposable restore target** today (no Docker, no
  spare project). So DB restore is a last resort, not a proven recovery path.
- Nothing has been applied to the backend since 2026-11-04, so the archive still matches our change
  baseline — but other people's test captures/proofs added since are NOT in it.
- **Action:** refresh the archive **immediately before the first migration apply**. Treat a one-time
  **restore rehearsal onto a disposable target as a prerequisite dependency** before relying on the
  archive; until that exists, recovery is unproven.

---

## 4. Migration order (document only — do NOT rename files this pass)

Two authored, **unapplied** files:
- `supabase/migrations/20261105120000_two_person_signoff.sql` (additive: sign-off ledger columns,
  RPC, `BEFORE UPDATE` trigger guard, partial unique indexes).
- `supabase/migrations/20261012010000_tranche4_proof_access.sql` (scoped proof RLS; higher capture-risk).

### Ordering problem
Supabase records/applies migrations **by version (timestamp) only**: a version already present in
`supabase_migrations.schema_migrations` is skipped; pending ones are applied in timestamp order; a
local version OLDER than an already-applied remote version is "out of order" and can trigger a
"remote migration versions not found" / history-mismatch error rather than applying cleanly.
(See Supabase "Deploy database migrations"; CLI issues #4406 and #6036.)

- Last applied on the backend: `20261102210349` (officers_interim).
- The Tranche 4 file `20261012010000` is **earlier than** both the last-applied `20261102210349`
  **and** the sign-off `20261105120000`. Left as-is it is out of order for `supabase db push`.

### Decision + proposed renumber (DOCUMENTED, not performed)
- **Apply sign-off FIRST** (`20261105120000`), Tranche 4 SECOND.
- Therefore the Tranche 4 replacement version must sort **AFTER `20261105120000`**, not merely after
  the last-applied `20261102210349`.
- **Proposed new filename (do NOT rename in this pass):**
  `supabase/migrations/20261105130000_tranche4_proof_access.sql`
  (any `2026110513xxxx`+ timestamp strictly greater than `20261105120000` works). Keep 14-digit
  timestamps; do not mix 8/14-digit prefixes (CLI #6036).

### How each path records them
- **`supabase db push`:** applies the two pending versions in timestamp order and inserts a
  `schema_migrations` row per version. Requires local history to reconcile with remote first
  (`supabase migration list`); fix any drift before pushing. Out-of-order Tranche 4 is the specific
  risk the renumber removes.
- **Manual apply (psql / SQL editor):** run sign-off, verify, then Tranche 4 — and **manually insert
  the matching `schema_migrations` version rows** so history stays consistent with the files, or a
  later `db push` will see them as pending and attempt re-apply.

### App build available at each step
- Keep the app on the hardened build **`0ad13865` / `e2466299`** throughout, with
  **`PROGRESSIVE_DISPATCH_ENABLED=false`** (automatic transfer stays off until reconnect +
  shared-device isolation are verified live).
- **Step A — apply sign-off.** The hardened build's approval UI calls the RPC; older clients still
  connected hit the `BEFORE UPDATE` guard and fail closed (verify in §6). Consider a **planned
  approval pause** during this window so no reviewer is mid-approval on an old client when the guard
  lands — approvals resume on the hardened build once verified.
- **Step B — apply Tranche 4.** Before applying, confirm the proof object-key layout the app writes
  matches the policy parser (`folder[1]::uuid` = congregation, `folder[5]` = uploader); a mismatch
  breaks capture/proof after apply. Old clients relying on broad read or the legacy cross-bucket
  write are denied (intended; never a bypass).
- Enable automatic dispatch only AFTER the live reconnect + shared-device isolation checks pass.

---

## 5. Synthetic test users / proofs

Minimum set for the authenticated checks (create before any 20–40-user pilot):

| Role | Count | Purpose |
|---|---|---|
| Treasurer | 1 (congregation A) | default capture + Complete Capture sign-off |
| Chairperson | 1 | exception sign-off + acting-as-Treasurer involvement block |
| Auditor | 2 | normal two-person sign-off on one revision |
| Elder | 1 | referral gap path (sees why pending; no signature) |
| Overseer | 1 | escalation only |
| DHO | 1 | provisioning authority |
| Treasurer | 1 (congregation B) | cross-congregation denial counterpart |

Plus **two congregations A and B**, each with **at least one synthetic proof**, for the Tranche 4
positive/negative control.

- **Provisioning is a flagged PILOT DEPENDENCY.** There is no account-provisioning workflow in the
  app today. The sensible manual bridge — only if an authorised process exists — is
  **Elder requests -> Overseer approves -> DHO provisions the approved role + congregation.** An
  approved request is NOT an audit sign-off. Start with this minimal set; do not create the full
  20–40 until the checks pass.
- Create on the shared pre-prod `cwdyixafvylzgtpsfmwr`; label clearly as test identities and preserve
  existing test data (incl. interim officers `INT-318275`, `INT-827743`). Do NOT provision in this
  pass.

---

## 6. Authenticated before/after checks (real stack, signed-in users, NEVER the service-role key)

### Two-person sign-off (`20261105120000`)
- **Bypass closure:** a direct Data-API `update(status='AuditApproved')` AND the old approval path
  are both refused by the trigger guard — neither can reach `AuditApproved` or skip the second sign-off.
- **INSERT/UPSERT bypass check (new):** attempt to CREATE an already-`AuditApproved` period row
  directly via INSERT and via UPSERT (on-conflict) as a signed-in user — confirm it is refused. The
  authored guard is `BEFORE UPDATE`; the INSERT/UPSERT path must be separately proven not to mint an
  approved record (if the guard does not cover INSERT, that is a stop-criterion finding).
- **Atomic second sign-off + transition (corrected test method):** do NOT rely on "kill/abort
  mid-RPC". Instead force a **controlled failure before commit** inside the RPC transaction (e.g. a
  constraint violation or a deliberately raised error after the signature write but before/at the
  transition), then **read back the synthetic record**: confirm NEITHER the second signature NOR the
  `AuditApproved` transition persisted. Then run the success path and confirm BOTH persisted. This
  proves succeed-or-fail-together by observed state, not by process interruption.
- **Rule rejections:** no self-approval; no same person signing twice; involvement check — a
  Chairperson who acted as Treasurer on that capture is refused the acting-auditor slot (role switch
  cannot launder involvement).
- **Revision binding:** a fresh revision/generation requires fresh sign-offs; prior history preserved.
- **Elder referral:** writes no signature and leaves the capture pending (no one-signature closure).
- Report every server-side check not verifiable locally (all of the above are server-side).

### Tranche 4 proof access (`20261012010000` / proposed `20261105130000`)
- **Positive + negative control on the SAME synthetic proof:** an authorised user from the OWNING
  congregation can still READ the proof that a signed-in user from ANOTHER congregation is DENIED —
  both as ordinary signed-in users, not the privileged key.
- **Overwrite denial tested directly:** attempt an `UPDATE`/overwrite of an existing object key via
  the Storage API and confirm refusal — do not infer it merely from "no UPDATE policy present".
- **Broad read gone:** confirm the old `Authenticated_CRUD l4t6gw_2` any-authenticated SELECT no
  longer applies (a foreign-congregation read is denied).
- **Legacy cross-bucket write leak closed:** a privileged-scope user cannot write into the hyphen
  `cashbook-proofs` bucket via the rewritten underscore-bucket policy (`bucket AND (A OR B)`).
- **Scoped CRUD:** per-congregation SELECT/INSERT/DELETE hold; Secretary (totals-only) denied proof reads.

### Progressive transfer readiness
- Keep `PROGRESSIVE_DISPATCH_ENABLED=false` until reconnect re-validation AND shared-device actor
  isolation are verified against the live backend; only then consider enabling automatic dispatch.

---

## 7. Stop criteria (halt the run; go to containment)

Stop immediately if any occur:
- A direct status UPDATE, an INSERT/UPSERT, or the old endpoint **reaches/creates** `AuditApproved`
  (bypass not closed).
- Second sign-off and the transition are observed to **diverge** (one persists without the other) in
  the controlled-failure read-back.
- A cross-congregation user can **read or write** another congregation's proof after Tranche 4, an
  overwrite succeeds, or the cross-bucket write still authorises.
- Authorised capture/read of proofs **breaks** for the owning congregation (object-key/parser mismatch).
- Any check only passes when using the service-role key (means RLS is not actually enforcing).
- Backend error/auth-failure rate spikes, or any data outside the synthetic set is touched.

---

## 8. Fallback — CONTAINMENT, not proven recovery

- The bucket stays **private** throughout — reopening public/broad access is never the rollback.
- **Sign-off fault:** leave the trigger guard IN PLACE; approvals simply stay **pending** (the agreed
  safe state) rather than removing the guard.
- **Proof-access fault:** drop the SPECIFIC offending new policy so that one operation **fails closed**
  (e.g. drop `proofs_insert_capture` to block uploads) while `proofs_select_scoped` keeps scoped
  viewing working. Do NOT restore the broad `Authenticated_CRUD l4t6gw_*` policies and do NOT drop the
  role/scope restriction.
- These actions **contain** a fault (keep proofs private, keep approvals gated) — they do not restore
  prior state. A refreshed archive still does **not** prove restore works: **restore rehearsal is not
  run and no disposable target exists.** Treat DB restore as unproven last resort.

---

## References (migration ordering)

- Supabase — Deploy database migrations: https://supabase.com/docs/guides/deployment/database-migrations
- Supabase CLI issue #4406 (migrations matched by version; applied versions skipped): https://github.com/supabase/cli/issues/4406
- Supabase CLI issue #6036 (version/prefix mismatch -> "remote migration versions not found"): https://github.com/supabase/cli/issues/6036

_Migration-ordering content above was rephrased for compliance with licensing restrictions._
