-- RUN ON: Control database 1 only. No plan quotas or generation RPCs change.
begin;

create or replace function public.reserve_image_edit_usage(
  p_user_id uuid, p_anonymous_key_hash text, p_feature text, p_units integer,
  p_request_id text, p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare effective record; existing public.quota_reservations%rowtype; expected_units integer;
  quota jsonb; quota_limit integer; window_seconds integer; occupied integer;
begin
  if p_user_id is null or p_anonymous_key_hash is not null or p_feature is distinct from 'image_generation'
     or coalesce(p_request_id,'') !~ '^image-edit:[0-9a-f]{64}$' then raise exception 'invalid image edit identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sentiq:image-edit:' || p_request_id, 0));
  select * into effective from public.get_effective_plan(p_user_id) limit 1;
  if effective.plan_code is null or effective.plan_code not in ('student_core', 'premium', 'pro') then
    raise exception 'image editing requires paid subscription';
  end if;
  expected_units := case when effective.plan_code = 'pro' and p_metadata ->> 'execution_mode' = 'intuitive' then 8 else 2 end;
  if p_units is distinct from expected_units or p_metadata ->> 'image_edit' is distinct from 'true'
     or coalesce(p_metadata ->> 'execution_mode','') not in ('fast','intuitive')
     or coalesce(p_metadata ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid image edit reservation'; end if;
  select * into existing from public.quota_reservations where request_id = p_request_id for update;
  if existing.id is not null and (existing.user_id is distinct from p_user_id
      or existing.feature is distinct from p_feature or existing.metadata ->> 'fingerprint' is distinct from p_metadata ->> 'fingerprint') then
    raise exception 'image edit request conflict';
  end if;
  if existing.id is not null and existing.status = 'reserved' and existing.reservation_expires_at <= now() then
    -- Recovery can occur after TTL. Re-acquire capacity under the same ledger lock
    -- before making an expired reservation chargeable again.
    perform pg_advisory_xact_lock(hashtextextended('sentiq:quota:' || p_user_id::text || ':image_generation', 0));
    select entitlements->'quotas'->'image_generation' into quota from public.billing_plans where code=effective.plan_code;
    quota_limit := (quota->>'limit')::integer;
    window_seconds := (quota->>'window_seconds')::integer;
    select coalesce(sum(units),0) into occupied from (
      select units from public.usage_events where user_id=p_user_id and feature='image_generation'
        and created_at >= now()-make_interval(secs=>window_seconds)
      union all
      select units from public.quota_reservations where user_id=p_user_id and feature='image_generation'
        and id<>existing.id and status='reserved' and reservation_expires_at>now()
        and created_at >= now()-make_interval(secs=>window_seconds)
    ) live;
    if coalesce(quota_limit,0) - occupied < existing.units then
      return jsonb_build_object('reserved',false,'reason','quota_exceeded','plan_code',effective.plan_code,
        'limit',quota_limit,'remaining',greatest(0,quota_limit-occupied));
    end if;
    update public.quota_reservations set reservation_expires_at=now()+interval '1 hour',created_at=now(),updated_at=now()
      where id=existing.id;
  end if;
  return public.reserve_usage(p_user_id, null, p_feature, p_units, p_request_id,
    p_metadata || jsonb_build_object('ttl_seconds', 3600));
end $$;

create or replace function public.commit_image_edit_usage(
  p_request_id text, p_provider text, p_model text, p_route text, p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare reservation public.quota_reservations%rowtype; actual_units integer;
begin
  select * into reservation from public.quota_reservations where request_id = p_request_id for update;
  if reservation.id is null or reservation.metadata ->> 'image_edit' is distinct from 'true'
     or reservation.plan_code not in ('student_core', 'premium', 'pro') then raise exception 'invalid image edit ledger entry'; end if;
  actual_units := case p_model when '@cf/black-forest-labs/flux-2-klein-4b' then 2
    when 'openai/gpt-image-2' then 8 when 'microsoft/mai-image-2.6' then 8 else null end;
  if actual_units is null or actual_units > reservation.units
      or (p_metadata ->> 'actual_image_credits')::integer is distinct from actual_units then
    raise exception 'invalid image edit settlement cost';
  end if;
  if reservation.status='reserved' and reservation.reservation_expires_at <= now() then
    return jsonb_build_object('committed',false,'reason','reservation_expired');
  end if;
  if (reservation.plan_code = 'pro' and reservation.metadata ->> 'execution_mode' = 'intuitive')
      is distinct from (p_model in ('openai/gpt-image-2', 'microsoft/mai-image-2.6')) then
    raise exception 'invalid image edit model family';
  end if;
  return public.commit_usage_reservation(p_request_id, p_provider, p_model, p_route,
    p_metadata || jsonb_build_object('actual_image_credits', actual_units));
end $$;

revoke all on function public.reserve_image_edit_usage(uuid,text,text,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.commit_image_edit_usage(text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_image_edit_usage(uuid,text,text,integer,text,jsonb) to service_role;
grant execute on function public.commit_image_edit_usage(text,text,text,text,jsonb) to service_role;
commit;
