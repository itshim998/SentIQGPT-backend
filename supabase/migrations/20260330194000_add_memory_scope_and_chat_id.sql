alter table public.memories
  add column if not exists scope text not null default 'global',
  add column if not exists chat_id uuid null references public.conversations(id) on delete cascade;

update public.memories
set scope = 'global'
where scope is distinct from 'global'
  and scope is not null;

create index if not exists idx_memories_user_scope_created_at
  on public.memories (user_id, scope, created_at desc);

create index if not exists idx_memories_user_chat_id_created_at
  on public.memories (user_id, chat_id, created_at desc)
  where chat_id is not null;
