# Implementation Plan — Cashbook Reliability Hardening

> **Spec-only artefact.** This is the implementation PLAN derived from the amended
> `requirements.md` (R1–R38, SD-1..SD-6, NFR-*, CON-*, OBD-a..d, D-8/D-9, Findings 1–29) and
> `design.md` (§1–§18, Properties 1–44). **It changes no application code, runs no migrations,
> and deploys nothing.** Each task below is a prompt for a code-generation step in a later phase.
>
> **Convert the feature design into a series of prompts for a code-generation LLM that will
> implement each step with incremental progress. Each prompt builds on the previous prompts and
> ends with wiring things together. There is no hanging or orphaned code that isn't integrated
> into a previous step. Only tasks that involve writing, modifying, or testing code are included.**
>
> **Schema-field finalisation is gated on Task 2.** Where design.md proposes server tables/columns
> (`cashbook_op_ledger`, `cashbook_submission_manifest`, `cashbook_proof_version`,
> `cashbook_proof_verification`, `cashbook_review_decision`, new Dexie v5 fields), those names are
> design proposals only. This plan does NOT prescribe field names beyond what design.md already
> proposes; every schema-touching task is **Blocked-by: Task 2** and must be reconciled to the
> deployed schema (the §12 `DEPENDS-ON-UNVERIFIED` items) before implementation.

---

## Overview

This plan hardens the EXISTING Cashbook application for a near-term 20–30-user functional demo.
It is a **spec-only artefact**: it changes no application code, runs no migrations, and deploys
nothing — each task is a prompt for a later code-generation step. Tasks are labelled
**[DEMO-CRITICAL]** (required for the demo) or **[DEFERRED / POST-DEMO]** (built later under
separate scope). **Blocked-by** lines name hard preconditions: **Task 2** supplies the live,
read-only schema facts every schema-touching task needs, while **OBD-a..d / D-8 / D-9** are
unresolved business/technical decisions these tasks must preserve rather than silently resolve.
The SD-1..SD-6 items in "Out of scope this phase (Superseded & Deferred)" are explicitly not
implemented.

**Intentionally added for the demo (new user-visible behaviour):** automatic/progressive transfer;
separate proof-upload progress; server receipts with a stable reference ID; stale-work visibility;
provisional auditor read-only visibility of server-acknowledged in-progress captures; HO in-month
visibility.

**Preserved unchanged:** existing financial gates (incl. R500 acknowledgement), role
responsibilities, month sequencing, AM/PM handling, R0 handling.

---

## Legend

- **[DEMO-CRITICAL]** — required for the near-term 20–30-user functional demo.
- **[DEFERRED / POST-DEMO]** — explicitly out of the demo; built later under separate scope.
- **Blocked-by:** — a hard precondition. Two kinds appear:
  - **Blocked-by: Task 2** — depends on the live read-only schema inspection + reconciliation
    (schema facts / `DEPENDS-ON-UNVERIFIED`).
  - **Blocked-by: OBD-a / OBD-b / OBD-c / OBD-d / D-8 / D-9** — depends on an unresolved BUSINESS
    or technical decision carried from requirements §9.3 / design §18. These tasks preserve
    current behaviour and MUST NOT silently resolve the open decision.
- **Tests are MANDATORY, not optional** — none of the test sub-tasks in this plan carry the `*`
  optional marker. Property-based tests cover **pure logic only** (statusFlow, balancing,
  backoff/jitter, manifest/revision reconciliation, backfill idempotence) and are **explicitly
  NOT a substitute** for server-correctness/security verification (NFR-T1), which is done with
  real RLS/RPC/Storage integration tests (NFR-T3) and real-browser IndexedDB tests (NFR-T2).

---

## Out of scope this phase (Superseded & Deferred)

**No task below implements any of these.** They are recorded so the decision is on the record
(requirements "Superseded & Deferred (post-demo)"; design §1.6). Where they map to existing
criteria, those IDs are preserved and labelled in place.

- **SD-1 — Congregation-month LOCK TABLE.** Not introduced. Month locking is expressed through
  Business_State (`SubmittedToHO` = final month lock; HO-only unlock — R33.5, R19.3). *SUPERSEDED
  (deferred post-demo).*
- **SD-2 — Authenticated Elder APPROVAL binding.** No operation-ID-bound authenticated Elder
  approval / acknowledgement workflow. The capture-time comment stays recorded text (R21.4).
  *SUPERSEDED (deferred post-demo); OBD-c stays OPEN.*
- **SD-3 — Expense-specific PARTIAL UNIQUE INDEX / new expense table.** No new expense table and
  no expense-specific partial index. Anti-duplication is a testable invariant realised by the
  Operation_ID ledger + server revision compare-and-set + natural keys (R37.2). *SUPERSEDED
  (deferred post-demo).* **Task 3 must NOT create either.**
- **SD-4 — New MONTH-COMPLETION DECLARATION.** No new declaration artefact; existing
  month-completion controls are PRESERVED and deficiencies are REPORTED only (R27). No task below
  adds a NEW expected-service / AM-PM / expected-period VALIDATION rule and no task manufactures
  mandatory AM/PM records; existing AM/PM handling is preserved as-is (R27.6; design §6.5, §2.8).
  *SUPERSEDED (deferred post-demo).*
- **SD-5 — New MONTHLY expense-aggregation binding.** No new monthly aggregation rule; the current
  per-period `monthlyExpensesExceedThreshold` behaviour is preserved as a proposal (R21.2).
  *SUPERSEDED (deferred post-demo); OBD-b stays OPEN.*
