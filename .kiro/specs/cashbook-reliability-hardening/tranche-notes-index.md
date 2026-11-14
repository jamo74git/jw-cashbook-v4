# Tranche notes — status index (historical record)

> These tranche drafts are committed for HISTORY. They record how the hardening design
> evolved; they are not the current source of truth. The authoritative, current artefacts
> are the committed `requirements.md`, `design.md`, `tasks.md`, `two-person-signoff-design.md`,
> `gap-analysis.md`, the Tranche 4 review set (`tranche4-migration-diff.sql`,
> `tranche4-access-checks.md`), the SQL under `supabase/migrations/` + `supabase/tests/`, and
> `rollout-plan.md`. Where a draft conflicts with those, the committed current artefacts win.

| File | Status | Notes |
|---|---|---|
| `requirements.md` | **CURRENT** | Authoritative requirements (R1–R38, NFR/CON/OBD/D). |
| `design.md` | **CURRENT** | Authoritative design (§1–§18, Properties). |
| `tasks.md` | **CURRENT** | Implementation plan (spec-only artefact). |
| `next-stage-direction.md` | **CURRENT (forward-looking)** | Deferred directions (durable outbox, automatic transfer, actor isolation, provisional offline audit) — explicitly NOT built in Tranche 4. |
| `tranche2-inspection.md` | **HISTORICAL** | Read-only deployed-schema inspection/reconciliation record. |
| `tranche3-remediationmd.txt` | **HISTORICAL — PROPOSAL ONLY** | Tranche 3 remediation package; nothing was applied. |
| `tranche3-migration-draftsql.txt` | **SUPERSEDED** | Early draft SQL; superseded by `supabase/migrations/*` + `tranche4-migration-diff.sql`. Do not apply. |
| `tranche4-proof-access-proposal.md` | **SUPERSEDED** | First proof-access proposal; superseded by `-rev2` and by the authoritative `tranche4-migration-diff.sql` / `tranche4-access-checks.md`. |
| `tranche4-proof-access-proposal-rev2.md` | **SUPERSEDED (correction pass)** | Correction of the v1 proposal; its conclusions are carried into the committed migration + review set. |
| `tranche4-implementation.md` | **HISTORICAL — EVIDENCE** | Bounded implementation/evidence record for Tranche 4. |
| `tranche4b-implementation.md` | **HISTORICAL — EVIDENCE** | Consolidated correction implementation + verification evidence. |
| `tranche4c-implementation.md` | **HISTORICAL — EVIDENCE** | Round-2 continuation implementation + verification evidence. |

Reminder: the Tranche 4 and two-person sign-off migrations remain **UNAPPLIED** to the shared
pre-production backend `cwdyixafvylzgtpsfmwr`; `20261102210349_officers_interim_fields.sql` is the
only one already applied. Nothing in these drafts changes that.
