# Tranche 2 — Read-only deployed inspection & reconciliation

Project VERIFIED: `cwdyixafvylzgtpsfmwr` (name "jw-cashbook-v4", ACTIVE_HEALTHY, eu-west-1).
Verification: app `NEXT_PUBLIC_SUPABASE_URL = https://cwdyixafvylzgtpsfmwr.supabase.co` matches this ref
(NOT the inactive "OAC CashBook" / ycvkephibsgkkanqxivj). Read-only only; no migrations/deploys/bucket
changes. No secrets/keys recorded.

## Read-only queries used (pg_catalog / information_schema / storage + MCP metadata)
- RLS: `select relname, relrowsecurity, relforcerowsecurity from pg_class ... where relname in (<cashbook tables>)`
- Policies: `select tablename,policyname,cmd,roles,qual,with_check from pg_policies where schemaname='public' and tablename in (...)`
- Status enum: `select enumlabel,enumsortorder from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='period_status' order by enumsortorder`
- Period columns/constraints: information_schema.columns + `pg_get_constraintdef` on `public.cashbook_period`
- Triggers: `pg_get_triggerdef` over pg_trigger (non-internal) for the cashbook tables
- Storage: `select id,name,public,file_size_limit,allowed_mime_types from storage.buckets` + `pg_policies` on `storage.objects`
- DEFINER fns: `select proname,prosecdef,proconfig,pg_get_functiondef(oid) ... in ('get_or_create_period','can_capture_period')`
- Grants: information_schema.role_table_grants
- MCP metadata: list_tables, list_migrations, list_edge_functions, get_advisors(security)

## Reconciliation (deployed fact | repo difference | risk | min correction = Task 3)
1. period/line_item RLS: scoped `congregation_id IN get_my_hierarchy_ids()` (SELECT + ALL write), NO status/parent lock | repo rpc_get_or_create_period.sql scripts USING(true) "Auth all" | repo NOT deployed (deployed safer) but Submitted/Approved rows still mutable via Data API | add status-aware parent lock.
2. cashbook_attachment RLS: SELECT+INSERT include `OR scope_level <> Congregation` see-all; UPDATE/DELETE cong-scoped; no parent lock | similar in repo | cross-scope read/insert; approved-proof mutation not prevented | scope SELECT/INSERT; add parent lock.
3. audit_log RLS: INSERT with_check true, SELECT qual true; authenticated full grant; no UPDATE/DELETE policy | repo 006 USING(true) | any auth user reads ALL audit + inserts FORGED actor/action rows; no actor binding | bind insert to auth.uid()=actor + scope; restrict reads.
4. Proof bucket: TWO buckets — `cashbook_proofs` (underscore) public=FALSE (scoped policies); `cashbook-proofs` (hyphen) public=TRUE + "Allow public reads" (role public). App uses the HYPHEN public bucket + getPublicUrl | repo code uses cashbook-proofs | PROOFS PUBLICLY READABLE BY URL | move app to private cashbook_proofs + scoped signed URLs; drop public-read policy; migrate objects.
5. period_status enum = {Draft,Submitted,AuditApproved,SubmittedToOverseer,Rejected,SubmittedToHO,HOReviewed} — NO OverseerApproved/OverseerRejected | OverseerReview.tsx writes those two | invalid-enum → Overseer approve/reject ERRORS on deployed | reconcile code to enum (or add labels) — D-8.
6. Triggers: NONE on cashbook_period/line_item/attachment/audit_log | assumed none | no server status-transition/lock/atomic-audit; approval+audit are separate client calls | add atomic transition RPCs w/ mandatory audit.
7. get_or_create_period: SECURITY DEFINER, search_path='', enforces congregation scope, creates Draft; no lock/role gate | repo version lacked scope check | deployed hardened; still no lock | add lock/role later.
8. can_capture_period (DEPLOYED, not in repo): DEFINER, search_path=''; week N requires week N-1 = AuditApproved (week 1 always) | absent from repo | deployed week-sequencing logic undocumented in repo/spec | document + reconcile with month-sequencing.
9. Migrations: 5 deployed (2026-10-05: repair_get_my_role..., repair_get_my_hierarchy_ids..., census_rls_scoped_policies_append_only_log, harden_definer_functions_revoke_public_scope_recheck, add_covering_indexes_for_unindexed_fks) | repo docs/migrations/* + supabase/*.sql entirely different | repo NOT deployed history (drift) | treat deployed as source of truth; `supabase db pull` before new migrations.
10. Tables: deployed has priest_census, priest_census_log, overseerships, apostleships, *_executives, user_congregation_assignments (all RLS on) | repo migration 009 = census_congregation/census_priestship/attendance_monthly/new_members_register + member-docs | 009 NOT applied as-is; Finding 27 member-docs exposure absent in that form | verify priest_census policies if needed.
11. Edge Functions: NONE deployed | repo has verify-turnstile + admin-write | HO-only admin-write + Turnstile server-verify NOT live | deploy + gate when needed (post-tranche).
12. Advisors(security): get_week_number mutable search_path; 4 DEFINER fns authenticated-executable (by design RLS helpers); auth leaked-password protection OFF | n/a | 1 search_path hardening + 1 auth setting | set search_path; enable leaked-password protection.

## Priority findings (all demo-critical; corrections = Task 3, NOT this tranche)
- P1 PROOF PRIVACY (critical): app proofs in a PUBLIC bucket with public-read.
- P2 AUDIT attribution (critical): audit_log USING(true) insert/read; forgeable; no actor binding.
- P3 LOCKING (critical): no triggers + no status lock in RLS; approved/submitted rows + proofs mutable via Data API; approval/audit not server-atomic (Finding 22).
- P4 RLS exposure (high): attachment + storage see-all `scope_level <> Congregation`.
- P5 OVERSEER STATUS D-8 (high): OverseerApproved/OverseerRejected absent from enum; Overseer decisions error on deployed.

## Access / evidence gaps
Live read-only access succeeded (one cold-start connection timeout on first query, then OK). Edge Function
bodies not inspected (not required; avoid secrets). No passwords/keys/tokens recorded.
