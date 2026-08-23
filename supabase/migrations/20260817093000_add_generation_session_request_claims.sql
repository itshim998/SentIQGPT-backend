-- Phase 14 hardening: bind each client request to the exact browser generation session.

create table if not exists public.chat_generation_session_requests (
  user_id uuid not null,
  client_request_id text not null,
  generation_session_id uuid not null references public.chat_generation_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_request_id)
);

create index if not exists chat_generation_session_requests_session_idx
  on public.chat_generation_session_requests (generation_session_id, created_at desc);

alter table public.chat_generation_session_requests enable row level security;
drop policy if exists "chat_generation_session_requests_service_only" on public.chat_generation_session_requests;
create policy "chat_generation_session_requests_service_only"
on public.chat_generation_session_requests for all using (false) with check (false);
revoke all on table public.chat_generation_session_requests from public;
revoke all on table public.chat_generation_session_requests from anon;
revoke all on table public.chat_generation_session_requests from authenticated;
grant all on table public.chat_generation_session_requests to service_role;

create or replace function public.claim_chat_generation_session_request(
  p_user_id uuid,
  p_session_id uuid,
  p_client_request_id text
)
returns public.chat_generation_session_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.chat_generation_session_requests%rowtype;
  v_session public.chat_generation_sessions%rowtype;
  v_existing public.chat_generation_session_requests%rowtype;
begin
  if nullif(btrim(p_client_request_id), '') is null then
    raise exception 'client_request_id is required';
  end if;

  select * into v_session
  from public.chat_generation_sessions
  where id = p_session_id
    and user_id = p_user_id
    and status = 'open'
    and (close_grace_expires_at is null or close_grace_expires_at > now());

  if not found then
    raise exception 'Generation session is not active';
  end if;

  select * into v_existing
  from public.chat_generation_session_requests
  where user_id = p_user_id
    and client_request_id = btrim(p_client_request_id);

  if found then
    if v_existing.generation_session_id <> p_session_id then
      raise exception 'Client request already belongs to another generation session';
    end if;
    return v_existing;
  end if;

  insert into public.chat_generation_session_requests (user_id, client_request_id, generation_session_id)
  values (p_user_id, btrim(p_client_request_id), p_session_id)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.claim_chat_generation_session_request(uuid,uuid,text) from public;
revoke all on function public.claim_chat_generation_session_request(uuid,uuid,text) from anon;
revoke all on function public.claim_chat_generation_session_request(uuid,uuid,text) from authenticated;
grant execute on function public.claim_chat_generation_session_request(uuid,uuid,text) to service_role;

create or replace function public.attach_latest_generation_session()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed_session uuid;
  v_session_id uuid;
  v_requested_session public.chat_generation_sessions%rowtype;
begin
  if new.generation_session_id is not null then
    select * into v_requested_session
    from public.chat_generation_sessions
    where id = new.generation_session_id;
    if v_requested_session.id is not null
       and v_requested_session.status = 'open'
       and v_requested_session.user_id = new.user_id
       and (v_requested_session.close_grace_expires_at is null or v_requested_session.close_grace_expires_at > now()) then
      return new;
    end if;
    new.generation_session_id := null;
  end if;

  if new.client_request_id is not null then
    select r.generation_session_id into v_claimed_session
    from public.chat_generation_session_requests r
    where r.user_id = new.user_id
      and r.client_request_id = new.client_request_id;
    if v_claimed_session is not null then
      new.generation_session_id := v_claimed_session;
      return new;
    end if;
  end if;

  select s.id into v_session_id
  from public.chat_generation_sessions s
  where s.status = 'open'
    and s.user_id = new.user_id
    and (s.close_grace_expires_at is null or s.close_grace_expires_at > now())
  order by s.created_at desc
  limit 1;

  new.generation_session_id := v_session_id;
  return new;
end;
$$;
