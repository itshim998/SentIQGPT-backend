-- RUN ON: Database 2, 3, 4 (Data shards)
-- Prevent malformed LLM title envelopes such as ```json, ```json {, and
-- incomplete JSON objects from ever being persisted to conversation history.
-- Also repairs malformed titles already persisted by the affected title path.

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
    candidate := regexp_replace(raw, '^`{1,3}(?:json)?[[:space:]]*|[[:space:]]*`{1,3}$', '', 'gi');
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
  -- recoverable. Valid JSON handles escaped quotes above; this fallback only
  -- needs the common title form used by the generation prompt.
  if nullif(btrim(candidate), '') is null then
    candidate := (regexp_match(
      raw,
      '"title"[[:space:]]*:[[:space:]]*"([^"]*)"'
    ))[1];
  end if;

  candidate := btrim(regexp_replace(coalesce(candidate, ''), '[[:space:]]+', ' ', 'g'));
  candidate := regexp_replace(candidate, '^`{1,3}(?:json)?[[:space:]]*|[[:space:]]*`{1,3}$', '', 'gi');
  candidate := btrim(candidate);

  -- Reject provider scaffolding. Legitimate titles may contain words such as
  -- JSON; the rejection is structural, not keyword-based.
  if candidate <> ''
     and length(candidate) between 3 and 120
     and left(candidate, 1) <> '`'
     and left(candidate, 1) not in ('{', '[')
     and candidate !~ '"title"[[:space:]]*:'
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

  first_user_message := btrim(regexp_replace(coalesce(first_user_message, ''), '[[:space:]]+', ' ', 'g'));
  if first_user_message <> '' then
    return left(first_user_message, 120);
  end if;

  return 'New Chat';
end;
$$;

create or replace function public.sanitize_conversation_title_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.title := public.normalize_conversation_title_input(new.id, new.title);
  return new;
end;
$$;

drop trigger if exists conversations_sanitize_title on public.conversations;
create trigger conversations_sanitize_title
before insert or update of title on public.conversations
for each row
execute function public.sanitize_conversation_title_trigger();

-- Repair malformed titles already persisted by the affected title-generation
-- path. Only suspicious envelope-shaped values are rewritten.
update public.conversations c
set title = public.normalize_conversation_title_input(c.id, c.title)
where c.title is not null
  and (
    left(btrim(c.title), 1) = '`'
    or left(btrim(c.title), 1) in ('{', '[')
    or btrim(c.title) ~ '"title"[[:space:]]*:'
  );
