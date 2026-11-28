# OAC Cashbook — PROJECT LOG

> Authoritative cross-device handoff. Read this FIRST every session (see
> `.kiro/steering/project-continuity.md`). CURRENT STATE is the live snapshot;
> SESSION JOURNAL below is dated history, newest first. **No secrets in this file.**

---

## CURRENT STATE  (as of 2026-11-27)

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

**Specs authored, NOT built, migrations NOT applied (revised 2026-11-27; awaiting user decisions)**
- `.kiro/specs/expense-payment-source` (revision 6) — exactly two expense sources (cash from collections, pre-paid by a
  named officer; no third option, no per-line Notes; Burial carries no officer), Invoice No., forced expense proof, cash
  balance rule, and NEW: expense categories (about 6, HO/DHO-managed at District or Apostleship scope, built-in "Other" with a
  short description, six synthetic defaults). Open decisions D1-D21 (design.md section 21); D8 first (decides whether
  `20261124095000_payment_type_cashbanked.sql` stands alone). New: D18 replace vs merge of category lists (build default replace,
  answer together with O1), D19 digit-run guard on the Other text, D20 category required, D21 category reports.
- `.kiro/specs/burial-notice-and-trend` (revision 3) — now ONE generalised notice mechanism with a notice type key (Burial,
  Expenses): one table `scope_notice`, one edit screen `/ho/notices`, one Edge action pair, one Dexie store; also Burial proof
  exemption, 12-month Burial trend vs prior year, Chairperson/Elder faithfulness page. Open decisions O1-O18 (design.md section 17);
  O13 partly resolved; new O17 (extra notice surfaces) and O18 (Default Expenses wording).
- **Resolved by the user 2026-11-27:** all roles read notices, Secretary included (read-only Notices panel on the Secretary
  reports screen, RD1); the Elder also sees the Burial trend, totals only (RD2); the Expenses notice follows the Burial
  notice process exactly (RD3); no per-line Notes column on expenses (RD4).
- Still open, to answer together: notice precedence O1 ("most specific overrides broader" vs show all, build default show all,
  cap 3) and category replace-vs-merge D18.
- Read-only backend facts used (SELECT only, no writes): `level_type` values are title case; `user_hierarchy_access.start_date` is
  `timestamptz`; the Elder access row is `scope_level='Eldership'`, `congregation_id` NULL, `hierarchy_id` = congregation
  `eldership_id`; congregation-scope rows use `hierarchy_id` = `congregations.hierarchy_id`; no Secretary access row exists in the
  test data (Secretary read path proven only on a stack).
- Authored migrations (unapplied; disposable stack / RLS gate first), in apply order: `20261124095000_payment_type_cashbanked`,
  `20261124100000_expense_payment_source`, `20261124110000_scope_notice` (renamed from `..._burial_notice`; adds shared scope
  helpers), `20261124115000_expense_category` (new), `20261124120000_burial_proof_exempt`, `20261124130000_burial_monthly_totals`
  (Elder branch, output columns `yr`/`mo`). None has been parsed by Postgres.
- Implementation order is interleaved across the two specs (see the "Cross-spec order" note in both tasks.md files).
**Open items to carry forward**
- Answer the spec open decisions above (expense-payment-source D1-D21; burial-notice-and-trend O1-O18; D18 and O1 together).
- Production `proof_mandatory` default decision (currently demo = false).
- Enable Supabase leaked-password protection before launch (currently off).
- `get_week_number` function has mutable search_path (pre-existing WARN).
- Rotate the shared test-user passwords; optional `cashbook_op_ledger` cleanup.
- User-access provisioning pilot (Elder → Overseer → DHO) dependency.
- Officers Fund — separate workstream, not yet started.

---

## SESSION JOURNAL  (newest first)

### 2026-11-27
- Revised the two unbuilt specs (documentation only, no code, no migration applied, no backend write, no push) for the user's
  additions: exactly two expense sources; no Notes column; a generalised notice mechanism (type Burial or Expenses, one table,
  one screen) with the Expenses notice above the expense line; expense categories as HO/DHO configuration with "Other";
  all roles read notices; Elder sees the Burial trend. Authored `20261124115000_expense_category.sql`, regenerated
  `20261124110000_scope_notice.sql` (renamed) and updated `20261124130000_burial_monthly_totals.sql`. Fixed the 5 NITs of the
  previous review. Read-only SELECTs on the dev/demo backend established the Elder and Secretary row shapes.
- Open decisions: D1-D21, O1-O18 (see CURRENT STATE); next: user answers (D8 first, then D18 with O1), then build on a disposable stack.
- Rev2 review fixes (docs and unapplied SQL only): the shared read rule `scope_district_readable` branch (c) now excludes role HO, so an HO
  with no `ho_district_assignments` row reads no notices or category rows (invariant 3); SQL test cases 7b/7c and 5b added; Spec 1 design
  section 30 index now lists the appendix order. Still open: D18 (REPLACE vs MERGE category lists, recommend REPLACE) and O1 (notice precedence, recommend show all, max 3).

### 2026-11-24
- Authored two specs (requirements/design/tasks) from UAT feedback: `expense-payment-source`
  and `burial-notice-and-trend`, plus five unapplied migration files. No code, no backend
  change, no push. Next: user answers open decisions, then build on a disposable stack.

### 2026-11-23
- Established cross-device continuity: added `.kiro/steering/project-continuity.md`
  (auto-loaded each session) + this `PROJECT-LOG.md`. Honest caveats recorded: steering
  file is the "memory" (agent has none across sessions); updates are per-session, not
  literally daily; git push is the real backup, not OneDrive; a new device must
  re-provide `.env.local` + access token.
- Backend state confirmed against reality: all six migrations live/verified; branch tip
  `72d22367` pushed; test-period cleanup confirmed clean.
- Next: user's Vercel client-UI UAT, then merge to `main`.