- **SD-6 — Same-device offline PROVISIONAL review (R17 + provisional-specific R28.7/R28.8).**
  Unwired in source (`setClosed` / `isAuditApprovable` have no caller — Findings 12/13).
  *DEFERRED post-demo (separately scoped).* The demo uses the ONLINE-ONLY review path (R38).
  Actor-specific authenticated replay + explicit handover for CAPTURE sync (R28 core) are **NOT**
  deferred and remain demo-critical (Task 8).

---

## Tasks

- [ ] 1. Toolchain / lint baseline & regression capture — [DEMO-CRITICAL]

> This is the ONLY place the ESLint-config fix happens — not earlier. _Design: §12.8; §2.10; §17._

- [ ] 1.1 Fix the ESLint configuration so diagnostics are listable, then enumerate them
  - Repair the broken/non-loading ESLint config (`eslint . --ext .ts,.tsx`) so lint runs and
    diagnostics can be enumerated by source / code / location / message
  - Confirm `tsc --noEmit` is at 0 errors and record it as the baseline that MUST stay at 0
  - Do NOT auto-fix domain logic flagged by new lint rules; record findings only
  - _Requirements: NFR-T (verification tooling); design §12.8_

- [ ] 1.2 Capture the automated-test regression baseline
  - Run the existing vitest suite (incl. `src/features/auth/offlinePinMultiuser.test.ts` and the
    census-balancing test) with `--run`; record pass/fail and timings as the baseline
  - _Requirements: NFR-T1, NFR-T2; design §2.10, §17_

- [ ] 1.3 Record current behaviour of the governance pipeline as characterization tests
  - Write characterization tests/notes capturing today's observable behaviour of
    capture → "Submit for Audit" → audit decision → month-submit-to-Overseer, so later changes are
    provably non-regressive
  - _Requirements: R15, R16, R26, R27 (baseline only); design §2, §17.3_

- [ ] 1.4 Checkpoint — lint runs, `tsc --noEmit` at 0, baselines recorded. Ask the user if questions arise.

- [ ] 2. Read-only deployed Supabase inspection & reconciliation — [DEMO-CRITICAL]

> **Blocked-by: none** (this task produces the facts every schema-touching task needs). Every §12
> query is READ-ONLY — no migration, no deploy. Output is a reconciliation artefact that flips the
> `DEPENDS-ON-UNVERIFIED` items to verified / for-correction. _Design: §12 (all); §2.4; R30._

- [ ] 2.1 Confirm RLS enablement + effective policies
  - Run §12.1 queries (`pg_class.relrowsecurity/relforcerowsecurity`; `pg_policies` cmd/roles/
    qual/with_check) for `cashbook_period`, `cashbook_line_item`, `cashbook_attachment`,
    `audit_log`, `congregation_settings`, and the Phase B–D tables
  - Record effective `USING(true)` / `scope_level != 'Congregation'` exposure (Findings 26, 27)
  - _Requirements: R29.1, R30.1/.2, R31; design §12.1_

- [ ] 2.2 Confirm table grants + function execution privileges
  - Run §12.2 queries (`role_table_grants`; `proacl` + `has_function_privilege(authenticated|anon, …,'EXECUTE')`)
  - _Requirements: R29.7/.8, R30.1; design §12.2_

- [ ] 2.3 Capture full function + trigger DEFINITIONS
  - Run §12.3 (`pg_get_functiondef`, `pg_get_triggerdef`, `prosecdef`, `proconfig` search_path)
    for period/approve/audit/month/lock/submit/proof functions and all non-internal triggers
  - Confirm whether `get_or_create_period` and any approval/finalisation/month logic exist
    server-side and whether they enforce authorisation + locking
  - _Requirements: R30.4, R22 (Finding 22); design §12.3_

- [ ] 2.4 Confirm base `cashbook_period` shape + status enum/CHECK + constraints
  - Run §12.4 (`information_schema.columns`; `pg_get_constraintdef`) for the cashbook tables
  - Confirm the deployed `status` vocabulary and specifically whether `OverseerApproved` /
    `OverseerRejected` exist server-side (D-8 / Finding 29) and any lock column
  - _Requirements: R19.5, R30.1; design §2.4, §12.4; D-8_

- [ ] 2.5 Confirm storage buckets + object policies + validation capability
  - Run §12.5 (`storage.buckets` id/name/public/file_size_limit/allowed_mime_types;
    `pg_policies` on `storage.objects`)
  - Resolve the bucket-name mismatch (`cashbook-proofs` vs `cashbook_proofs`, Finding 14), the
    privacy flag, and whether the provider supports server-side content/size/integrity validation
  - _Requirements: R14.1/.4, R29.5, R30.3; design §7.3/.5, §12.5_

- [ ] 2.6 Confirm applied migrations + Edge-Function deployment
  - Run §12.6 (`supabase_migrations.schema_migrations`; `supabase functions list`; optional
    `supabase db dump` for diffing) — do NOT infer from `docs/migrations` filenames
  - _Requirements: R30.1; design §12.6_

- [ ] 2.7 Produce the reconciliation + schema-field finalisation
  - Write a reconciliation document that, for every `DEPENDS-ON-UNVERIFIED` item in design §12.7,
    records verified / for-correction and finalises the server table/column + Dexie v5 field names
    the later tasks will use (no new names invented beyond design proposals)
  - _Requirements: R30.1–.4; design §6.1, §5.3, §3.3, §12.7_

- [ ] 2.8 Checkpoint — reconciliation complete; schema facts locked. Ask the user if questions arise.

- [ ] 3. Minimum required backend integrity/access changes + migration tests — [DEMO-CRITICAL]

