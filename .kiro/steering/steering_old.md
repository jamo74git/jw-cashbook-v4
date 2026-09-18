---
inclusion: always
---

# OAC Cashbook — Engineering Conventions & Business-Logic Guardrails

> Companion to tech.md. tech.md records WHAT the system does; this file records HOW we
> work and WHICH invariants must never be broken. Preserve existing business logic; do
> not refactor or "fix" recorded behavior without a spec.

## Architecture at a glance (current)

Vite + React + TypeScript PWA (vite-plugin-pwa) with an offline-first Dexie Local_Store
for `/capture`, an online-only `/admin` reading live Supabase, offline PIN auth
(WebCrypto PBKDF2 + PIN-keyed HMAC), a Sync_Engine reconciling the local queue to
Supabase, and a Supabase Edge Function Security_Backend (Turnstile verify + HO-only
admin writes). Security headers are host-level. See tech.md for detail.

## Spec-Driven Development Workflow

- Non-trivial work starts as a spec in `.kiro/specs/{feature-name}/` (requirements.md,
  design.md, tasks.md). Bugs use the bugfix spec flow.
- Always-on project context lives in `.kiro/steering/` (this file + tech.md).
- Do NOT write feature code before the spec's requirements/design are agreed.
- Update steering only after a change has actually landed and verified — steering must
  describe reality, not intent.

## Non-Negotiable Business Invariants

Any change touching these requires an explicit spec and sign-off.

1. **Permission gate is the single source of truth.** No role string comparisons in
   pages/components — route every check through `permissions.ts` (`hasPermission`,
   `getPermission`, `isTotalsOnly`, `isOverrideAction`). This holds in the client route
   guard, in components, AND within an offline session (cached role fed to the matrix).
2. **HO is the only admin.** User/congregation/officer/hierarchy management and bulk
   import/audit-log access are HO-only (`M`). Never widen this.
3. **HO data is district-segregated** via `ho_district_assignments`; an HO with zero
   assignments cannot log in and must see no data. RLS does the row filtering.
4. **Access is time-bounded.** `user_hierarchy_access` must be `status = active` AND
   within `[start_date, end_date]` — enforced in the online login path, the offline
   reconnect re-validation, and the Edge Function admin gate. Keep them in sync.
5. **Fail-closed auth.** Any failure in the login/unlock/re-validation chain (Turnstile,
   credentials, access lookup, date window, HO district check, PIN, integrity, TTL)
   signs the user out / blocks. Never fall through to a dashboard on error.
6. **Self-review exceptions are audited.** An Elder/Chairperson using an `O` permission
   logs `SELF_REVIEW_EXCEPTION` — online via `logSelfReviewException`, offline queued in
   Dexie and flushed by the Sync_Engine. No silent overrides.
7. **Secretary sees totals only.** For any `T` permission, hide line items, proof
   images, and detail.
8. **Hierarchy shape is fixed.** District -> Apostleship -> Overseership ->
   Congregation. Parent-type rules hold on create AND edit. No orphan/cross-level parents.
9. **Status flow is directional.** Draft -> PendingAudit -> Audit(Approved/Rejected) ->
   SubmittedToOverseer -> Overseer(Approved/Rejected) -> SubmittedToHO -> HOReviewed.
   The Sync_Engine enforces valid transitions; only HO may correct / unlock.
10. **Offline auth is provisional, not authoritative.** The offline PIN/session is a
    convenience gate. Supabase RLS + reconnect re-validation remain the real authority;
    a revoked/expired user is cut off at next reconnect or by TTL. Never store the raw
    PIN; keep the PIN-keyed HMAC integrity binding.

## Privileged Route Checklist (any new Edge Function that writes)

Reproduce the `admin-write` gate exactly: service-role key present (500) -> Bearer
token (401) -> `auth.getUser` (401) -> active `user_hierarchy_access` role `HO` (403)
-> validate body (400) -> write with the service-role client. Never expose the
service-role key to the client bundle. Never skip the HO role check.

## Offline / Sync Guardrails

- Capture writes go to Dexie first via `captureRepo` — never block the field UI on the
  network. The Sync_Engine reconciles later.
- Proof images are stored locally as Blobs and uploaded on sync; never assume Storage
  is reachable during capture.
- The Sync_Engine must only apply Service_Status_Flow-valid transitions, must detect
  conflicts (server advanced) without overwriting server state, and must retain +
  back off on failure.
- Reference caches (officers/congregations/hierarchy) are populated online only, via
  `cacheLoader`. Treat empty offline pickers as "not yet synced," not an error.

## Security Guardrails

- Keep the six host-level security headers (vercel.json + public/_headers) intact.
- Turnstile: production MUST set both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (client) and
  `TURNSTILE_SECRET_KEY` (Edge Function). The dev bypass (missing secret -> success) is
  local only.
- Never commit secrets. `.env.local` stays untracked. The service-role key lives only
  in Edge Functions. Do not commit personal identity documents.

## Coding Conventions

- TypeScript throughout; import shared enums/types from `@/lib/types`; the `@ -> /src`
  alias is configured in vite.config.ts and tsconfig.json.
- Env vars via `import.meta.env` (Vite). envPrefix accepts `VITE_` and legacy
  `NEXT_PUBLIC_`. There is no `process.env` in client code.
- Client Supabase via `@/lib/supabase/client`; never instantiate a service-role client
  outside an Edge Function.
- Routing via `react-router-dom`; gate through the `routeGuard` + `permissions.ts`
  (no Next.js APIs — `next/*` imports are legacy and must be ported).
- Match existing UI patterns (shadcn/ui under `@/components/ui`, compact `text-xs`
  admin tables, toast + inline error blocks, `role="alert"` + `aria-describedby`).

## When You Find a Bug in Recorded Logic

Do NOT quietly fix it during unrelated work. Record it under tech.md "Known Issues" and
raise a bugfix spec. Current open items: `cashbook_period` vs `cashbook_service` table
naming; non-deterministic primary-access selection in `getUserAccess`; un-ported
`OtpLoginForm`/`ThemeProvider`; dead `supabase/server.ts`; no automated tests yet;
Edge Functions not deployed / app not runtime-tested end-to-end.
