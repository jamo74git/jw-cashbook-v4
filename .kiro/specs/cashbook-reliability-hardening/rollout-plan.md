# Cashbook Hardening — Controlled Rollout Plan (REVIEW ONLY — NOT EXECUTED)

> Prepared for review. Nothing here has been pushed, deployed, provisioned, or applied.
> Target backend for the eventual controlled run is the SHARED pre-production project
> `cwdyixafvylzgtpsfmwr` (no Docker, no spare free project — so plan assumes shared pre-prod,
> not a new project). Tranche 4 and the two-person sign-off migration are authored but UNAPPLIED.
> The migration files are NOT renamed/edited in this pass — proposed renumbering is documented only.

---

## 1. Housekeeping state (done, in place)

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

### Release identities to track (fill (c) and (d) from Vercel)
- **(a) App candidate:** `0ad13865`
- **(b) Post-housekeeping HEAD:** `e2466299` (the exact commit to Preview if you deploy this branch)
- **(c) Production SHA (currently live on Vercel):** UNKNOWN from here — read it at
  **Vercel → Project → Deployments** (the current Production deployment shows its Git SHA).
- **(d) Vercel Production branch:** UNKNOWN from here — read it at
  **Vercel → Project → Settings → Environments → Production → Branch Tracking.**
  (GitHub default is `main` — `origin/HEAD -> origin/main` — but the Vercel Production branch is a
  dashboard setting and must be confirmed, not inferred.)

> A clean fast-forward does NOT settle the release. Once you confirm (c) and (d), re-evaluate "what
> should be released" against the ACTUAL Production branch — not against `main` by assumption.

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
