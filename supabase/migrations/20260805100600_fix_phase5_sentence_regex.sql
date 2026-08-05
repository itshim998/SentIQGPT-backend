-- RUN ON: Database 2, 3, 4 only (data shards; never the control database).
--
-- PostgreSQL's regular-expression engine rejects the lazy bounded repetition
-- used by the original sentence helpers with SQLSTATE 2201B. These replacements
-- use compatible character classes and deterministic first/last matches while
-- preserving the 500-character map bound.

create or replace function public.source_first_sentence(p_text text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := regexp_replace(
    btrim(coalesce(p_text, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  v_match text[];
begin
  if v_text = '' then
    return '';
  end if;

  v_match := regexp_match(v_text, '^([^.!?]*[.!?])');
  return left(coalesce(v_match[1], v_text), 500);
end;
$$;

create or replace function public.source_last_sentence(p_text text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := regexp_replace(
    btrim(coalesce(p_text, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  v_match text[];
  v_last text := '';
begin
  if v_text = '' then
    return '';
  end if;

  for v_match in
    select matched.parts
    from regexp_matches(
      v_text,
      '([^.!?]+[.!?]|[^.!?]+$)',
      'g'
    ) as matched(parts)
  loop
    if btrim(coalesce(v_match[1], '')) <> '' then
      v_last := btrim(v_match[1]);
    end if;
  end loop;

  return right(case when v_last <> '' then v_last else v_text end, 500);
end;
$$;

revoke all on function public.source_first_sentence(text) from public, anon;
revoke all on function public.source_last_sentence(text) from public, anon;

grant execute on function public.source_first_sentence(text)
  to authenticated, service_role;
grant execute on function public.source_last_sentence(text)
  to authenticated, service_role;

comment on function public.source_first_sentence(text) is
  'Returns a bounded deterministic first sentence using PostgreSQL-compatible regular expressions.';
comment on function public.source_last_sentence(text) is
  'Returns a bounded deterministic last sentence using PostgreSQL-compatible regular expressions.';
