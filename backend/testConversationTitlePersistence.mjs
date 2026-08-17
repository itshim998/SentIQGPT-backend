import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260817180000_sanitize_conversation_titles.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");

assert.match(sql, /create or replace function public\.normalize_conversation_title_input\(/);
assert.match(sql, /create or replace function public\.sanitize_conversation_title_trigger\(\)/);
assert.match(sql, /new\.title := public\.normalize_conversation_title_input\(new\.id, new\.title\);/i);
assert.match(sql, /before insert or update of title on public\.conversations/i);
assert.match(sql, /execute function public\.sanitize_conversation_title_trigger\(\);/i);
assert.match(sql, /from public\.messages m/i);
assert.match(sql, /m\.role = 'user'/i);
assert.match(sql, /order by m\.created_at asc, m\.id asc/i);
assert.match(sql, /left\(btrim\(c\.title\), 3\) = '```'/i);
assert.match(sql, /left\(btrim\(c\.title\), 1\) in \('\{', '\['\)/i);
assert.match(sql, /return 'New Chat';/i);

assert.doesNotMatch(
  sql,
  /execute function public\.normalize_conversation_title_input\(new\./i,
  "trigger invocation must use the zero-argument trigger wrapper",
);

console.log("PASS | conversation title persistence migration contract");
