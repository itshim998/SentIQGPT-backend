-- RUN ON: Database 1, 2, 3, 4 (Control DB + Data shards)

alter table if exists public.messages
  add column if not exists message_type text not null default 'text',
  add column if not exists image_url text,
  add column if not exists storage_path text,
  add column if not exists prompt text,
  add column if not exists provider text,
  add column if not exists file_size_bytes integer;

create unique index if not exists messages_assistant_image_client_request_id_unique
  on public.messages (conversation_id, client_request_id)
  where role = 'assistant' and message_type = 'image' and client_request_id is not null;
