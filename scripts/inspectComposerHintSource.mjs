import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve("frontend/scripts/features/chat-controller.js");
const lines = readFileSync(path, "utf8").split(/\r?\n/);
const matches = [];
for (let index = 0; index < lines.length; index += 1) {
  if (!/composerHint(?:Text|Timer|Overlay|Index|Cycle|Intro)/.test(lines[index])) continue;
  const start = Math.max(0, index - 8);
  const end = Math.min(lines.length, index + 12);
  matches.push({
    line: index + 1,
    excerpt: lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join("\n"),
  });
}
console.log(JSON.stringify({ matches }, null, 2));
