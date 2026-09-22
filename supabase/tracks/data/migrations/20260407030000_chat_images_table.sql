-- ═══════════════════════════════════════════════════════════════════════════════
-- SentIQ Chat Chat Images Metadata Table
-- 
-- Stores ONLY metadata (URLs) for images stored in Supabase Storage.
-- Actual image files are stored in the configured image storage project
-- (SENTIQ_IMAGE_STORAGE_DB, default db1) in the 'sentiq-images' bucket.
--
-- RUN ON: Database 2, 3, 4 (Data shards only, NOT on Control DB 1)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- CHAT IMAGES TABLE
-- Stores image metadata with references to Supabase Storage
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.chat_images (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    chat_id uuid not null references public.conversations (id) on delete cascade,
    image_url text not null,
    storage_path text not null,
    prompt text,
    provider text,
    file_size_bytes integer,
    created_at timestamptz not null default now()
);

-- Indexes for efficient lookups
create index if not exists chat_images_user_id_idx on public.chat_images (user_id);
create index if not exists chat_images_chat_id_idx on public.chat_images (chat_id);
create index if not exists chat_images_user_chat_idx on public.chat_images (user_id, chat_id);
create index if not exists chat_images_created_at_idx on public.chat_images (created_at desc);

-- Enable Row Level Security
alter table public.chat_images enable row level security;

-- RLS Policies: Users can only access their own images
drop policy if exists "chat_images_select_own" on public.chat_images;
create policy "chat_images_select_own"
on public.chat_images
for select
using (user_id = auth.uid());

drop policy if exists "chat_images_insert_own" on public.chat_images;
create policy "chat_images_insert_own"
on public.chat_images
for insert
with check (user_id = auth.uid());

drop policy if exists "chat_images_delete_own" on public.chat_images;
create policy "chat_images_delete_own"
on public.chat_images
for delete
using (user_id = auth.uid());

-- Service role has full access (for backend operations)
revoke all on table public.chat_images from public;
revoke all on table public.chat_images from anon;
grant select, insert, delete on table public.chat_images to authenticated;
grant all on table public.chat_images to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Get images for a chat
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.get_chat_images(p_user_id uuid, p_chat_id uuid)
returns table(
    id uuid,
    image_url text,
    storage_path text,
    prompt text,
    provider text,
    file_size_bytes integer,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    select
        ci.id,
        ci.image_url,
        ci.storage_path,
        ci.prompt,
        ci.provider,
        ci.file_size_bytes,
        ci.created_at
    from public.chat_images ci
    where ci.user_id = p_user_id
      and ci.chat_id = p_chat_id
    order by ci.created_at asc;
end;
$$;

-- Grant execute to service_role only
revoke all on function public.get_chat_images(uuid, uuid) from public;
revoke all on function public.get_chat_images(uuid, uuid) from anon;
revoke all on function public.get_chat_images(uuid, uuid) from authenticated;
grant execute on function public.get_chat_images(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Count user's total images (for quota tracking)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.get_user_image_stats(p_user_id uuid)
returns table(
    total_images integer,
    total_bytes bigint,
    total_mb numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    select
        count(*)::integer as total_images,
        coalesce(sum(ci.file_size_bytes), 0)::bigint as total_bytes,
        round(coalesce(sum(ci.file_size_bytes), 0) / 1048576.0, 2) as total_mb
    from public.chat_images ci
    where ci.user_id = p_user_id;
end;
$$;

-- Grant execute to service_role only
revoke all on function public.get_user_image_stats(uuid) from public;
revoke all on function public.get_user_image_stats(uuid) from anon;
revoke all on function public.get_user_image_stats(uuid) from authenticated;
grant execute on function public.get_user_image_stats(uuid) to service_role;