> **Blocked-by: Task 2** (every sub-task). Demo-critical security/evidence items only. **NO new
> expense table and NO expense-specific partial index (SD-3).** Preserve authorised correction/
> reopen. All SQL validated against a DISPOSABLE throwaway database — never the live project.
> _Design: §6 (all), §7.4, §5.3, §16.3; R3, R16, R19, R26, R27, R28, R29, R37._

- [ ] 3.1 Scoped RLS replacing `USING(true)` — **Blocked-by: Task 2**
  - Hierarchy-scoped SELECT/INSERT/UPDATE/DELETE policies on `cashbook_period`,
    `cashbook_line_item`, `cashbook_attachment`; derive/validate congregation + `uploaded_by`
    server-side (never trust client); bind `audit_log` reads/writes to actor + scope
  - Replace the broad `scope_level != 'Congregation'` see-all clause; add parent-lock on
    non-editable periods; close/disable exposed Phase B–D + `member-docs` access
  - _Requirements: R29.1/.2/.3/.6, R3.4, R31; design §6.8, §7.4, §9.5_

- [ ] 3.2 Private proof access + object policies — **Blocked-by: Task 2**
  - Reconcile client bucket id to deployed value; make bucket private if public; `storage.objects`
    policies scoped to the user's congregation via `user_hierarchy_access`; deny overwrite of an
    existing key; permit only authorised finalisation of manifest-declared outstanding proofs
  - _Requirements: R14.1/.4/.5/.6, R29.3/.4; design §7.3/.4_

- [ ] 3.3 Idempotency ledger — **Blocked-by: Task 2**
  - Create the Operation_ID ledger (design `cashbook_op_ledger`: `op_id` PK + `payload_fingerprint`)
    consulted first inside every write/transition RPC; replay returns the recorded result; reused
    `op_id` with a different fingerprint rejected
  - _Requirements: R11.1/.2/.3, R37.1; design §5.3, §8.4_

- [ ] 3.4 Submission manifest + proof version + proof verification tables — **Blocked-by: Task 2**
  - Create the authoritative tables (design `cashbook_submission_manifest`,
    `cashbook_proof_version` with explicit `accepted`, `cashbook_proof_verification` binding
    `verified_by`/checksum/size/`content_validated`/`verified_revision`), with the uniqueness/FK
    constraints in design §6.1
  - _Requirements: R12.3/.6/.7, R15.8, R16.1, R6.5; design §6.1, §7.5/.6_

- [ ] 3.5 Atomic submit RPC (`cashbook_submit_period`) — **Blocked-by: Task 2**
  - One transaction: ledger check → actor/role/scope authorise (operation-specific, not the HO
    gate) → `FOR UPDATE` + expected-revision compare-and-set → validate exact frozen snapshot +
    manifest (declared-outstanding proofs allowed) → set `Submitted`, bump revision, insert
    manifest, write mandatory submission audit — all-or-nothing; idempotent on the submit op id
  - _Requirements: R15.6, R7.4, R11, R29.7; design §6.2_

- [ ] 3.6 Atomic approve/reject RPC (`cashbook_review_decision`) — **Blocked-by: Task 2**
  - One RPC, separated prerequisites: APPROVE requires Review_Ready + balanced + current revision +
    four-section verification; REJECT requires only authorised actor + mandatory reason + reviewed
    revision (permits incomplete/unbalanced); at-most-one-accepted-per-revision via the partial
    unique index; implement the **failure-RESULT vs rolled-back-EXCEPTION contract** (R26.10)
  - _Requirements: R16.6, R26.1/.2/.3/.4/.5/.7/.9/.10; design §6.3, §16.3_

- [ ] 3.7 HO-only reopen/correction RPC (`cashbook_reopen_period`) — **Blocked-by: Task 2**
  - HO-only `CORRECTION`/`UNLOCK`; increment `capture_generation`; preserve prior manifests/proof
    versions/verifications/decisions; mandatory audit; idempotent via ledger (preserves authorised
    correction/reopen)
  - _Requirements: R19.3/.4, R26.8; design §6.4, §2.9_

- [ ] 3.8 Declared-proof finalisation RPC (`cashbook_finalize_proof`) — **Blocked-by: Task 2**
  - Finalise a manifest-declared outstanding proof after `Submitted`; reject undeclared/already-
    accepted/not-submitted; record proof version + verification; link attachment idempotently;
    prohibit object overwrite / proof replacement / business edits
  - Honour the now-complete progressive proof contract (design §7.7): a proof already uploaded AND
    verified during Draft (`declared-present`) is treated as satisfied by the submit RPC +
    Review_Ready and is NOT re-uploaded or falsely rejected; ONLY `declared-outstanding` proofs are
    finalised via `cashbook_finalize_proof`; the frozen manifest prohibits undeclared changes
  - _Requirements: R14.5, R15.7, R29.4; design §6.7, §7.7_

- [ ] 3.9 Review_Ready function/view — **Blocked-by: Task 2**
  - Compute Review_Ready from the server-stored manifest + verification records at the latest
    acknowledged revision for the current generation (verified proof or legitimate exemption);
    never approvable until true
  - _Requirements: R16.1/.2/.4; design §6.6_

- [ ] 3.10 Operation-specific authority + revoked direct privileged writes (CON-SEC2) — **Blocked-by: Task 2**
  - `SECURITY INVOKER` by default; `SECURITY DEFINER` only for ledger/manifest/audit/status writes
    with restricted EXECUTE grants, pinned `search_path`, fully-qualified refs, internal
    actor/role/scope checks; revoke direct `INSERT/UPDATE/DELETE` on privileged transition tables
    from `authenticated`; keep the `admin-write` HO gate for HO-only admin only
  - _Requirements: R29.7/.8, R3.4, CON-SEC2; design §6.8, §6.9_

