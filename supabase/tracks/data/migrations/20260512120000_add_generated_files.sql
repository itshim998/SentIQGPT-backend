-- RUN ON: Database 1, 2, 3, 4.
-- Data shards store generated-file metadata. The control database receives the
-- message columns for startup/migration compatibility with the current deploy flow.

alter table if exists public.messages
  add column if not exists file_url text,
  add column if not exists file_name text,
  add column if not exists file_format text,
  add column if not exists mime_type text,
  add column if not exists preview_json jsonb;

create unique index if not exists messages_assistant_file_client_request_id_unique
  on public.messages (conversation_id, client_request_id)
  where role = 'assistant' and message_type = 'file' and client_request_id is not null;

create table if not exists public.generated_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  chat_id uuid not null references public.conversations (id) on delete cascade,
  format text not null check (format in ('html', 'txt', 'xlsx', 'pptx', 'docx', 'pdf')),
  file_name text not null,
  mime_type text not null,
  file_url text not null,
  storage_path text not null,
  file_size_bytes integer,
  prompt text,
  provider text,
  preview_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists generated_files_user_id_idx on public.generated_files (user_id);
create index if not exists generated_files_chat_id_idx on public.generated_files (chat_id);
create index if not exists generated_files_user_chat_idx on public.generated_files (user_id, chat_id);
create index if not exists generated_files_storage_path_idx on public.generated_files (storage_path);
create index if not exists generated_files_created_at_idx on public.generated_files (created_at desc);

alter table public.generated_files enable row level security;

drop policy if exists "generated_files_select_own" on public.generated_files;
create policy "generated_files_select_own"
on public.generated_files
for select
using (user_id = auth.uid());

drop policy if exists "generated_files_insert_own" on public.generated_files;
create policy "generated_files_insert_own"
on public.generated_files
for insert
with check (user_id = auth.uid());

drop policy if exists "generated_files_delete_own" on public.generated_files;
create policy "generated_files_delete_own"
on public.generated_files
for delete
using (user_id = auth.uid());

revoke all on table public.generated_files from public;
revoke all on table public.generated_files from anon;
grant select, insert, delete on table public.generated_files to authenticated;
grant all on table public.generated_files to service_role;

create or replace function public.get_generated_files(p_user_id uuid, p_chat_id uuid)
returns table(
  id uuid,
  format text,
  file_name text,
  mime_type text,
  file_url text,
  storage_path text,
  file_size_bytes integer,
  provider text,
  preview_json jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    gf.id,
    gf.format,
    gf.file_name,
    gf.mime_type,
    gf.file_url,
    gf.storage_path,
    gf.file_size_bytes,
    gf.provider,
    gf.preview_json,
    gf.created_at
  from public.generated_files gf
  where gf.user_id = p_user_id
    and gf.chat_id = p_chat_id
  order by gf.created_at asc;
end;
$$;

revoke all on function public.get_generated_files(uuid, uuid) from public;
revoke all on function public.get_generated_files(uuid, uuid) from anon;
revoke all on function public.get_generated_files(uuid, uuid) from authenticated;
grant execute on function public.get_generated_files(uuid, uuid) to service_role;
