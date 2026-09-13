---
inclusion: always
---

# OAC Cashbook — Engineering Conventions & Business-Logic Guardrails

> Companion to tech.md. tech.md records WHAT the system does; this file records
> HOW we work on it and WHICH invariants must never be broken. Preserve existing
> business logic; do not refactor or "fix" behavior without a spec.

## Spec-Driven Development Workflow

- All non-trivial work starts as a spec in `.kiro/specs/{feature-name}/`
  (requirements.md, design.md, tasks.md). Bugs use the bugfix spec flow.
- Always-on project context lives in `.kiro/steering/` (this file + tech.md).
- Do NOT write feature code before the spec's requirements/design are agreed.
- The `docs/requirements/` folder (product.md, tech.md, structure.md, steering.md)
  holds source product/context docs; `.kiro/steering/` is the active, auto-loaded
  distillation. Keep them consistent.

## Non-Negotiable Business Invariants

These are the load-bearing rules of the domain. Any change touching them requires
an explicit spec and sign-off.

1. **Permission gate is the single source of truth.** No role string comparisons in
   pages/components. Route every check through `permissions.ts` (`hasPermission`,
   `getPermission`, `isTotalsOnly`, `isOverrideAction`). Adding a feature = adding a
   `module.function` entry to the PERMISSIONS matrix.
2. **HO is the only admin.** User/congregation/officer/hierarchy management and bulk
   import/audit-log access are HO-only (`M`). Never widen this.
3. **HO data is district-segregated.** Every HO query must be constrained to the
   user's `ho_district_assignments`. An HO with zero district assignments cannot log
   in and must not see any data.
4. **Access is time-bounded.** `user_hierarchy_access` must be `status = active` AND
   within `[start_date, end_date]`. Enforced in BOTH middleware and login. Keep both
   in sync — do not enforce in one place only.
5. **Fail-closed auth.** Any failure in the login chain (Turnstile, credentials,
   access lookup, date window, HO district check) signs the user out / blocks. Never
   fall through to a dashboard on error.
6. **Self-review exceptions are audited.** Whenever an Elder/Chairperson uses an `O`
   (Override) permission to act outside their normal role, log a
   `SELF_REVIEW_EXCEPTION` to `audit_log` via `logSelfReviewException`. No silent
   overrides.
7. **Secretary sees totals only.** For any `T` permission, hide line items, proof
   images, and detail. Treat Secretary as report-consumer, not data-viewer.
8. **Hierarchy shape is fixed.** District -> Apostleship -> Overseership ->
   Congregation. Parent-type rules (Apostleship under District, Overseership under
   Apostleship) must hold on create AND edit. Do not allow orphan or cross-level
   parenting.
9. **Status flow is directional.** Service status advances
   Draft -> PendingAudit -> Audit(Approved/Rejected) -> SubmittedToOverseer ->
   Overseer(Approved/Rejected) -> SubmittedToHO -> HOReviewed. Only HO may raise
   corrections / unlock a month.

## Privileged Route Checklist (must-follow for any new /api/admin route)

Reproduce the existing gate exactly:
service-role key present (500) -> Bearer token (401) -> resolve user (401) ->
active `user_hierarchy_access` with role `HO` (403) -> validate body (400) -> write.
Never expose the service-role key to the client. Never skip the HO role check.

## Security Guardrails

- Keep the security headers in `next.config.mjs` intact; do not weaken CSP-adjacent
  headers or HSTS.
- Turnstile: production MUST set both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY`. The dev bypass (missing secret -> success) is for local
  only and must never be relied on in prod.
- Never commit secrets. `.env.local` stays untracked. Flag any attempt to add it.
- `docs/design/ID Copy Front.jpeg` contains PII (an ID document) — do not commit
  personal identity documents to the repo.

## Coding Conventions

- TypeScript throughout; import shared enums/types from `@/lib/types` rather than
  redefining string literals inline.
- Client Supabase via `@/lib/supabase/client`; never instantiate the service-role
  client outside server route handlers.
- Match existing UI patterns (shadcn/ui components under `@/components/ui`,
  compact `text-xs` admin tables, toast + inline error blocks).
- Preserve accessibility: labelled inputs, `role="alert"` on errors, `aria-describedby`
  wiring as seen in LoginForm.

## When You Find a Bug in Recorded Logic

Do NOT quietly fix it while doing unrelated work. Record it under tech.md "Known
Issues" (or reference the existing entry) and raise a bugfix spec. Current known
issues: dashboard `toOverseer`/`toHO` key mismatch; `cashbook_period` vs
`cashbook_service` table naming; non-deterministic primary-access selection in
`getUserAccess`.
