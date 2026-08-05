-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
-- APPLY AFTER:
--   20260805220000_add_cross_conversation_continuity.sql
--
-- Replaces the metadata-only trigger with the final trigger-maintained FTS
-- vector implementation and backfills all existing conversation capsules.

create or replace function public.prepare_context_capsule_continuity_row()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_title text;
begin
  if new.scope <> 'conversation' or new.conversation_id is null then
    new.project_key := null;
    new.entity_keys := array[]::text[];
    new.continuity_search_vector := null;
    return new;
  end if;

  select conversation.title
  into v_title
  from public.conversations as conversation
  where conversation.id = new.conversation_id
    and conversation.user_id = new.owner_user_id;

  new.project_key := public.infer_context_capsule_project_key(v_title, new.content);
  new.entity_keys := public.extract_context_capsule_entity_keys(
    v_title,
    new.content,
    new.project_key
  );
  new.continuity_search_vector :=
    setweight(to_tsvector('simple', coalesce(new.project_key, '')), 'A') ||
    setweight(to_tsvector(
      'simple',
      array_to_string(coalesce(new.entity_keys, array[]::text[]), ' ')
    ), 'A') ||
    setweight(to_tsvector('english', coalesce(new.content, '')), 'B');
  return new;
end;
$$;

drop trigger if exists prepare_context_capsule_continuity_row_trigger
  on public.context_capsules;
create trigger prepare_context_capsule_continuity_row_trigger
before insert or update of owner_user_id, scope, conversation_id, content
on public.context_capsules
for each row
execute function public.prepare_context_capsule_continuity_row();

update public.context_capsules as capsule
set content = capsule.content;

revoke all on function public.prepare_context_capsule_continuity_row()
  from public, anon;
grant execute on function public.prepare_context_capsule_continuity_row()
  to authenticated, service_role;

comment on function public.prepare_context_capsule_continuity_row() is
  'Derives project/entity metadata and maintains the weighted continuity FTS vector without a model or embedding call.';
