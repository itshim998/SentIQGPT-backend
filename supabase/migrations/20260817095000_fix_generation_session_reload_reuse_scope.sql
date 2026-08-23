-- Fix: only a session in explicit close-grace may be reused on reload.
-- Two simultaneously open tabs must keep distinct generation sessions.

create or replace function public.open_chat_generation_session(
  p_user_id uuid,
  p_anonymous_id text
)
returns public.chat_generation_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generation_sessions%rowtype;
begin
  select * into v_row
  from public.chat_generation_sessions
  where status = 'open'
    and close_grace_expires_at is not null
    and close_grace_expires_at > now()
    and (
      (p_user_id is not null and user_id = p_user_id)
      or (p_user_id is null and user_id is null and anonymous_id = nullif(btrim(p_anonymous_id), ''))
    )
  order by close_grace_expires_at asc
  limit 1;

  if v_row.id is not null then
    update public.chat_generation_sessions
    set close_requested_at = null,
        close_grace_expires_at = null,
        last_heartbeat_at = now(),
        status = 'open'
    where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  insert into public.chat_generation_sessions (user_id, anonymous_id, status, last_heartbeat_at)
  values (p_user_id, nullif(btrim(p_anonymous_id), ''), 'open', now())
  returning * into v_row;

  return v_row;
end;
$$;