- [ ] 3.11 Validate all §3 SQL against a DISPOSABLE database — **Blocked-by: Task 2**
  - Create the objects, exercise constraints + RLS + RPC transactions on a throwaway DB (never
    live); confirm atomic rollback, idempotent replay, compare-and-set, partial-unique-index behaviour
  - _Requirements: NFR-T3; design §6.1 (SQL validation note)_

- [ ] 3.12 Real RLS/RPC/Storage SECURITY integration tests — **Blocked-by: Task 2**
  - Against real Supabase: direct Data-API + Storage attempts by unauthorised users; auditor
    attempting a proof change; cross-congregation access; forged `uploaded_by`/audit actor;
    approved-period mutation — testing real RLS + RPCs, NOT UI gates
  - _Requirements: R29.1–.8, R26.3, R28.4, R3.4; design §17.3 (security row)_

- [ ] 3.13 Checkpoint — backend integrity/access validated on a disposable DB; security tests green. Ask the user if questions arise.

- [ ] 4. Reliable local persistence + retry-safe durable queue + restart/reconnect recovery — [DEMO-CRITICAL]

> _Design: §3, §4.3, §8.1, §11.5/.6, §16.1; R1, R2, R6, R7, R8, R10, R11, R13, R32; Findings 1, 8._

- [ ] 4.1 Additive Dexie v5 (no destructive upgrade) — **Blocked-by: Task 2** (final field names)
  - Bump to v5 additively: new `outbox` / `syncLease` / `proofObjects` / `idMap` / `tombstones`
    stores + optional fields on `periods`/`lineItems`; non-destructive `.upgrade()`; do NOT repeat
    the destructive v2 `clear()`
  - _Requirements: R32.1, CON-STORAGE1/.4; design §3.3_

- [ ] 4.2 Atomic local-first write of mutation + Outbox_Op + proof Blob + Operation_ID
  - Single Dexie `rw` transaction spanning business store(s) + `outbox` (+ `proofObjects`/
    `tombstones`/`idMap`); immutable payload + `payloadFingerprint` + stable `opId`; persist proof
    bytes before confirming; report "saving failed" and do not acknowledge on failure
  - _Requirements: R1.1/.2/.3/.5, R6.1, R7.2, R11.1, CON-STORAGE1; design §3.4_

- [ ] 4.3 Dirty-state tracking (replace `touchPeriod`)
  - Every mutation bumps `entityRevision`/`revision` and enqueues a `ready` op; retry timing lives
    on `nextAttemptAt` (never `updatedAt`); per-entity delta scope
  - _Requirements: R2.1/.2/.3/.4; design §3.5; Finding 1_

- [ ] 4.4 proofObjects registry + tombstones
  - Stable `proofId`+`version` + deterministic `objectKey`; integrity metadata; `accepted` flag;
    tombstones for idempotent server-side deletion of already-transferred lines
  - _Requirements: R4.1/.2/.3/.4, R6.1/.2/.5, R12.2/.3; design §3.6_

- [ ] 4.5 Worker lease + fence tokens + startup recovery
  - Atomic per-lane `syncLease` compare-and-set with monotonic fence token; reclaim expired leases;
    reset `in_flight` ops under an old fence to `ready`; never leave an op stuck at `syncing`
  - _Requirements: R8.1/.2/.3/.4, R10.1; design §8.1; Finding 8_

- [ ] 4.6 SyncController scheduler + resume triggers — **Blocked-by (auto-dispatch ENABLEMENT only): Task 8.1, Task 8.2**
  - Bootstrap once in `main.tsx`/`App.tsx`; drive from startup / `online` / `visibilitychange` /
    bounded interval; treat `navigator.onLine` as a hint and confirm reachability; do not claim
    uploads continue while suspended
  - Building the controller is NOT gated, but ENABLING automatic/progressive dispatch (the
    auto-trigger/scheduler actually dispatching ops) stays behind the Task 8 feature gate until the
    actor-scoped authenticated replay (Task 8.1) and reconnect re-validation (Task 8.2) are complete
    AND tested — so no intermediate build drains another saved user's queued work under the wrong JWT
  - _Requirements: R13.1/.2/.3/.6/.7, R9.3; design §4.3_

- [ ] 4.7 Quota-failure safe recovery
  - On IndexedDB quota/I-O failure, report explicitly, request `navigator.storage.persist()`,
    explain limits; **never auto-evict or clear unsynced data**
  - _Requirements: R1.5, R32.4; design §16.1_

- [ ] 4.8 Restartable, idempotent backfill (incl. v1-through-destructive-v2 chain)
  - Construct outbox ops + proofObjects + revisions/generations + idMap from existing rows/blobs;
    idempotent (same `dedupeKey`) with a `syncMeta` watermark; classify legacy evidence
    `legacy_unverified`; never fabricate auditor identities; state plainly that v1 data cleared by
    the historical destructive v2 is unrecoverable
  - _Requirements: R32.6/.7/.8/.9, CON-STORAGE4; design §11.5, §11.6_

- [ ] 4.9 Property tests (pure logic) for the local queue
  - Immutable payload + idempotency convergence (Prop 5, 6); independent retry/business clocks
    (Prop 3); additive-upgrade + backfill idempotence (Prop 41); backoff bounds (Prop 14)
  - _Requirements: R2.3, R11.1/.2/.3, R32.1/.6/.7, R9.1/.2; design §15 (Props 3, 5, 6, 14, 41)_

