// SentIQ Chat — Chart Router
//
// Orchestrates the full chart generation pipeline:
//   1. detectChartIntent  — extract chart type, data source, parameters
//   2. generateChartSpec  — build a fully-specified ChartSpec
//   3. renderChart        — produce runnable renderer code
//   4. (optional) request Python preview from LLM service
//
// This is the single entry-point used by toolExecutor.ts.

import { detectChartIntent } from "./chartDetector";
import { generateChartSpec } from "./chartSpecGenerator";
import { renderChart, rendererLabel } from "./chartRenderer";
import type { ChartResult } from "./types";
import { buildChartJsConfig, buildPlotlyFigure } from "./frontendPayloadBuilder";
import {
  getInternalGatewayHeaders,
  getInternalGatewayUrl,
  waitForInternalGatewayReady,
} from "../../internalGateway";

// ==============================
// Preview (optional)
// ==============================

const PYTHON_CHART_RENDER_ENABLED = process.env.SENTIQ_ENABLE_PYTHON_CHART_RENDER === "true";

/**
 * Ask the Python service to execute matplotlib code and return a PNG
 * preview as a data URI.  Returns undefined on any failure so the
 * chart result is still usable without a preview.
 */
async function fetchMatplotlibPreview(code: string, parentSignal?: AbortSignal): Promise<string | undefined> {
  if (!PYTHON_CHART_RENDER_ENABLED) {
    return undefined;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    await waitForInternalGatewayReady();
    if (parentSignal?.aborted) return undefined;

    const resp = await fetch(getInternalGatewayUrl("/chart/render"), {
      method: "POST",
      headers: getInternalGatewayHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });

    if (!resp.ok) return undefined;

    const body = await resp.json() as { preview?: string };
    return typeof body.preview === "string" && body.preview.length > 0
      ? body.preview
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

// ==============================
// Public API
// ==============================

export interface ChartRouterRequest {
  /** Raw user message requesting the chart */
  readonly userMessage: string;
  /** When true, attempt to fetch a PNG preview via the LLM service */
  readonly fetchPreview?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Full chart generation pipeline.
 *
 * Returns a ChartResult with the runnable code for the selected
 * renderer.  A base64 PNG preview is included when fetchPreview is true
 * and the LLM service's /chart/render endpoint is reachable.
 */
export async function routeChartGeneration(
  request: ChartRouterRequest,
): Promise<ChartResult> {
  const { userMessage, fetchPreview = false, signal } = request;

  try {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Chart generation aborted");
    // 1. Detect intent
    const intent = detectChartIntent(userMessage);
    console.log(`[CHART ROUTER] type=${intent.type} source=${intent.data_source}`);

    // 2. Build spec
    const spec = generateChartSpec(intent, userMessage);
    console.log(`[CHART ROUTER] renderer=${spec.renderer}`);

    // 3. Generate code
    const code = renderChart(spec);

    // 4. Optionally fetch preview PNG from Python service
    let preview: string | undefined;
    if (fetchPreview && spec.renderer === "matplotlib") {
      preview = await fetchMatplotlibPreview(code, signal);
      if (preview) {
        console.log(`[CHART ROUTER] preview PNG fetched (${preview.length} chars)`);
      }
    }

    const plotlyJson = spec.renderer === "plotly"
      ? buildPlotlyFigure(spec)
      : undefined;
    const chartJsConfig = spec.renderer === "chartjs"
      ? buildChartJsConfig(spec)
      : undefined;

    return {
      type: "chart",
      success: true,
      chart_type: spec.chart_type,
      renderer: spec.renderer,
      code,
      preview,
      image_base64: preview,
      plotly_json: plotlyJson,
      chartjs_config: chartJsConfig,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[CHART ROUTER] error: ${message}`);
    return {
      type: "chart",
      success: false,
      chart_type: "scatter",
      renderer: "matplotlib",
      code: "",
      error: message,
    };
  }
}

/** Convenience re-export so callers don't need to import from two places. */
export { rendererLabel };
