-- Officers interim-request fields + a narrow INSERT authorization.   *** APPLY-READY ***
--
-- Root cause of "Could not find the 'is_interim' column of 'officers' in the schema cache":
-- the deployed public.officers table lacks the interim-approval columns the field "Request
-- interim officer" insert writes. RLS is ENABLED on officers and there is NO client INSERT
-- policy (officers are created HO-side via the service role), so adding columns alone is not
-- enough - a narrow INSERT policy is also required.
--
-- This migration is additive (nullable/defaulted columns) + one narrow policy that lets a
-- field role (Elder/Chairperson/Treasurer) with ACTIVE, time-valid access in their OWN
-- congregation create ONLY a pending interim officer (is_interim=true,
-- status='pending_ho_approval'). It cannot create approved/active officers, so a pending
-- officer never appears approved. The existing "Auth read officers" SELECT policy is unchanged.
--
-- DATA-AWARE RECOVERY (rollback is NOT a plain column drop): first find any interim rows
--   select id, officer_code, congregation_id from public.officers where is_interim;
-- decide their disposition and delete/quarantine them, THEN
--   drop policy if exists "officers_interim_request_insert" on public.officers;
--   alter table public.officers drop column if exists requested_at, drop column if exists
--     request_reason, drop column if exists requested_by, drop column if exists status,
--     drop column if exists is_interim;
-- Dropping the columns DISCARDS is_interim/status/request metadata, so any pending interim
-- officer would silently look permanent - that is why the rows must be reconciled first.

alter table public.officers
  add column if not exists is_interim     boolean not null default false,
  add column if not exists status         text,
  add column if not exists requested_by   uuid,
  add column if not exists request_reason text,
  add column if not exists requested_at   timestamptz;

comment on column public.officers.is_interim is 'Interim (pending-HO-approval) officer requested from field capture; usable immediately, pending approval.';
comment on column public.officers.status is 'pending_ho_approval | active (NULL => pre-existing permanent officer).';
comment on column public.officers.requested_by is 'Authenticated user (auth.uid) who raised the interim request.';
comment on column public.officers.request_reason is 'Free-text reason supplied with an interim request.';
comment on column public.officers.requested_at is 'Timestamp the interim request was raised.';

drop policy if exists "officers_interim_request_insert" on public.officers;
create policy "officers_interim_request_insert" on public.officers
  for insert to authenticated
  with check (
    is_interim = true
    and status = 'pending_ho_approval'
    and exists (
      select 1 from public.user_hierarchy_access uha
      where uha.user_id = (select auth.uid())
        and uha.status = 'active'
        and uha.start_date <= now()
        and (uha.end_date is null or uha.end_date >= now())
        and uha.congregation_id = officers.congregation_id
        and uha.role in ('Elder','Chairperson','Treasurer')
    )
  );

notify pgrst, 'reload schema';
