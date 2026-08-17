-- RUN ON: Database 2, 3, 4 (Data shards)
-- Prevent malformed LLM title envelopes such as ```json, ```json {, and
-- incomplete JSON objects from ever being persisted to conversation history.
-- Also repairs existing malformed titles from the first user message.

create or replace function public.normalize_conversation_title_input(
  p_conversation_id uuid,
  p_raw_title text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  raw text := btrim(coalesce(p_raw_title, ''));
  candidate text;
  first_user_message text;
  parsed jsonb;
begin
  if raw = '' then
    return null;
  end if;

  -- First accept valid JSON, including markdown-fenced JSON.
  begin
    candidate := regexp_replace(raw, '^```(?:json)?\\s*|\\s*```$', '', 'gi');
    parsed := candidate::jsonb;
    if jsonb_typeof(parsed) = 'object' then
      candidate := parsed ->> 'title';
    else
      candidate := null;
    end if;
  exception when others then
    candidate := null;
  end;

  -- Then tolerate incomplete/prose-wrapped JSON when a title field is still
  -- recoverable. This deliberately does not accept the raw JSON shell itself.
  if nullif(btrim(candidate), '') is null then
    candidate := (regexp_match(
      raw,
      '"title"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'
    ))[1];
  end if;

  candidate := btrim(regexp_replace(coalesce(candidate, ''), '\\s+', ' ', 'g'));
  candidate := regexp_replace(candidate, '^```(?:json)?\\s*|\\s*```$', '', 'gi');
  candidate := btrim(candidate);

  -- Reject provider scaffolding. Legitimate titles are allowed to contain
  -- normal prose such as the word "JSON"; the rejection is structural.
  if candidate <> ''
     and length(candidate) between 3 and 120
     and candidate !~ '^```'
     and candidate !~ '^\\s*[\\{\\[]'
     and candidate !~ '\\b"title"\\s*:'
  then
    return left(candidate, 120);
  end if;

  -- Malformed title: use the first user message as the deterministic fallback
  -- already used by the application-level title path.
  select m.content
    into first_user_message
  from public.messages m
  where m.conversation_id = p_conversation_id
    and m.role = 'user'
  order by m.created_at asc, m.id asc
  limit 1;

  first_user_message := btrim(regexp_replace(coalesce(first_user_message, ''), '\\s+', ' ', 'g'));
  if first_user_message <> '' then
    return left(first_user_message, 120);
  end if;

  return 'New Chat';
end;
$$;

drop trigger if exists conversations_sanitize_title on public.conversations;
create trigger conversations_sanitize_title
before insert or update of title on public.conversations
for each row
execute function public.normalize_conversation_title_input(NEW.id, NEW.title);

-- Repair malformed titles already persisted by the affected title-generation
-- path. Only suspicious envelope-shaped values are rewritten.
update public.conversations c
set title = public.normalize_conversation_title_input(c.id, c.title)
where c.title is not null
  and (
    btrim(c.title) ~ '^```'
    or btrim(c.title) ~ '^\\s*[\\{\\[]'
    or btrim(c.title) ~ '"title"\\s*:'
  );
