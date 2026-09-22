-- RUN ON: Database 1, 2, 3, 4.
-- Adds versioned private-storage metadata for generated files and links file
-- assistant messages to their generated_files row.

alter table if exists public.messages
  add column if not exists generated_file_id uuid;

create index if not exists messages_generated_file_id_idx
  on public.messages (generated_file_id)
  where generated_file_id is not null;

alter table if exists public.generated_files
  add column if not exists storage_bucket text,
  add column if not exists content_sha256 text,
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

update public.generated_files
set storage_bucket = coalesce(storage_bucket, 'sentiq-generated-files')
where storage_bucket is null;

alter table public.generated_files
  alter column storage_bucket set default 'sentiq-generated-files-private',
  alter column storage_bucket set not null;

create index if not exists generated_files_updated_at_idx on public.generated_files (updated_at desc);
create index if not exists generated_files_content_sha256_idx on public.generated_files (content_sha256);

drop policy if exists "generated_files_update_own" on public.generated_files;
create policy "generated_files_update_own"
on public.generated_files
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant update on table public.generated_files to authenticated;

create or replace function public.touch_generated_files_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists generated_files_touch_updated_at on public.generated_files;
create trigger generated_files_touch_updated_at
before update on public.generated_files
for each row
execute function public.touch_generated_files_updated_at();
