-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
-- Persists uploaded text as parent/child chunks for owner-scoped retrieval.

create table if not exists public.source_documents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid null,
  title text not null check (length(btrim(title)) > 0),
  original_filename text not null check (length(btrim(original_filename)) > 0),
  mime_type text not null,
  source_type text not null check (source_type in ('pdf', 'text', 'code')),
  content_hash text not null check (length(content_hash) = 64),
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_documents_conversation_owner_fk
    foreign key (conversation_id, owner_user_id)
    references public.conversations(id, user_id)
    on delete cascade
);

create unique index if not exists source_documents_id_owner_unique
  on public.source_documents(id, owner_user_id);

create index if not exists source_documents_owner_created_idx
  on public.source_documents(owner_user_id, created_at desc);

create index if not exists source_documents_owner_conversation_idx
  on public.source_documents(owner_user_id, conversation_id, created_at desc);

create index if not exists source_documents_owner_hash_idx
  on public.source_documents(owner_user_id, content_hash);

create index if not exists source_documents_metadata_idx
  on public.source_documents using gin(metadata jsonb_path_ops);

create table if not exists public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.source_documents(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid null,
  parent_chunk_id uuid null,
  chunk_role text not null check (chunk_role in ('parent', 'child')),
  chunk_index integer not null check (chunk_index >= 0),
  heading text null,
  path text null,
  page_number integer null check (page_number is null or page_number > 0),
  content text not null check (length(btrim(content)) > 0),
  context_prefix text null,
  token_estimate integer not null check (token_estimate > 0),
  embedding_status text not null default 'pending_embedding'
    check (embedding_status in ('pending_embedding', 'ready', 'unavailable', 'failed')),
  fts tsvector generated always as (
    to_tsvector('simple', coalesce(context_prefix, '') || ' ' || content)
  ) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint source_chunks_document_owner_fk
    foreign key (document_id, owner_user_id)
    references public.source_documents(id, owner_user_id)
    on delete cascade,
  constraint source_chunks_conversation_owner_fk
    foreign key (conversation_id, owner_user_id)
    references public.conversations(id, user_id)
    on delete cascade,
  constraint source_chunks_parent_role_check check (
    (chunk_role = 'parent' and parent_chunk_id is null)
    or (chunk_role = 'child' and parent_chunk_id is not null)
  ),
  unique(document_id, chunk_role, chunk_index),
  unique(id, document_id)
);

alter table public.source_chunks
  drop constraint if exists source_chunks_parent_document_fk;
alter table public.source_chunks
  add constraint source_chunks_parent_document_fk
  foreign key (parent_chunk_id, document_id)
  references public.source_chunks(id, document_id)
  on delete cascade;

create index if not exists source_chunks_owner_idx
  on public.source_chunks(owner_user_id, created_at desc);

create index if not exists source_chunks_owner_conversation_idx
  on public.source_chunks(owner_user_id, conversation_id, created_at desc);

create index if not exists source_chunks_document_idx
  on public.source_chunks(document_id, chunk_role, chunk_index);

create index if not exists source_chunks_parent_idx
  on public.source_chunks(parent_chunk_id)
  where parent_chunk_id is not null;

create index if not exists source_chunks_role_idx
  on public.source_chunks(owner_user_id, chunk_role);

create index if not exists source_chunks_fts_idx
  on public.source_chunks using gin(fts);

create or replace function public.touch_source_document_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists source_documents_touch_updated_at on public.source_documents;
create trigger source_documents_touch_updated_at
before update on public.source_documents
for each row execute function public.touch_source_document_updated_at();

create or replace function public.search_source_chunks(
  p_owner_user_id uuid,
  p_document_ids uuid[],
  p_query text,
  p_limit integer default 12
)
returns table (
  chunk_id uuid,
  document_id uuid,
  parent_chunk_id uuid,
  title text,
  chunk_index integer,
  heading text,
  path text,
  page_number integer,
  content text,
  context_prefix text,
  token_estimate integer,
  parent_content text,
  parent_context_prefix text,
  lexical_rank real
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with query as (
    select websearch_to_tsquery('simple', coalesce(p_query, '')) as value
  )
  select
    child.id as chunk_id,
    child.document_id,
    child.parent_chunk_id,
    document.title,
    child.chunk_index,
    child.heading,
    child.path,
    child.page_number,
    child.content,
    child.context_prefix,
    child.token_estimate,
    parent.content as parent_content,
    parent.context_prefix as parent_context_prefix,
    ts_rank_cd(child.fts, query.value)::real as lexical_rank
  from public.source_chunks child
  join public.source_chunks parent
    on parent.id = child.parent_chunk_id
   and parent.document_id = child.document_id
   and parent.chunk_role = 'parent'
  join public.source_documents document
    on document.id = child.document_id
   and document.owner_user_id = child.owner_user_id
  cross join query
  where child.owner_user_id = p_owner_user_id
    and child.document_id = any(coalesce(p_document_ids, array[]::uuid[]))
    and child.chunk_role = 'child'
    and document.status = 'ready'
    and child.fts @@ query.value
  order by lexical_rank desc, child.document_id, child.chunk_index
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

alter table public.source_documents enable row level security;
alter table public.source_chunks enable row level security;

drop policy if exists "source_documents_select_own" on public.source_documents;
create policy "source_documents_select_own"
on public.source_documents for select
using (owner_user_id = auth.uid());

drop policy if exists "source_documents_insert_own" on public.source_documents;
create policy "source_documents_insert_own"
on public.source_documents for insert
with check (
  owner_user_id = auth.uid()
  and (
    conversation_id is null
    or exists (
      select 1 from public.conversations conversation
      where conversation.id = conversation_id and conversation.user_id = auth.uid()
    )
  )
);

drop policy if exists "source_documents_update_own" on public.source_documents;
create policy "source_documents_update_own"
on public.source_documents for update
using (owner_user_id = auth.uid())
with check (
  owner_user_id = auth.uid()
  and (
    conversation_id is null
    or exists (
      select 1 from public.conversations conversation
      where conversation.id = conversation_id and conversation.user_id = auth.uid()
    )
  )
);

drop policy if exists "source_documents_delete_own" on public.source_documents;
create policy "source_documents_delete_own"
on public.source_documents for delete
using (owner_user_id = auth.uid());

drop policy if exists "source_chunks_select_own" on public.source_chunks;
create policy "source_chunks_select_own"
on public.source_chunks for select
using (owner_user_id = auth.uid());

drop policy if exists "source_chunks_insert_own" on public.source_chunks;
create policy "source_chunks_insert_own"
on public.source_chunks for insert
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1 from public.source_documents document
    where document.id = document_id and document.owner_user_id = auth.uid()
  )
);

drop policy if exists "source_chunks_update_own" on public.source_chunks;
create policy "source_chunks_update_own"
on public.source_chunks for update
using (owner_user_id = auth.uid())
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1 from public.source_documents document
    where document.id = document_id and document.owner_user_id = auth.uid()
  )
);

drop policy if exists "source_chunks_delete_own" on public.source_chunks;
create policy "source_chunks_delete_own"
on public.source_chunks for delete
using (owner_user_id = auth.uid());

revoke all on table public.source_documents from public, anon;
revoke all on table public.source_chunks from public, anon;
grant select, insert, update, delete on table public.source_documents to authenticated;
grant select, insert, update, delete on table public.source_chunks to authenticated;
grant all on table public.source_documents to service_role;
grant all on table public.source_chunks to service_role;
grant execute on function public.search_source_chunks(uuid, uuid[], text, integer) to authenticated, service_role;
