// SentIQ Chat — Chart Intent Detector
//
// Detects when a user message is requesting a chart or data visualization
// using keyword matching. Returns a structured ChartIntent for downstream
// use by the chart spec generator.
//
// Pattern matching is deterministic and requires no LLM call, keeping
// latency low for chart routing decisions.

import type { ChartType, DataSourceType, ChartIntent } from "./types";

// ==============================
// Pattern tables
// ==============================

const CHART_TYPE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly type: ChartType }> = [
  { pattern: /\bscatter\s*(?:plot|chart|graph)?\b/i, type: "scatter" },
  { pattern: /\bregression\s*(?:plot|line|chart|graph)?\b/i, type: "regression" },
  { pattern: /\bpca\s*(?:plot|chart|visualization)?\b/i, type: "pca" },
  { pattern: /\bcluster(?:ing)?\s*(?:plot|visualization|chart|graph)?\b/i, type: "clustering" },
  { pattern: /\bheat\s*map\b/i, type: "heatmap" },
  { pattern: /\btime[\s-]?series\b/i, type: "time_series" },
  { pattern: /\bhistogram\b/i, type: "histogram" },
  { pattern: /\bdistribution\s*(?:plot|chart|graph)?\b/i, type: "histogram" },
  { pattern: /\bbox\s*(?:plot|chart|graph)?\b/i, type: "box" },
  { pattern: /\bpie\s*(?:chart|graph|plot)?\b/i, type: "pie" },
  { pattern: /\bbar\s*(?:chart|graph|plot)?\b/i, type: "bar" },
  { pattern: /\bline\s*(?:graph|chart|plot)?\b/i, type: "line" },
];

function extractInlineStaticValues(message: string): number[] | null {
  const candidate = message.match(/\b(?:comparing|compare|values?|data|with|of|for)\b([\s\S]{0,140})/i)?.[1] ?? message;
  const values = [...candidate.matchAll(/[-+]?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  return values.length >= 2 && values.length <= 20 ? values : null;
}

// ==============================
// Public API
// ==============================

/**
 * Returns true if the user message appears to be requesting a chart or
 * data visualization.
 */
/**
 * Extract the chart type from a message (defaults to "scatter" when
 * no specific chart keyword is matched).
 */
export function detectChartType(message: string): ChartType {
  for (const { pattern, type } of CHART_TYPE_PATTERNS) {
    if (pattern.test(message)) return type;
  }
  return "scatter";
}

/**
 * Analyse a user message and return a structured ChartIntent.
 *
 * This function is purely deterministic — no LLM call is made.
 */
export function detectChartIntent(message: string): ChartIntent {
  const type = detectChartType(message);

  // ---- Data source ----
  let data_source: DataSourceType = "generated_data";
  if (/\b(?:my|our|the|this|given|provided|uploaded|existing)\b\s+data\b/i.test(message)) {
    data_source = "user_data";
  } else if (/\b(?:sin|cos|tan|log|exp|sqrt|x\s*=|f\(x\)|y\s*=)\b/i.test(message)) {
    data_source = "mathematical_function";
  }

  // ---- Optional parameter extraction ----
  const parameters: Record<string, unknown> = {};

  const pointsMatch = message.match(/\b(\d{2,5})\s*(?:points|samples|observations)\b/i);
  if (pointsMatch) {
    parameters.num_points = parseInt(pointsMatch[1], 10);
  }

  const meanMatch = message.match(/\bmean\s*[=:]\s*([+-]?\d+(?:\.\d+)?)\b/i);
  if (meanMatch) parameters.mean = parseFloat(meanMatch[1]);

  const stdMatch = message.match(
    /\b(?:std|stdev|standard\s*deviation)\s*[=:]\s*(\d+(?:\.\d+)?)\b/i,
  );
  if (stdMatch) parameters.std = parseFloat(stdMatch[1]);

  if (type === "bar" || type === "pie") {
    const catMatch = message.match(/\[([^\]]+)\]/);
    if (catMatch) {
      parameters.categories = catMatch[1]
        .split(",")
        .map((c) => c.trim().replace(/['"]/g, ""))
        .filter(Boolean);
    }

    const staticValues = extractInlineStaticValues(message);
    if (staticValues) {
      parameters.values = staticValues;
      if (!parameters.categories) {
        parameters.categories = staticValues.map((_, index) => `Item ${index + 1}`);
      }
    }
  }

  return { type, data_source, parameters };
}
