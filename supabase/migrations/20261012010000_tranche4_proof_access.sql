-- ============================================================================
-- Tranche 4 (round 2) - proof-access authorisation   *** NOT APPLIED ***
--
-- Authored for review and for application ONLY in a disposable LOCAL stack
-- (`supabase start`, needs Docker) or an explicitly identified disposable test project.
-- NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr. Run `supabase db pull` first.
-- The effective-RLS + attachment-integrity tests (supabase/tests/) MUST pass on a
-- disposable stack before this is applied even to the dev/demo backend.
--
-- Round-2 corrections (R04-R08): one verified path parser used by every proof route;
-- exact period binding incl. week + week_key year/month consistency; object existence +
-- upload ownership + capture role + editable state on attachment INSERT/linkage; shared
-- object deletion blocked while any reference remains; consolidated HO rule with no
-- generic District bypass; one logical attachment identity at the DB boundary. Scope
-- unchanged otherwise; get_my_hierarchy_ids() untouched.
-- ============================================================================

-- R04: normalise a stored reference (legacy PUBLIC/SIGN url OR bare key) to a bare object
-- key so legacy rows and new keys bind identically. Unknown shapes pass through and fail
-- the structural parser below (controlled denial, never a cast error).
create or replace function public.proof_ref_key(p_ref text)
  returns text language sql immutable as $function$
  select case
    when p_ref like 'https://cwdyixafvylzgtpsfmwr.supabase.co/storage/v1/object/public/cashbook-proofs/%'
      then substring(p_ref from length('https://cwdyixafvylzgtpsfmwr.supabase.co/storage/v1/object/public/cashbook-proofs/') + 1)
    when p_ref like 'https://cwdyixafvylzgtpsfmwr.supabase.co/storage/v1/object/sign/cashbook-proofs/%'
      then split_part(substring(p_ref from length('https://cwdyixafvylzgtpsfmwr.supabase.co/storage/v1/object/sign/cashbook-proofs/') + 1), '?', 1)
    else p_ref
  end;
$function$;

