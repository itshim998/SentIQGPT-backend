alter table if exists public.messages
  add column if not exists client_request_id text;

create unique index if not exists messages_user_client_request_id_unique
  on public.messages (conversation_id, client_request_id)
  where role = 'user' and client_request_id is not null;
