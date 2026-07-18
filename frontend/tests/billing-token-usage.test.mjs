import assert from "node:assert/strict";
import {
  calculateUsagePercent,
  formatCompactTokenNumber,
} from "../scripts/panels/billing-usage-format.js";

assert.equal(formatCompactTokenNumber(950), "950");
assert.equal(formatCompactTokenNumber(4_800), "4.8K");
assert.equal(formatCompactTokenNumber(17_800), "17.8K");
assert.equal(formatCompactTokenNumber(25_000), "25K");
assert.equal(formatCompactTokenNumber(180_000), "180K");
assert.equal(formatCompactTokenNumber(1_200_000), "1.2M");

assert.equal(calculateUsagePercent(25_000, 17_500), 30);
assert.equal(calculateUsagePercent(25_000, 0), 100);
assert.equal(calculateUsagePercent(0, 0), 0);
assert.equal(calculateUsagePercent(25_000, 30_000), 0);

console.log("Billing token formatting checks passed.");