-- R08: the SINGLE verified parser + binding rule. MATERIALIZED CTEs force structural
-- validation BEFORE any cast, so malformed input returns NULL (controlled denial) and a
-- cast never raises in a policy. Resolves the EXACT period via the full unique key
-- (congregation_id, year, month, week, service) and requires week_key = YYYY-MM-WN whose
-- YYYY-MM matches the folder year/month.
create or replace function public.proof_path_period_id(p_key text)
  returns uuid language sql stable security definer set search_path to '' as $function$
  with f as materialized (
    select storage.foldername(p_key) as seg
  ),
  valid as materialized (
    select seg from f
    where array_length(seg, 1) = 5
      and (seg)[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      and (seg)[2] ~ '^[0-9]{4}$'
      and (seg)[3] ~ '^[0-9]{2}$'
      and (seg)[4] ~ '^(AM|PM)_[0-9]{4}-[0-9]{2}-W[1-5]$'
      and (seg)[5] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      and left(split_part((seg)[4], '_', 2), 7) = (seg)[2] || '-' || (seg)[3]
  )
  select cp.id
  from valid
  join public.cashbook_period cp
    on cp.congregation_id = (valid.seg)[1]::uuid
   and cp.year    = (valid.seg)[2]::int
   and cp.month   = (valid.seg)[3]::int
   and cp.service = split_part((valid.seg)[4], '_', 1)
   and cp.week    = split_part(split_part((valid.seg)[4], '_', 2), 'W', 2)::int
   and cp.week_key = split_part((valid.seg)[4], '_', 2)
  limit 1;
$function$;

-- Congregation + uploader extracted from a VALIDATED key (NULL if malformed). Used so the
-- role/ownership checks never cast raw path text either.
create or replace function public.proof_path_congregation(p_key text)
  returns uuid language sql stable security definer set search_path to '' as $function$
  with f as materialized (select storage.foldername(p_key) as seg)
  select (seg)[1]::uuid from f
  where array_length(seg, 1) = 5 and (seg)[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$function$;

create or replace function public.proof_path_uploader(p_key text)
  returns uuid language sql stable security definer set search_path to '' as $function$
  with f as materialized (select storage.foldername(p_key) as seg)
  select (seg)[5]::uuid from f
  where array_length(seg, 1) = 5 and (seg)[5] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$function$;

revoke all on function public.proof_ref_key(text) from public, anon;
revoke all on function public.proof_path_period_id(text) from public, anon;
revoke all on function public.proof_path_congregation(text) from public, anon;
revoke all on function public.proof_path_uploader(text) from public, anon;
grant execute on function public.proof_ref_key(text) to authenticated;
grant execute on function public.proof_path_period_id(text) to authenticated;
grant execute on function public.proof_path_congregation(text) to authenticated;
grant execute on function public.proof_path_uploader(text) to authenticated;

-- R05: count ALL attachment references to an object key, bypassing the caller's RLS so a
-- reference HIDDEN from the deleting user still blocks physical deletion of shared evidence.
create or replace function public.proof_object_reference_count(p_name text)
  returns integer language sql stable security definer set search_path to '' as $function$
  select count(*)::int from public.cashbook_attachment a where public.proof_ref_key(a.file_url) = p_name;
$function$;
revoke all on function public.proof_object_reference_count(text) from public, anon;
grant execute on function public.proof_object_reference_count(text) to authenticated;

-- ----------------------------------------------------------------------------
-- R07: congregations where the caller may VIEW proofs. Every branch requires a
-- proof-view-authorising role (Secretary excluded everywhere, not just the direct
-- branch). The District/HO route requires BOTH an active, time-valid HO District role
-- AND a matching ho_district_assignments row - the generic District branch no longer
-- grants access from the District role alone. get_my_hierarchy_ids() is NOT modified.
-- ----------------------------------------------------------------------------
create or replace function public.get_my_proof_congregations()
  returns setof uuid language sql stable security definer set search_path to '' as $function$
  with me as (
    select uha.scope_level, uha.hierarchy_id, uha.congregation_id, uha.role
    from public.user_hierarchy_access uha
    where uha.user_id = (select auth.uid())
      and uha.status = 'active'
      and uha.start_date <= now()
      and (uha.end_date is null or uha.end_date >= now())
      and uha.role <> 'Secretary'      -- proof-view excludes Secretary on ALL routes
  )
  -- Direct congregation (Treasurer/Chairperson/Auditor/Elder-as-congregation etc.)
  select c.id from public.congregations c, me
    where me.scope_level = 'Congregation' and me.congregation_id is not null and c.id = me.congregation_id
  union
  select c.id from public.congregations c, me
    where me.scope_level = 'Overseership' and c.overseership_id = me.hierarchy_id
  union
  select c.id from public.congregations c, me
    where me.scope_level = 'Apostleship' and c.apostleship_id = me.hierarchy_id
  union
  select c.id from public.congregations c, me
    where me.scope_level = 'Eldership' and c.eldership_id = me.hierarchy_id
  union
  -- District/HO: require the HO role at District scope AND the district assignment. No
  -- access from a District-scope role alone (closes the generic-branch bypass).
  select c.id
    from public.congregations c
    join public.ho_district_assignments hda on hda.district_id = c.district_id
    join me on me.scope_level = 'District' and me.role = 'HO' and me.hierarchy_id = hda.district_id
    where hda.user_id = (select auth.uid());
$function$;

revoke all on function public.get_my_proof_congregations() from public, anon;
grant execute on function public.get_my_proof_congregations() to authenticated;

-- ----------------------------------------------------------------------------
-- Underscore-bucket leak fix (bucket AND (A OR B) on both branches).
-- ----------------------------------------------------------------------------
drop policy if exists "cashbook_proofs insert - active access" on storage.objects;
drop policy if exists "cashbook_proofs update - active access" on storage.objects;
drop policy if exists "cashbook_proofs delete - active access" on storage.objects;

create policy "cashbook_proofs insert - active access" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cashbook_proofs' and (
      (storage.foldername(name))[1]::uuid in (select uha.congregation_id from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active')
      or exists (select 1 from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active' and uha.scope_level <> 'Congregation')
    )
  );
create policy "cashbook_proofs update - active access" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'cashbook_proofs' and (
      (storage.foldername(name))[1]::uuid in (select uha.congregation_id from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active')
      or exists (select 1 from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active' and uha.scope_level <> 'Congregation')
    )
  )
  with check (
    bucket_id = 'cashbook_proofs' and (
      (storage.foldername(name))[1]::uuid in (select uha.congregation_id from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active')
      or exists (select 1 from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active' and uha.scope_level <> 'Congregation')
    )
  );
create policy "cashbook_proofs delete - active access" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'cashbook_proofs' and (
      (storage.foldername(name))[1]::uuid in (select uha.congregation_id from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active')
      or exists (select 1 from public.user_hierarchy_access uha where uha.user_id = (select auth.uid()) and uha.status = 'active' and uha.scope_level <> 'Congregation')
    )
  );

-- Drop the four UNSCOPED hyphen-bucket policies (authority = bucket id only).
drop policy if exists "Authenticated_CRUD l4t6gw_0" on storage.objects;
drop policy if exists "Authenticated_CRUD l4t6gw_1" on storage.objects;
drop policy if exists "Authenticated_CRUD l4t6gw_2" on storage.objects;
drop policy if exists "Authenticated_CRUD l4t6gw_3" on storage.objects;

-- SELECT (read / mint signed url): per-congregation, non-Secretary access only.
create policy "proofs_select_scoped" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'cashbook-proofs'
    and public.proof_path_congregation(name) in (select public.get_my_proof_congregations())
  );

-- ----------------------------------------------------------------------------
-- INSERT (capture upload) R04/R08: uploader = caller; the key resolves to an EXACT
-- editable period via the single parser; caller holds a capture role in that period's
-- congregation. Malformed keys resolve to NULL and deny. Post-submission uploads are not
-- permitted here (editable states only; the client gate retains them - R09).
-- ----------------------------------------------------------------------------
create policy "proofs_insert_capture" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cashbook-proofs'
    and public.proof_path_uploader(name) = (select auth.uid())
    and exists (
      select 1 from public.cashbook_period cp
      where cp.id = public.proof_path_period_id(name)
        and cp.status in ('Draft','Rejected')
        and exists (
          select 1 from public.user_hierarchy_access uha
          where uha.user_id = (select auth.uid()) and uha.status = 'active'
            and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
            and uha.congregation_id = cp.congregation_id
            and uha.role in ('Elder','Chairperson','Treasurer')
        )
    )
  );

-- UPDATE: no general update policy -> overwrite of an existing object key is DENIED.

-- ----------------------------------------------------------------------------
-- DELETE (R05/R08): ordinary capture-role correction while the EXACT parent period is
-- editable, AND only when NO attachment still references the object (physical cleanup is
-- separate from logical detachment - never delete evidence another item still needs).
-- No HO/any-role exception for locked periods.
-- ----------------------------------------------------------------------------
create policy "proofs_delete_correction" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'cashbook-proofs'
    and exists (
      select 1 from public.cashbook_period cp
      where cp.id = public.proof_path_period_id(name)
        and cp.status in ('Draft','Rejected')
        and exists (
          select 1 from public.user_hierarchy_access uha
          where uha.user_id = (select auth.uid()) and uha.status = 'active'
            and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
            and uha.congregation_id = cp.congregation_id
            and uha.role in ('Elder','Chairperson','Treasurer')
        )
    )
    and public.proof_object_reference_count(name) = 0
  );

-- ----------------------------------------------------------------------------
-- Attachment INSERT + linkage-changing UPDATE (R04): the referenced object must resolve
-- (via the SAME parser, after legacy normalisation) to the EXACT period the line item
-- belongs to; attachment.congregation_id must equal that period's congregation; the
-- period must be editable; the caller must hold a capture role there; and the object must
-- actually EXIST and have been uploaded by the caller (first path segment is not proof).
-- Shared slips (many line items, one object, same period) satisfy this per row.
-- ----------------------------------------------------------------------------
drop policy if exists "Insert own congregation attachments" on public.cashbook_attachment;
drop policy if exists "Update/Delete own congregation attachments" on public.cashbook_attachment;

create policy "attach_insert_linked" on public.cashbook_attachment
  for insert to authenticated
  with check (
    public.proof_path_period_id(public.proof_ref_key(cashbook_attachment.file_url)) =
      (select li.period_id from public.cashbook_line_item li where li.id = cashbook_attachment.line_item_id)
    and exists (
      select 1 from public.cashbook_period cp
      where cp.id = public.proof_path_period_id(public.proof_ref_key(cashbook_attachment.file_url))
        and cp.congregation_id = cashbook_attachment.congregation_id
        and cp.status in ('Draft','Rejected')
        and exists (
          select 1 from public.user_hierarchy_access uha
          where uha.user_id = (select auth.uid()) and uha.status = 'active'
            and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
            and uha.congregation_id = cp.congregation_id and uha.role in ('Elder','Chairperson','Treasurer')
        )
    )
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'cashbook-proofs'
        and o.name = public.proof_ref_key(cashbook_attachment.file_url)
        and o.owner = (select auth.uid())
    )
  );

create policy "attach_update_linked" on public.cashbook_attachment
  for update to authenticated
  using ( cashbook_attachment.congregation_id in (select public.get_my_hierarchy_ids()) )
  with check (
    public.proof_path_period_id(public.proof_ref_key(cashbook_attachment.file_url)) =
      (select li.period_id from public.cashbook_line_item li where li.id = cashbook_attachment.line_item_id)
    and exists (
      select 1 from public.cashbook_period cp
      where cp.id = public.proof_path_period_id(public.proof_ref_key(cashbook_attachment.file_url))
        and cp.congregation_id = cashbook_attachment.congregation_id
        and cp.status in ('Draft','Rejected')
        and exists (
          select 1 from public.user_hierarchy_access uha
          where uha.user_id = (select auth.uid()) and uha.status = 'active'
            and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
            and uha.congregation_id = cp.congregation_id and uha.role in ('Elder','Chairperson','Treasurer')
        )
    )
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'cashbook-proofs'
        and o.name = public.proof_ref_key(cashbook_attachment.file_url)
        and o.owner = (select auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- Locked-period lock (item 1): RESTRICTIVE (AND-combined) deny of attachment UPDATE/DELETE
-- once the parent period is not editable, for ALL roles incl HO (no unconditional
-- exception). Base DELETE policy below handles the editable case.
-- ----------------------------------------------------------------------------
create policy "attach_locked_no_update" on public.cashbook_attachment
  as restrictive for update to authenticated
  using (
    exists (
      select 1 from public.cashbook_line_item li
      join public.cashbook_period cp on cp.id = li.period_id
      where li.id = cashbook_attachment.line_item_id and cp.status in ('Draft','Rejected')
    )
  );
create policy "attach_locked_no_delete" on public.cashbook_attachment
  as restrictive for delete to authenticated
  using (
    exists (
      select 1 from public.cashbook_line_item li
      join public.cashbook_period cp on cp.id = li.period_id
      where li.id = cashbook_attachment.line_item_id and cp.status in ('Draft','Rejected')
    )
  );

-- Base DELETE (logical detachment) stays congregation-scoped; the restrictive lock above
-- confines it to editable periods. (Deployed "Delete own congregation attachments" kept.)

-- ----------------------------------------------------------------------------
-- R06: one logical attachment identity at the DB boundary. NON-DESTRUCTIVE: fail if
-- existing logical duplicates (same line item + same normalised object key, incl.
-- legacy-url/bare-key equivalents) exist, so an operator reconciles them first - we never
-- silently consolidate or delete evidence. Then enforce uniqueness on the normalised key,
-- which still allows many line items to reference ONE shared slip (distinct line_item_id).
-- ----------------------------------------------------------------------------
do $$
declare dup_count int;
begin
  select count(*) into dup_count from (
    select line_item_id, public.proof_ref_key(file_url) as k
    from public.cashbook_attachment
    group by line_item_id, public.proof_ref_key(file_url)
    having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise exception 'Found % logical duplicate attachment group(s); reconcile (non-destructively) before adding the unique index', dup_count;
  end if;
end $$;

create unique index if not exists cashbook_attachment_line_item_objectkey_uidx
  on public.cashbook_attachment (line_item_id, public.proof_ref_key(file_url));

-- ----------------------------------------------------------------------------
-- RESIDUAL (reported, out of scope here): attachment-row SELECT remains the deployed
-- congregation/see-all policy (proof METADATA, not image bytes). General financial-write
-- /audit hardening and the server-side submission-snapshot protocol are separate.
-- ============================================================================
-- END - NOT APPLIED. Apply only in a disposable local/test environment after
-- `supabase db pull`; gate on the supabase/tests/ effective-policy suite passing.
-- ============================================================================
