# Next-stage direction (RECORDED — NOT implemented in Tranche 4)

These are agreed directions to design/implement in a FOLLOWING stage. They are recorded
here so they are not lost; Tranche 4 does NOT implement any of them. The Tranche 4
boundary explicitly defers: a durable outbox, automatic transfer, and actor isolation.

## Local-first capture + reconciliation
- One local-first capture path: **Dexie is the local database**; the app implements
  Supabase reconciliation (not a second parallel path).
- **Automatic transfer by default**, with an **optional explicit "pause transfer"** control.
- **Business submission is separate** from data transfer/reconciliation.

## Durable outbox (following stage — not now)
- Replace the current ad-hoc retry with a durable outbox: stable per-operation identity,
  idempotent replay, orphan recovery. (Tranche 4 adds only a minimal stable proof-object
  identity, not an outbox.)

## Provisional same-device offline audit (following stage — needs its own security design)
- Auditor reviews the **exact local revision + its proofs**, records a **provisional**
  decision, and **locks that revision** locally.
- On reconnect, the decision is **replayed under the auditor's own authenticated authority**
  with server-side checks (actor-specific authenticated replay; actor isolation).
- Do **NOT** implement final authoritative offline approval without an explicit additional
  security design.

## Overseer deadline policy settings (proposed — not implemented)
- **Noon submission reminders** and **24-hour overdue warnings** for the Overseer deadline,
  as configurable policy settings.

## Boundary reminder
Durable outbox, automatic transfer, and actor isolation are the FOLLOWING stage. Tranche 4
stays within proof-access correction + verification only.