- [ ] 4.10 Real-browser durability tests (NFR-T2)
  - Real IndexedDB round-trip + reload (Prop 1); suspension/termination recovery (Prop 13);
    migration incl. the destructive-v2→v5 chain; multi-tab single-writer behaviour (Prop 12)
  - _Requirements: R1.4, R8.1/.2/.3, R32.2/.8; design §17.1, §17.3_

- [ ] 4.11 Checkpoint — local persistence + durable queue + recovery proven in a real browser. Ask the user if questions arise.

- [ ] 5. Independent metadata/proof lanes + safe finalisation — [DEMO-CRITICAL]

> _Design: §4.1, §4.4, §5.4/.6, §7.6, §13.1, §16.2; R5, R6, R7 (priority), R9, R12, R15.7; NFR-C/P._

- [ ] 5.1 Metadata lane (fast, bounded batches) — **Blocked-by (AUTOMATIC-run ENABLEMENT only): Task 8.1, Task 8.2**
  - Transfer `period_upsert`/`line_upsert`/`line_delete`/`submit`/`review_decision`/`reopen`/
    `audit_event` in bounded batches independent of binary uploads; proofless metadata becomes
    reviewer-visible near-immediately, labelled not-yet-Review_Ready
  - Building the lane is NOT gated, but running it AUTOMATICALLY stays behind the Task 8 feature gate
    until actor-scoped auth replay (Task 8.1) + reconnect re-validation (Task 8.2) are complete and tested
  - _Requirements: R5.1/.2/.3; design §4.1 (NFR-L2 target)_

- [ ] 5.2 Binary lane (resumable, progressive uploads before Complete_Capture) — **Blocked-by (AUTOMATIC-run ENABLEMENT only): Task 8.1, Task 8.2**
  - Independently progressing proof uploads (default one active upload/device, configurable);
    declared-outstanding proofs may finish after `Submitted`; no fixed per-file delays; retrying
    proof never blocks metadata
  - Building the lane is NOT gated, but running it AUTOMATICALLY/progressively stays behind the
    Task 8 feature gate until actor-scoped auth replay (Task 8.1) + reconnect re-validation (Task 8.2)
    are complete and tested
  - _Requirements: R5.1, R9.4, R15.7, NFR-C3/C4; design §4.1_

- [ ] 5.3 Error-checked acknowledgement (PRIORITY fix — Finding 5)
  - Inspect every server write result; treat any error as failed; **never null a proof blob or mark
    synced on unconfirmed server work**; mark `verified` only after all required writes for the
    acknowledged revision succeed and the fence guard passes
  - _Requirements: R7.1/.2/.3; design §5.6, §16.2 (Prop 10)_

- [ ] 5.4 Versioned immutable proof keys + explicit active-version selection
  - Collision-safe key from `proofId`+`version` (not second-precision timestamp); retry targets the
    same key; replacement = new identity/version at a new key; current version chosen explicitly by
    the server `accepted` flag + constraint (never first-match/timestamp sort); shared Deposit_Slip
    links preserved
  - _Requirements: R6.2/.3/.4/.5, R12.7, R14.7, R24.3; design §5.4, §5.5, §7.6_

- [ ] 5.5 Capped backoff + jitter + `Retry-After` as a minimum
  - Full-jitter capped backoff; honour `Retry-After` as a **minimum even above the backoff cap**
    (`max(jittered-backoff, now + Retry-After)`); failure-category routing
  - _Requirements: R9.1/.2; design §4.4, §16.1 (Prop 14, 15)_

- [ ] 5.6 Measure actual proof compression + readability
  - Measure the real `compressImage` output (JPEG q=0.8, maxWidth=1920, pass-through < 500KB) p50/
    p95/max on representative low-end devices; confirm auditor readability; no WebP promise;
    thumbnails never replace evidence
  - _Requirements: NFR-P1/P2, U-M1; design §13.1_

- [ ] 5.7 MANDATORY failure-injection tests
  - Inject a failure after object upload / after line insert / during attachment insert / during
    finalisation / during local ack; assert no evidence discarded, nothing marked synced, recovery
    converges (Prop 10)
  - _Requirements: R7.1/.2/.3, R8, R10, R12.1; design §17.3_

- [ ] 5.8 MANDATORY edge-case/concurrency tests for the lanes
  - Same-second proofs; shared deposit links (partial-failure recovery); delete-already-uploaded
    line; proof replaced during an in-flight upload (fencing preserves newer bytes) (Prop 8, 11)
  - _Requirements: R6.2/.3, R10.3, R11.3, R4, CON-STORAGE3; design §17.3_

- [ ] 5.9 Checkpoint — lanes independent, acks error-checked, finalisation safe. Ask the user if questions arise.

- [ ] 6. Existing capture/review integration + user progress + server receipts — [DEMO-CRITICAL]

> Wire the durable queue/lanes into the EXISTING capture + online audit without duplicating
> controls. _Design: §2.2, §2.5/.6/.7, §4.5, §9.1/.3/.4/.7, §16.4; R3, R15, R18, R20, R21, R22,
> R23, R24, R25, R34; Findings 3, 16, 17, 18, 20–24._

- [ ] 6.1 Integrate the durable queue/lanes into capture + online audit
  - Replace the fire-and-forget `syncPending()` call with the SyncController-driven lanes; preserve
    the renamed **"Complete Capture and Submit for Audit"** boundary (atomic freeze + manifest +
    one Submission_Operation + immediate local lock); no duplicated gating
  - _Requirements: R15.1/.2/.3/.4/.5; design §2.2, §4.5; Finding 15_

