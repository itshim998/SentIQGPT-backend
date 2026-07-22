import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve("frontend/scripts/features/chat-controller.js");
const lines = readFileSync(path, "utf8").split(/\r?\n/);
const start = 1335;
const end = 1470;
console.log(lines.slice(start - 1, end).map((line, offset) => `${start + offset}: ${line}`).join("\n"));
