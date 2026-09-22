create unique index if not exists messages_assistant_text_client_request_id_unique
  on public.messages (conversation_id, client_request_id)
  where role = 'assistant'
    and message_type = 'text'
    and client_request_id is not null;
