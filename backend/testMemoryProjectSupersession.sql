\set ON_ERROR_STOP on

-- Runs after backend/testMemoryHybridRetrieval.sql in the same PostgreSQL test
-- database. The original Aster memory deliberately supplied project_scope;
-- this update does not, matching the automatic legacy insertion path.

select *
from public.persist_memory_with_lifecycle(
  p_user_id => '10000000-0000-4000-8000-000000000001',
  p_type => 'project',
  p_summary => 'Project Aster now uses a delegated watcher for interrupted requests.',
  p_importance => 9,
  p_scope => 'global',
  p_confidence => 0.95
);

do $$
declare
  v_active integer;
  v_superseded integer;
  v_link uuid;
  v_scope text;
begin
  select
    count(*) filter (where status = 'active'),
    count(*) filter (where status = 'superseded')
  into v_active, v_superseded
  from public.memories
  where user_id = '10000000-0000-4000-8000-000000000001'
    and subject_key = 'project:aster';

  select supersedes_memory_id, project_scope
  into v_link, v_scope
  from public.memories
  where user_id = '10000000-0000-4000-8000-000000000001'
    and subject_key = 'project:aster'
    and status = 'active';

  if v_active <> 1 or v_superseded <> 1 or v_link is null or v_scope <> 'Aster' then
    raise exception 'project supersession failed: active=% superseded=% link=% scope=%',
      v_active, v_superseded, v_link, v_scope;
  end if;
end;
$$;

create temporary table phase3_aster_after_update as
select *
from public.search_memories_lexical(
  '10000000-0000-4000-8000-000000000001',
  'What does Project Aster use now?',
  '20000000-0000-4000-8000-000000000001',
  12
);

do $$
begin
  if not exists (
    select 1
    from phase3_aster_after_update
    where summary = 'Project Aster now uses a delegated watcher for interrupted requests.'
      and status = 'active'
  ) then
    raise exception 'updated Project Aster state was not retrieved';
  end if;

  if exists (
    select 1
    from phase3_aster_after_update
    where summary = 'Project Aster uses a deterministic recovery queue for unfinished requests.'
  ) then
    raise exception 'superseded Project Aster state leaked into retrieval';
  end if;
end;
$$;

select 'phase3-project-supersession-ok' as result;
