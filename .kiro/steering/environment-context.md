---
inclusion: always
---

# Environment Context (authoritative — retain across sessions)

## Pre-production status
- **The application has NOT launched.** It is pre-production. First demo: **November 2026**.
- A **full functional retest follows the hardening work** — current hardening passes are
  not the final functional sign-off.

## Backend: project `cwdyixafvylzgtpsfmwr`
- This is the **pre-production development / demo backend**, confirmed by the project owner.
- The Supabase dashboard shows a **"PRODUCTION"** label, but that label does **NOT** mean
  the application has launched. Do not treat "PRODUCTION" as "live app".
- Preserve its objects and existing **test data**. Existing documents/rows may contain
  **sensitive test data** — do **not** treat the project or its data as disposable.

## Change rules for this backend
- Do **not** apply schema/policy/bucket changes to `cwdyixafvylzgtpsfmwr` and do **not**
  deploy the application unless a task explicitly authorises it.
- Implementation + migration *execution* is for an **isolated local stack** (`supabase start`,
  needs Docker) or an **explicitly identified disposable test project** only.
- Do **not** create paid resources.
- Read-only inspection of the dev/demo backend is acceptable when a specific fact is needed.
- Passing effective-RLS + integrity tests on a disposable stack is the **gate** before any
  migration is applied even to this dev/demo backend.

## Verified backend facts (read-only, for reference)
- `period_status` enum: Draft, Submitted, AuditApproved, SubmittedToOverseer, Rejected,
  SubmittedToHO, HOReviewed (no OverseerApproved/OverseerRejected).
- `cashbook_period` enforced UNIQUE key: `(congregation_id, year, month, week, service)`.
  `week_key` is nullable with NO unique constraint (convenience column only).
- Proof bucket in use: `cashbook-proofs` (hyphen), private. `cashbook_proofs` (underscore)
  also exists, private, effectively unused.
- HO is represented as `user_hierarchy_access(role='HO', scope_level='District',
  hierarchy_id=district_id)` **plus** a matching `ho_district_assignments(user_id, district_id)`.
