# OAC Cashbook — PROJECT LOG

> Authoritative cross-device handoff. Read this FIRST every session (see
> `.kiro/steering/project-continuity.md`). CURRENT STATE is the live snapshot;
> SESSION JOURNAL below is dated history, newest first. **No secrets in this file.**

---

## CURRENT STATE  (as of 2026-11-23)

**Repo / branch**
- Repo: `github.com/jamo74git/jw-cashbook-v4` (also OneDrive-synced).
- Working branch: `feat/treasurer-dashboard-v1`, pushed tip = `9408e938` (continuity log commit); upstream tracking is set. Later commits may exist, so check `git log`.
- `main` = `d34a3f51` (older Node build; it is the Vercel **Production** branch).
- Pre-production. App has NOT launched. First demo: **November 2026**. A full
  functional retest follows the current hardening work.

**Vercel Preview URL** (stable branch alias, redeploys on each push):
https://jw-cashbook-v4-git-feat-treasurer-dashboard-v1-mcom1.vercel.app/

**Demo invitation received (2026-11-23).** The user will NOT demo on seed data. The demo
needs tested, realistic data, and more features still need building. Scope and date to be
confirmed with the user. UAT on the Preview is in progress.

**Backend** — dev/demo project `cwdyixafvylzgtpsfmwr` (labelled "PRODUCTION" in the
dashboard, but that does NOT mean live). Preserve its objects + test data. Do not apply
schema/policy/bucket changes or deploy unless a task explicitly authorises it.

**Applied + recorded migrations** (all live on the dev/demo backend, verified):
- `20261102210349_officers_interim_fields`
- `20261105110000_signoff_foundation`
- `20261105120000_two_person_signoff`
- `20261105130000_tranche4_proof_access`
- `20261105140000_banked_cash_deposit`
- `20261105150000_fix_guard_enum`

**Verified this cycle (authenticated UAT via Auth REST + MCP read-only):**
- Two-person sign-off: submit RPC works; direct status UPDATE denied by trigger guards;
  ineligible signer roles denied; same signer twice denied; two distinct eligible
  auditors → AuditApproved; Chairperson-acting path works; submitter cannot self-sign.
- Tranche 4 proof scoping: treasurer can act on own-congregation proof, denied on another
  congregation's proof.
- Banked-cash deposit model live (per-service or same-week combined slip; cross-week
  spanning blocked by trigger). `review_ready` gates on `congregation_settings.proof_mandatory`.
- Guard-enum bug FIXED: guard triggers used `coalesce(old.status,'')` which coerced `''`
  to the `period_status` enum and broke every status update — rewritten to
  `old.status is distinct from '<Status>'::public.period_status`.
- `get_advisors` security: no ERRORs (standing WARN/INFO items noted under Open items).
- Test-period cleanup verified: 3 throwaway periods deleted, cascades clean.

**Demo-mode setting:** both seeded congregations have `proof_mandatory = false` (proof
optional) — matches client default + demo intent. The production default is an OPEN
launch decision (see Open items).

**Pending / next**
1. User runs client-UI UAT on Vercel (Preview). Await the testing report.
2. After a good report, merge `feat/treasurer-dashboard-v1` → `main` (Production cutover).
3. `PROGRESSIVE_DISPATCH_ENABLED=false` stays until reconnect/shared-device sync verified.

**New-device setup dependencies (NOT in git — must be re-provided locally):**
- `.env.local` — Supabase URL + anon key for local dev, and `SUPABASE_ACCESS_TOKEN`
  (project-scoped) used by the Supabase MCP tooling. Values live only in local
  `.env.local` (gitignored). `.env.production` (public URL + anon key) IS committed.
- Applying DDL with DROP/DELETE: the IDE auto-cancels destructive MCP statements, so the
  USER runs drop-containing migrations in the Supabase **SQL Editor**; the agent applies
  non-destructive parts via MCP and then records/verifies.
- Shared test-user passwords are being ROTATED — do not rely on any password in old notes.

**Local working-tree notes:** `src/audit/ProofLink.tsx` has a pre-existing whitespace-only
uncommitted change — leave it untouched. Baselines: vitest ~224 pass; lint = 1 pre-existing
error (`_params` unused in `captureRepo.ts`) + 6 warnings; typecheck 0.

**Open items to carry forward**
- Production `proof_mandatory` default decision (currently demo = false).
- Enable Supabase leaked-password protection before launch (currently off).
- `get_week_number` function has mutable search_path (pre-existing WARN).
- Rotate the shared test-user passwords; optional `cashbook_op_ledger` cleanup.
- User-access provisioning pilot (Elder → Overseer → DHO) dependency.
- Officers Fund — separate workstream, not yet started.

---

## SESSION JOURNAL  (newest first)

### 2026-11-23
- Established cross-device continuity: added `.kiro/steering/project-continuity.md`
  (auto-loaded each session) + this `PROJECT-LOG.md`. Honest caveats recorded: steering
  file is the "memory" (agent has none across sessions); updates are per-session, not
  literally daily; git push is the real backup, not OneDrive; a new device must
  re-provide `.env.local` + access token.
- Backend state confirmed against reality: all six migrations live/verified; branch tip
  `72d22367` pushed; test-period cleanup confirmed clean.
- Next: user's Vercel client-UI UAT, then merge to `main`.