- [ ] 6.2 Repository-enforced editability
  - `captureRepo` mutations call `isPeriodEditable` and reject writes to non-editable periods
    independent of UI gating; display-only once `Submitted`/`AuditApproved`
  - _Requirements: R3.1/.2/.3; design §2.5; Finding 3_

- [ ] 6.3 Correct proof-completeness semantics
  - Proof present = local blob OR verified object/attachment for the current revision; a `Pending`
    status with no blob never satisfies; block Complete_Capture and identify offending transactions;
    preserve cash/deposit-slip exemptions
  - _Requirements: R20.1/.2/.3, R16.3; design §2.6; Finding 16_

- [ ] 6.4 Explicit congregation/ownership resolution for capture
  - Resolve permitted congregation from the active actor's authorisation (not first local period);
    verify authorisation before opening a period by local id; explicit local↔server id mapping
  - _Requirements: R22.1/.2/.3/.4; design §9.1; Finding 18_

- [ ] 6.5 Surface the Submission_Operation RECEIPT — **Blocked-by: Task 3** (submit RPC/receipt)
  - Show the stable server-returned Submission_Operation id + what the server acknowledged (stored
    manifest / required-proof state / acknowledged revision), NOT a bare timestamp; reflect
    unknown-outcome (lost-ack) as unconfirmed and resolve idempotently
  - _Requirements: R34.1/.2/.3/.4; design §9.7_

- [ ] 6.6 Preserve the R500 ACKNOWLEDGEMENT gate exactly as-is — [DEMO-CRITICAL]
  - PRESERVE the CURRENT per-period Submit-for-Audit acknowledgement comment exactly as-is (recorded
    text at the current per-period gate); this task changes nothing about its behaviour and therefore
    has NO OBD/D Blocked-by precondition
  - RECORD the discrepancies — gate location, the "approval" label, and per-period aggregation — as
    deferred findings only
  - Any change to aggregation, acknowledgement identity, label, or gate location is SEPARATELY
    DEFERRED (OBD-b/OBD-c/OBD-d, SD-2/SD-5) and is NOT part of 6.6
  - _Requirements: R21.1/.2/.3/.4; design §2.7 (Prop 19)_

- [ ] 6.7 Durable, attributed override / acting-as audit (no swallowed errors)
  - Implement `queueOverrideAudit` (today a no-op) to persist an `audit_event` op; remove the empty
    `catch {}`; pass `actingAsRole` + real actor identity through to the audit record; flush on sync
  - _Requirements: R18.1/.2/.3/.4; design §16.4 (Prop 35); Finding 17_

- [ ] 6.8 Scoped, paginated, failure-aware attachment loading + fail-closed review
  - Query only the period's authorised attachments (no fetch-all-and-filter); deterministic
    revision-consistent pagination; resolve current version explicitly by `accepted`; surface failed
    child reads (never `?? []`); block approval on incomplete load / missing-unreadable proof; reset
    four-section verification on revision/route/reload
  - _Requirements: R24.1/.2/.3/.4/.5, R25.1/.2/.3/.4; design §9.2, §9.3; Findings 20, 21, 24_

- [ ] 6.9 Bounded auditor dashboard refresh + labelled WIP view
  - Bounded refresh + reconnect refresh; a separate, clearly labelled provisional WIP view covering
    authorised in-progress DRAFT + Submitted-not-yet-Review_Ready; WIP is never formally approvable
  - _Requirements: R23.1/.2/.3; design §9.4_

- [ ] 6.10 MANDATORY concurrent-audit tests
  - Two auditors compete against the same revision → at most one accepted decision per revision; the
    loser gets a machine-readable conflict outcome (`rejected_competing`/`rejected_stale`); failed
    reads / missing objects / stale checkboxes block approval (Prop 23, 24, 27, 28, 29)
  - _Requirements: R26.5/.10, R25; design §17.3_

- [ ] 6.11 Property tests (pure logic) for capture/review gating
  - Proof-completeness predicate with exemptions (Prop 18); manifest == frozen snapshot (Prop 20);
    Complete_Capture state separation + immediate lock (Prop 21); per-period R500 gate (Prop 19)
  - _Requirements: R15.1/.2/.3/.5/.8, R16.3, R20, R21; design §15_

- [ ] 6.12 Checkpoint — capture/review wired, receipts shown, review fail-closed. Ask the user if questions arise.

- [ ] 7. Overseer/HO visibility + outstanding-sync warnings — [DEMO-CRITICAL]

> **Blocked-by: Task 3** (server-acknowledged data + scoped RLS). Status-vocabulary discrepancy
> (`OverseerApproved`/`OverseerRejected`) is **Blocked-by: Task 2 / D-8** and must NOT be silently
> reconciled here. _Design: §9.6/.8, §4.5; R33, R35, R36._

- [ ] 7.1 Overseer convergence view — **Blocked-by: Task 3**
  - Present to an Overseer the congregation captures at `SubmittedToOverseer` within authorised
    scope (existing `OverseerReview` surface, scoped server-side); no new lock table (SD-1)
  - _Requirements: R33.1/.6; design §9.6_

- [ ] 7.2 HO in-month read-only visibility — **Blocked-by: Task 3; Blocked-by: Task 2**
  - Read-only HO visibility of `SubmittedToOverseer` work in district scope, labelled "not yet at
    HO"; alters no Business_State; no auto-unlock; `SubmittedToHO` final lock; HO-only unlock
  - Read-only visibility writes no status, so the Overseer `OverseerApproved`/`OverseerRejected`
    transition decision (D-8) is NOT a concrete dependency here and is not a blocker for this task
  - _Requirements: R33.2/.3/.4/.5/.6, R27.5, R19.3; design §9.6_

