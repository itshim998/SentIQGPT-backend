export function formatCompactTokenNumber(value) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount < 1_000) return Math.round(amount).toLocaleString("en-IN");
  const unit = amount >= 1_000_000
    ? { threshold: 1_000_000, suffix: "M" }
    : { threshold: 1_000, suffix: "K" };
  const compact = amount / unit.threshold;
  const digits = compact < 100 && compact % 1 !== 0 ? 1 : 0;
  return `${compact.toFixed(digits).replace(/\.0$/, "")}${unit.suffix}`;
}

export function calculateUsagePercent(limit, remaining) {
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (!safeLimit) return 0;
  const consumed = Math.max(0, safeLimit - Math.max(0, Number(remaining) || 0));
  return Math.min(100, Math.round((consumed / safeLimit) * 100));
}
