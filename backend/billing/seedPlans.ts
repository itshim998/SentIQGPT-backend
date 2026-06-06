import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";
import { BillingRepository } from "./billingRepository";

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "..", "..", ".env"),
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

async function main() {
  await new BillingRepository().seedPlans();
  console.log("Billing plans seeded.");
}

main().catch((error) => {
  console.error(`Billing plan seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
