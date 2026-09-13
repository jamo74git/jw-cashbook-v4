# Supabase Edge Functions — Security_Backend

These Deno functions replace the removed Next.js server routes. They hold secrets
that must **never** reach the client bundle.

## Functions

- **verify-turnstile** — server-side Cloudflare Turnstile verification (replaces
  `/api/auth/verify-turnstile`). Contract: missing token → 400, verify failure → 403,
  secret unset → dev bypass success. Sends `remoteip` from `x-forwarded-for`.
- **admin-write** — privileged HO-only writer (replaces `/api/admin/*`). Gate order:
  service-role key present (500) → `Authorization: Bearer <token>` (401) →
  `auth.getUser` (401) → active `user_hierarchy_access` role `HO` (403) →
  validate body (400) → write with the service-role client.

## Required secrets (set in Supabase, never committed)

```
supabase secrets set TURNSTILE_SECRET_KEY=<cloudflare-secret>
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically to
# deployed Edge Functions by the platform.
```

## Deploy

```
supabase functions deploy verify-turnstile
supabase functions deploy admin-write
```

## Client usage

```ts
// Turnstile (login, pre-auth):
await supabase.functions.invoke("verify-turnstile", { body: { token } });

// Admin write (HO only; user access token sent as Bearer automatically):
await supabase.functions.invoke("admin-write", {
  body: { action: "create_hierarchy", name, code, level_type, parent_id },
});
```

> Production MUST set both `TURNSTILE_SECRET_KEY` (here) and
> `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (client env). The dev bypass (missing secret →
> success) is for local only.
