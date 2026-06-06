import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";
import { getBillingMode, getPlanCatalog } from "./planCatalog";

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "..", "..", ".env"),
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

function masked(value?: string): string {
  if (!value) return "missing";
  return value.length <= 6 ? "set" : `${value.slice(0, 4)}...${value.slice(-2)}`;
}

function main() {
  const mode = getBillingMode();
  const requiresRazorpay = mode === "razorpay_test" || mode === "razorpay_live";
  const missing: string[] = [];
  if (requiresRazorpay) {
    for (const key of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
      if (!process.env[key]?.trim()) missing.push(key);
    }
    for (const plan of getPlanCatalog().filter((item) => item.code !== "free")) {
      const id = plan.providerPlanIds.razorpay;
      if (!id) missing.push(`razorpay plan id for ${plan.code}`);
    }
  }

  console.log(JSON.stringify({
    mode,
    key_id: masked(process.env.RAZORPAY_KEY_ID),
    webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET ? "set" : "missing",
    paid_plans: getPlanCatalog()
      .filter((plan) => plan.code !== "free")
      .map((plan) => ({ code: plan.code, razorpay_plan_id: masked(plan.providerPlanIds.razorpay) })),
    ready: missing.length === 0,
    missing,
  }, null, 2));

  if (missing.length > 0 && requiresRazorpay) process.exitCode = 1;
}

main();
