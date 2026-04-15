-- RUN ON: Database 1, 2, 3, 4 (Control DB + Data shards)

create extension if not exists pgcrypto;

create table if not exists public.users (
    id uuid primary key references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    plan text not null default 'free'
);

create table if not exists public.conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    title text,
    created_at timestamptz not null default now()
);

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations (id) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.memories (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    type text not null check (type in ('identity', 'preference', 'project')),
    summary text not null,
    importance integer not null check (importance between 1 and 10),
    created_at timestamptz not null default now()
);

create table if not exists public.usage_logs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    date date not null,
    requests_count integer not null default 0 check (requests_count >= 0),
    tokens_used integer not null default 0 check (tokens_used >= 0),
    images_generated integer not null default 0 check (images_generated >= 0),
    unique (user_id, date)
);

create index if not exists conversations_user_id_idx on public.conversations (user_id);
create index if not exists messages_conversation_id_idx on public.messages (conversation_id);
create index if not exists memories_user_id_idx on public.memories (user_id);

alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.usage_logs enable row level security;

drop policy if exists "users_select_own" on public.users;
create policy "users_select_own"
on public.users
for select
using (id = auth.uid());

drop policy if exists "users_insert_own" on public.users;
create policy "users_insert_own"
on public.users
for insert
with check (id = auth.uid());

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own"
on public.users
for update
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "users_delete_own" on public.users;
create policy "users_delete_own"
on public.users
for delete
using (id = auth.uid());

drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own"
on public.conversations
for select
using (user_id = auth.uid());

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own"
on public.conversations
for insert
with check (user_id = auth.uid());

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own"
on public.conversations
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own"
on public.conversations
for delete
using (user_id = auth.uid());

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own"
on public.messages
for select
using (
    exists (
        select 1
        from public.conversations c
        where c.id = messages.conversation_id
          and c.user_id = auth.uid()
    )
);

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own"
on public.messages
for insert
with check (
    exists (
        select 1
        from public.conversations c
        where c.id = messages.conversation_id
          and c.user_id = auth.uid()
    )
);

drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_own"
on public.messages
for update
using (
    exists (
        select 1
        from public.conversations c
        where c.id = messages.conversation_id
          and c.user_id = auth.uid()
    )
)
with check (
    exists (
        select 1
        from public.conversations c
        where c.id = messages.conversation_id
          and c.user_id = auth.uid()
    )
);

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own"
on public.messages
for delete
using (
    exists (
        select 1
        from public.conversations c
        where c.id = messages.conversation_id
          and c.user_id = auth.uid()
    )
);

drop policy if exists "memories_select_own" on public.memories;
create policy "memories_select_own"
on public.memories
for select
using (user_id = auth.uid());

drop policy if exists "memories_insert_own" on public.memories;
create policy "memories_insert_own"
on public.memories
for insert
with check (user_id = auth.uid());

drop policy if exists "memories_update_own" on public.memories;
create policy "memories_update_own"
on public.memories
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "memories_delete_own" on public.memories;
create policy "memories_delete_own"
on public.memories
for delete
using (user_id = auth.uid());

drop policy if exists "usage_logs_select_own" on public.usage_logs;
create policy "usage_logs_select_own"
on public.usage_logs
for select
using (user_id = auth.uid());

drop policy if exists "usage_logs_insert_own" on public.usage_logs;
create policy "usage_logs_insert_own"
on public.usage_logs
for insert
with check (user_id = auth.uid());

drop policy if exists "usage_logs_update_own" on public.usage_logs;
create policy "usage_logs_update_own"
on public.usage_logs
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "usage_logs_delete_own" on public.usage_logs;
create policy "usage_logs_delete_own"
on public.usage_logs
for delete
using (user_id = auth.uid());
