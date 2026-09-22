-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
-- Stores compact conversation/workspace context derived from shard-owned data.

create table if not exists public.context_capsules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  scope text not null check (scope in ('conversation', 'workspace')),
  conversation_id uuid null,
  content text not null check (length(btrim(content)) > 0),
  source_message_count integer not null default 0 check (source_message_count >= 0),
  source_cursor uuid null,
  version bigint not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint context_capsules_scope_target_check check (
    (scope = 'conversation' and conversation_id is not null)
    or (scope = 'workspace' and conversation_id is null)
  )
);

create unique index if not exists conversations_id_user_id_unique
  on public.conversations(id, user_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'context_capsules_conversation_owner_fk'
      and conrelid = 'public.context_capsules'::regclass
  ) then
    alter table public.context_capsules
      add constraint context_capsules_conversation_owner_fk
      foreign key (conversation_id, owner_user_id)
      references public.conversations(id, user_id)
      on delete cascade;
  end if;
end
$$;

create unique index if not exists context_capsules_one_conversation_capsule
  on public.context_capsules(owner_user_id, conversation_id)
  where scope = 'conversation';

create unique index if not exists context_capsules_one_workspace_capsule
  on public.context_capsules(owner_user_id)
  where scope = 'workspace';

create index if not exists context_capsules_owner_updated_idx
  on public.context_capsules(owner_user_id, updated_at desc);

create or replace function public.touch_context_capsule_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists context_capsules_touch_updated_at on public.context_capsules;
create trigger context_capsules_touch_updated_at
before update on public.context_capsules
for each row execute function public.touch_context_capsule_updated_at();

alter table public.context_capsules enable row level security;

drop policy if exists "context_capsules_select_own" on public.context_capsules;
create policy "context_capsules_select_own"
on public.context_capsules
for select
using (owner_user_id = auth.uid());

drop policy if exists "context_capsules_insert_own" on public.context_capsules;
create policy "context_capsules_insert_own"
on public.context_capsules
for insert
with check (
  owner_user_id = auth.uid()
  and (
    scope = 'workspace'
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  )
);

drop policy if exists "context_capsules_update_own" on public.context_capsules;
create policy "context_capsules_update_own"
on public.context_capsules
for update
using (owner_user_id = auth.uid())
with check (
  owner_user_id = auth.uid()
  and (
    scope = 'workspace'
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  )
);

drop policy if exists "context_capsules_delete_own" on public.context_capsules;
create policy "context_capsules_delete_own"
on public.context_capsules
for delete
using (owner_user_id = auth.uid());

revoke all on table public.context_capsules from public;
revoke all on table public.context_capsules from anon;
grant select, insert, update, delete on table public.context_capsules to authenticated;
grant all on table public.context_capsules to service_role;
