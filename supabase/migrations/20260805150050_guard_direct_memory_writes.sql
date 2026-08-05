-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Compatibility guard for any administrative or legacy direct table insert.
-- Application writes use persist_memory_with_lifecycle for confirmation and
-- supersession; this trigger guarantees required deterministic metadata exists.

create or replace function public.prepare_memory_lifecycle_row()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.summary := regexp_replace(btrim(coalesce(new.summary, '')), '[[:space:]]+', ' ', 'g');
  if new.summary = '' then
    raise exception 'Memory summary is required';
  end if;

  if new.type = 'project' then
    new.project_scope := coalesce(
      nullif(btrim(new.project_scope), ''),
      public.infer_memory_project_scope(new.summary)
    );
  end if;
  new.subject_key := coalesce(
    nullif(btrim(new.subject_key), ''),
    public.normalize_memory_subject_key(new.type, new.summary, new.project_scope)
  );
  new.fact_type := coalesce(
    nullif(btrim(new.fact_type), ''),
    public.infer_memory_fact_type(new.type, new.summary)
  );
  new.last_confirmed_at := coalesce(new.last_confirmed_at, new.created_at, now());
  new.source_conversation_id := coalesce(new.source_conversation_id, new.chat_id);
  new.status := case when new.status in ('active', 'superseded') then new.status else 'active' end;
  new.confidence := greatest(0::real, least(1::real, coalesce(new.confidence, 0.75)));
  return new;
end;
$$;

drop trigger if exists prepare_memory_lifecycle_row_trigger on public.memories;
create trigger prepare_memory_lifecycle_row_trigger
before insert or update of type, summary, subject_key, fact_type, project_scope,
  last_confirmed_at, source_conversation_id, chat_id, status, confidence
on public.memories
for each row
execute function public.prepare_memory_lifecycle_row();

revoke all on function public.prepare_memory_lifecycle_row() from public, anon;
grant execute on function public.prepare_memory_lifecycle_row()
  to authenticated, service_role;
