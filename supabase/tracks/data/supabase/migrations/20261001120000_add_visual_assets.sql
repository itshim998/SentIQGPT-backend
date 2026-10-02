-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
-- Persists raw visual assets (scanned PDFs, native images, HEIC/HEIF) for Layer 1 visual understanding.

-- Ensure source_documents allows 'image' source_type
alter table public.source_documents
  drop constraint if exists source_documents_source_type_check;

alter table public.source_documents
  add constraint source_documents_source_type_check
  check (source_type in ('pdf', 'text', 'code', 'image'));

create table if not exists public.visual_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid null,
  filename text not null check (length(btrim(filename)) > 0),
  original_mime_type text not null,
  asset_type text not null check (asset_type in ('pdf', 'image')),
  storage_bucket text not null,
  storage_path text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (length(sha256) = 64),
  page_count integer null check (page_count is null or page_count > 0),
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
  visual_required boolean not null default true,
  visual_analysis_status text not null default 'required'
    check (visual_analysis_status in ('not_required', 'required', 'processing', 'ready', 'partial', 'failed')),
  canonical_source_document_id uuid null references public.source_documents(id) on delete set null,
  visual_analysis_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visual_assets_conversation_owner_fk
    foreign key (conversation_id, owner_user_id)
    references public.conversations(id, user_id)
    on delete cascade
);

create unique index if not exists visual_assets_id_owner_unique
  on public.visual_assets(id, owner_user_id);

create index if not exists visual_assets_owner_created_idx
  on public.visual_assets(owner_user_id, created_at desc);

create index if not exists visual_assets_owner_conversation_idx
  on public.visual_assets(owner_user_id, conversation_id, created_at desc);

create index if not exists visual_assets_owner_sha256_idx
  on public.visual_assets(owner_user_id, sha256);

create index if not exists visual_assets_metadata_idx
  on public.visual_assets using gin(metadata jsonb_path_ops);

create or replace function public.touch_visual_asset_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists visual_assets_touch_updated_at on public.visual_assets;
create trigger visual_assets_touch_updated_at
before update on public.visual_assets
for each row execute function public.touch_visual_asset_updated_at();

alter table public.visual_assets enable row level security;

drop policy if exists "visual_assets_select_own" on public.visual_assets;
create policy "visual_assets_select_own"
on public.visual_assets for select
using (owner_user_id = auth.uid());

drop policy if exists "visual_assets_insert_own" on public.visual_assets;
create policy "visual_assets_insert_own"
on public.visual_assets for insert
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

drop policy if exists "visual_assets_update_own" on public.visual_assets;
create policy "visual_assets_update_own"
on public.visual_assets for update
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

drop policy if exists "visual_assets_delete_own" on public.visual_assets;
create policy "visual_assets_delete_own"
on public.visual_assets for delete
using (owner_user_id = auth.uid());

revoke all on table public.visual_assets from public, anon;
grant select, insert, update, delete on table public.visual_assets to authenticated;
grant all on table public.visual_assets to service_role;
