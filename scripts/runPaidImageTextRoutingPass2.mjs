import fs from "node:fs";

const marker = 'export const SENTIQ_TOOL_REGISTRY_VERSION = "2026-08-paid-image-text-routing-v1";';
const contract = fs.readFileSync("backend/orchestrator/toolContract.ts", "utf8");
if (contract.includes(marker)) {
  console.log("Paid image text-routing Pass 2 is already applied.");
  process.exit(0);
}
await import("./applyPaidImageTextRoutingPass2.mjs");
