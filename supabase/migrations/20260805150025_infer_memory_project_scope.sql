-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- Automatic project memories use the legacy insertion signature and therefore
-- do not explicitly pass project_scope. Infer a conservative named-project key
-- from the summary so later state updates supersede the same project without an
-- additional model or embedding call.

create or replace function public.infer_memory_project_scope(p_summary text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := regexp_replace(btrim(coalesce(p_summary, '')), '[[:space:]]+', ' ', 'g');
  v_match text[];
  v_scope text;
begin
  if v_text = '' then
    return null;
  end if;

  -- "Project Aster uses ...", "project called Aster is ..."
  v_match := regexp_match(
    v_text,
    '\mproject[[:space:]]+(?:(?:called|named)[[:space:]]+)?["“]?([[:alnum:]_][[:alnum:]_.-]*(?:[[:space:]]+[[:alnum:]_][[:alnum:]_.-]*){0,2})["”]?[[:space:]]+(?:is|uses|has|needs|will|should|must|currently|now)\M',
    'i'
  );

  -- "building StudentOS is ...", "working on SentIQ Chat uses ..."
  if v_match is null then
    v_match := regexp_match(
      v_text,
      '\m(?:working[[:space:]]+on|building|developing|maintaining)[[:space:]]+["“]?([[:alnum:]_][[:alnum:]_.-]*(?:[[:space:]]+[[:alnum:]_][[:alnum:]_.-]*){0,2})["”]?[[:space:]]+(?:is|uses|has|needs|will|should|must|currently|now)\M',
      'i'
    );
  end if;

  -- Canonical product/project names generally retain capitals in generated
  -- summaries: "SentIQ Chat is ...", "StudentOS needs ...".
  if v_match is null then
    v_match := regexp_match(
      v_text,
      '([[:upper:]][[:alnum:]_.-]*(?:[[:space:]]+[[:upper:]][[:alnum:]_.-]*){0,2})[[:space:]]+(?:is|uses|has|needs|will|should|must|currently|now)\M'
    );
  end if;

  if v_match is null or btrim(coalesce(v_match[1], '')) = '' then
    return null;
  end if;

  v_scope := btrim(v_match[1]);
  v_scope := regexp_replace(v_scope, '^(?:The[[:space:]]+|Project[[:space:]]+)+', '', 'i');
  v_scope := regexp_replace(
    v_scope,
    '[[:space:]]+(?:project|app|application|platform|system)$',
    '',
    'i'
  );
  v_scope := btrim(v_scope, ' "“”''');

  if length(v_scope) < 2 or lower(v_scope) in (
    'the user', 'user', 'project', 'app', 'application', 'platform', 'system'
  ) then
    return null;
  end if;

  return left(v_scope, 120);
end;
$$;

create or replace function public.normalize_memory_subject_key(
  p_type text,
  p_summary text,
  p_project_scope text default null
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_type text := lower(btrim(coalesce(p_type, 'project')));
  v_summary text := lower(regexp_replace(btrim(coalesce(p_summary, '')), '[[:space:]]+', ' ', 'g'));
  v_project_name text := coalesce(
    nullif(btrim(p_project_scope), ''),
    public.infer_memory_project_scope(p_summary)
  );
  v_project text := lower(regexp_replace(
    btrim(coalesce(v_project_name, '')),
    '[^[:alnum:]_-]+',
    '-',
    'g'
  ));
begin
  if v_type = 'preference' then
    if v_summary ~ '\m(concise|brief|short|detailed|verbose|long|length|wordy)\M' then
      return 'preference:response_length';
    elsif v_summary ~ '\m(formal|casual|friendly|professional|tone)\M' then
      return 'preference:response_tone';
    elsif v_summary ~ '\m(dark|light|theme|appearance)\M' then
      return 'preference:appearance';
    elsif v_summary ~ '\m(language|english|bengali|hindi|bangla)\M' then
      return 'preference:language';
    elsif v_summary ~ '\m(bullet|bullets|list|paragraph|format)\M' then
      return 'preference:response_format';
    end if;
  elsif v_type = 'identity' then
    if v_summary ~ '\m(name|called)\M' then return 'identity:name'; end if;
    if v_summary ~ '\m(email|e-mail)\M' then return 'identity:email'; end if;
    if v_summary ~ '\m(phone|mobile|number)\M' then return 'identity:phone'; end if;
    if v_summary ~ '\m(birthday|date of birth|born)\M' then return 'identity:birthday'; end if;
    if v_summary ~ '\m(live|lives|located|location|city|country|address)\M' then return 'identity:location'; end if;
    if v_summary ~ '\m(student|degree|college|university|school|occupation|job|role)\M' then return 'identity:education_or_role'; end if;
  elsif v_type = 'project' and v_project <> '' then
    return 'project:' || left(trim(both '-' from v_project), 96);
  end if;

  return v_type || ':' || left(encode(digest(v_summary, 'sha256'), 'hex'), 32);
end;
$$;

-- Re-key existing project memories conservatively when a named project can be
-- inferred, then collapse any newly revealed active conflicts.
update public.memories as memory
set
  project_scope = coalesce(
    nullif(btrim(memory.project_scope), ''),
    public.infer_memory_project_scope(memory.summary)
  ),
  subject_key = public.normalize_memory_subject_key(
    memory.type,
    memory.summary,
    coalesce(
      nullif(btrim(memory.project_scope), ''),
      public.infer_memory_project_scope(memory.summary)
    )
  )
where memory.type = 'project';

with ordered as (
  select
    memory.id,
    row_number() over (
      partition by memory.user_id, memory.scope, memory.chat_id, memory.subject_key
      order by memory.last_confirmed_at desc, memory.created_at desc, memory.id desc
    ) as position,
    lead(memory.id) over (
      partition by memory.user_id, memory.scope, memory.chat_id, memory.subject_key
      order by memory.last_confirmed_at desc, memory.created_at desc, memory.id desc
    ) as prior_id
  from public.memories as memory
  where memory.status = 'active'
), superseded as (
  update public.memories as memory
  set status = 'superseded'
  from ordered
  where ordered.id = memory.id
    and ordered.position > 1
  returning memory.id
)
update public.memories as memory
set supersedes_memory_id = ordered.prior_id
from ordered
where ordered.id = memory.id
  and ordered.position = 1
  and ordered.prior_id is not null;

revoke all on function public.infer_memory_project_scope(text) from public, anon;
grant execute on function public.infer_memory_project_scope(text)
  to authenticated, service_role;

comment on function public.infer_memory_project_scope(text) is
  'Conservatively derives a canonical named-project scope from an existing memory summary without a model or embedding call.';
