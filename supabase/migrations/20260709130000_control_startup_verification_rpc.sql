-- SentIQ Chat startup verification RPC for the control database.
--
-- RUN ON: Database 1 only (control DB).

create or replace function public.verify_sentiq_control_startup(p_probe_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_failures jsonb := '[]'::jsonb;
  v_timings jsonb := '[]'::jsonb;
  v_group_started_at timestamptz;
begin
  v_group_started_at := clock_timestamp();

  begin
    perform session_id, key_slot, expires_at
    from public.live_capacity_leases
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'live',
      'check', 'live_capacity_leases',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform session_id, owner_user_id, status, audio_started_at, reserved_seconds, used_seconds
    from public.live_sessions
    limit 1;
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'live',
      'check', 'live_sessions_lifecycle',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  begin
    perform public.mark_live_session_started(p_probe_user_id, p_probe_user_id, 30);
  exception when others then
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'group', 'live',
      'check', 'mark_live_session_started',
      'code', sqlstate,
      'message', left(sqlerrm, 240)
    ));
  end;

  v_timings := v_timings || jsonb_build_array(jsonb_build_object(
    'group', 'live',
    'elapsed_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - v_group_started_at)) * 1000)::integer)
  ));

  return jsonb_build_object(
    'ok', jsonb_array_length(v_failures) = 0,
    'failures', v_failures,
    'timings', v_timings
  );
end;
$$;

revoke all on function public.verify_sentiq_control_startup(uuid) from public;
revoke all on function public.verify_sentiq_control_startup(uuid) from anon;
revoke all on function public.verify_sentiq_control_startup(uuid) from authenticated;
grant execute on function public.verify_sentiq_control_startup(uuid) to service_role;