- [ ] 7.3 Unsynced count / last-sync timestamp / oldest-pending-age + unsent-vs-incomplete split — [DEMO-CRITICAL]
  - Surface the unsynced-op COUNT, the last-successful-sync / acknowledgement TIMESTAMP, and the
    OLDEST-pending-age; distinguish device-local-unsent from server-known-incomplete; separate
    metadata vs proof states; never block next-week capture
  - These signals proceed independently and are NOT blocked by D-9 (no threshold decision is required
    to show a count, a timestamp, or an age)
  - _Requirements: R35.1/.2/.3/.4/.6/.7; design §4.5_

- [ ] 7.4 Configurable threshold-based stale warnings — **Blocked-by: D-9** (thresholds)
  - Layer configurable THRESHOLD-based, non-blocking stale warnings on top of the 7.3 count/timestamp/
    age signals; D-9 threshold values are an unresolved PROPOSAL, not an agreed deadline, so this is
    blocked until D-9 resolves; warnings never block next-week capture
  - _Requirements: R35.5; design §4.5_

- [ ] 7.5 Authorised read-only PROVISIONAL auditor visibility — **Blocked-by: Task 3**
  - Online read-only visibility of server-acknowledged in-progress capture, labelled PROVISIONAL;
    scoped server-side; never approvable from the provisional view
  - _Requirements: R36.1/.2/.3; design §9.8_

- [ ] 7.6 MANDATORY visibility tests
  - Integration: RLS/scope for Overseer convergence + HO in-month + provisional visibility; edge
    case: read-only query never auto-unlocks. Property 44: device-local-unsent vs
    server-known-incomplete classification (pure logic)
  - _Requirements: R33.1/.2/.4/.6, R35.3/.4, R36.1/.3; design §15 (Prop 44), §17.3_

- [ ] 7.7 Checkpoint — convergence + in-month visibility + sync-awareness in place. Ask the user if questions arise.

- [ ] 8. Shared-device identity isolation + authenticated handover — [DEMO-CRITICAL for capture; offline audit DEFERRED]

> _Design: §10.0, §10.4, §10.6, §4.3; R28 (core, demo-critical), R13.8, R38; SD-6._
>
> **FEATURE GATE (ordering invariant).** Actor-specific authentication checks (actor-scoped
> authenticated replay, 8.1) and reconnect authorisation re-validation (`revalidateOnReconnect`, 8.2)
> MUST be implemented AND tested BEFORE automatic/progressive synchronisation is ENABLED — i.e.
> before the Task 4.6 SyncController auto-trigger/scheduler and the Task 5.1/5.2 lanes are allowed to
> run AUTOMATICALLY. Until 8.1 and 8.2 are complete and tested, automatic/progressive sync stays
> behind a feature gate: per-actor DISPATCH is PAUSED, while capture + local durable persistence/
> queue BUILD (Task 4.1–4.5, 4.7, 4.8) + manual/foreground-only behaviour remain available — so NO
> intermediate build can drain another saved user's queued work under the wrong JWT. Only the
> automatic DISPATCH/enablement is gated; the local persistence/queue BUILD is NOT. The offline-audit
> portion (8.3 and the deferred provisional flows) stays **[DEFERRED / POST-DEMO] (SD-6)**; only the
> capture-sync actor-auth (8.1) + reconnect-revalidation (8.2) portion is the demo-critical
> prerequisite for enabling auto/progressive sync.

- [ ] 8.1 Actor-specific authenticated replay + pause-until-own-auth + quarantine (CAPTURE sync)
  - Apply each actor's queued ops only under that actor's own JWT; never drain all saved users under
    whichever JWT is active; Device_ID is correlation only; never store passwords for replay; on
    logout/revoke/reauth preserve captured work and quarantine unauthorised work
  - _Requirements: R28.1/.2/.3/.4/.5/.9, R13.4; design §10.6_

- [ ] 8.2 Explicit handover + reconnect re-validation BEFORE dispatch (wire `revalidateOnReconnect`)
  - Wire the currently-dead `revalidateOnReconnect` into the SyncController so an actor's identity/
    access/role/scope/window is re-validated before dispatching that actor's CAPTURE ops; never
    dispatch on a stale cached authorisation; auth failure → `auth_required`, never tight-loop
  - _Requirements: R28.6, R13.8; design §10.4, §4.3_

- [ ] 8.3 Establish offline-audit wiring status → defer offline review; harden ONLINE-ONLY path (R38)
  - Confirm in source that same-device offline audit/verification is NOT wired (`setClosed` /
    `isAuditApprovable` have no caller — Findings 12/13); mark provisional offline review
    **[DEFERRED / POST-DEMO] (SD-6)**; harden the clearly-communicated ONLINE-ONLY review path
    WITHOUT removing offline capture or the saved-user picker
  - _Requirements: R38.1/.2/.3/.4; design §10.0; SD-6_

- [ ] 8.4 MANDATORY identity-isolation tests
  - Integration: demo online-only review flow keeps offline capture + saved-user picker; capturer's
    ops never sent under the auditor's JWT; reconnect re-validation gates dispatch. Property 32
    (capture legs): actor isolation + attribution + auth-pause/quarantine (pure logic)
  - _Requirements: R28.1/.2/.3/.6, R38.1/.2/.3; design §15 (Prop 32), §17.3_

> **[DEFERRED / POST-DEMO] (SD-6):** same-device offline PROVISIONAL approval/rejection flows (R17,
> R28.7/.8; design §10.1–§10.3, §10.5) and their tests (Prop 26, 33, 34) are NOT built this phase.

- [ ] 8.5 Checkpoint — capture-sync actor isolation + handover proven; offline review deferred. Ask the user if questions arise.

- [ ] 9. Recovery/backup verification + essential monitoring — [DEMO-CRITICAL]

> _Design: §11.7, §14; NFR-O4/O5/O6, NFR-R1; R13._

- [ ] 9.1 Coordinated DB + proof-bytes backup/restore + reference-integrity check
  - Verify backups cover both Postgres and Storage bytes; perform a tested coordinated restore; run
    a reference-integrity check (every attachment/proof-version key resolves to a restored object
    and vice-versa); invent no retention policy; no historical purge
  - _Requirements: NFR-O6, NFR-R1, R12.5, R32.9; design §11.7, §11.4_

- [ ] 9.2 Essential monitoring instrumentation
  - Instrument queue age, incomplete submissions, retry/429/error rates, auth-paused actions,
    proof-ready latency (BOTH the per-transaction NFR-L1 and whole-period NFR-L3 measures with
    offline/reauth waits broken out), storage/egress growth; retain security/error evidence; **never
    disable audit logging to save cost**
  - _Requirements: NFR-O4/O5, NFR-L1/L3/L4, R13; design §14_

- [ ] 9.3 MANDATORY recovery + observability tests
  - Verify the restore reference-integrity check; smoke-test each observability signal emits
  - _Requirements: NFR-O4/O6; design §14, §11.7_

- [ ] 9.4 Checkpoint — coordinated restore verified; monitoring live. Ask the user if questions arise.

- [ ] 10. Functional pilot (20–30 users) + separately-authorised staged capacity validation (4–6k)

> **Pilot = [DEMO-CRITICAL]; 4–6k load = [DEFERRED / POST-DEMO] until separately authorised.**
> **Blocked-by: explicit authorisation + provider-compatibility confirmation** (for the load runs).
> Capacity is NOT certified from mocks or the 30-user demo. _Design: §17.4, §13; NFR-C1/C2, NFR-O1,
> NFR-L, NFR-T3._

- [ ] 10.1 Build the dedicated test environment + load harness
  - Dedicated env; distinct authenticated users; representative congregation distribution; realistic
    captures/reviews; MEASURED compressed images (from Task 5.6); a concentrated reconnect burst
  - _Requirements: NFR-C1/C2, NFR-T3; design §17.4_

- [ ] 10.2 Run the repeatable 20–30-user functional pilot — [DEMO-CRITICAL]
  - Functional confidence only (explicitly NOT capacity certification); verify zero duplicates /
    zero lost evidence across the pipeline
  - _Requirements: NFR-C1, NFR-T3; design §17.4.1_

- [ ] 10.3 Staged capacity runs (100 / 500 / 1,000 / 6,000) — **[DEFERRED / POST-DEMO]; Blocked-by: explicit authorisation + provider compatibility**
  - Run only after sign-off + provider-compatibility confirmation; concentrated reconnect burst at
    scale; capture resource/cost behaviour
  - _Requirements: NFR-C1/C2, NFR-O1, NFR-T3; design §17.4.2/.3_

- [ ] 10.4 Reporting harness
  - Report p50/p95/p99 AND max latency (both NFR-L1 and NFR-L3 measures, offline/reauth broken out),
    error/retry/429 rates, correctness, resource/cost (from measured mean/total retained bytes);
    state explicitly that capacity is NOT certified from mocks or the 30-user demo
  - _Requirements: NFR-L1–L4, NFR-O1, NFR-C1; design §13, §17.4.4/.5_

- [ ] 10.5 Checkpoint — functional pilot green; capacity runs gated on authorisation. Ask the user if questions arise.

---

## Notes

- Tasks are dependency-ordered; **Blocked-by** lines name hard preconditions (Task 2 for schema
  facts; OBD-a/-b/-c/-d, D-8, D-9 for unresolved decisions).
- **No `*` optional markers appear** — the failure-injection, security, real-browser, concurrent-
  audit, and property tests are all mandatory (NFR-T1–T4).
- **Property tests are pure-logic only** (statusFlow, balancing, backoff/jitter, manifest/revision
  reconciliation, backfill, classification) and are explicitly NOT a substitute for server-
  correctness/security verification, which uses real RLS/RPC/Storage integration tests.
- **Schema field names are design proposals**; finalisation is gated on Task 2. No new field names
  are invented beyond what design.md proposes.
- **Nothing in "Out of scope this phase (Superseded & Deferred)" (SD-1..SD-6) is implemented.**
- Checkpoints are not leaf tasks and are excluded from the dependency graph below.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 1, "tasks": ["2.7"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3", "3.4", "4.1"] },
    { "id": 3, "tasks": ["3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "4.2", "4.4"] },
    { "id": 4, "tasks": ["3.11", "3.12", "4.3", "4.5", "4.7", "5.4"] },
    { "id": 5, "tasks": ["8.1", "8.2", "4.8"] },
    { "id": 6, "tasks": ["4.6", "5.1", "5.2", "5.5", "5.6"] },
    { "id": 7, "tasks": ["5.3", "4.9", "4.10", "6.2", "6.3", "6.4", "6.7"] },
    { "id": 8, "tasks": ["5.7", "5.8", "6.1", "6.5", "6.6", "6.8", "6.9", "8.3"] },
    { "id": 9, "tasks": ["6.10", "6.11", "7.1", "7.2", "7.3", "7.5", "8.4"] },
    { "id": 10, "tasks": ["7.4", "7.6", "9.1", "9.2", "10.1"] },
    { "id": 11, "tasks": ["9.3", "10.2", "10.4"] },
    { "id": 12, "tasks": ["10.3"] }
  ]
}
```
