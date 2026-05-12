// SentIQGPT v2 — Tool Detector (Orchestrator Layer)
//
// Uses Groq (via route_classify task) to detect the user's intent
// and route to the appropriate handler.
//
// Routes:
//   "normal_chat"      → ChatHandler (Gemini reasoning)
//   "image_generation"  → ImageGenerationHandler
//   "file_analysis"     → ChatHandler with file context
//   "knowledge_query"   → ChatHandler with deep reasoning prompt
//   "memory_update"     → Explicit memory store/update request
//   "chart_generation"  → ChartRouter (matplotlib / plotly / chart.js)
//
// Falls back to "normal_chat" on any error.

import {
  callLLMAdapter,
  getDemoFallbackResponse,
  strictParseJsonObject,
} from "../ai/PromptBuilders";
import type { LLMAdapterCall } from "../ai/PromptBuilders";
import { isChartRequest } from "../tools/chartGeneration/chartDetector";

export type DetectedTool =
  | "normal_chat"
  | "image_generation"
  | "file_analysis"
  | "knowledge_query"
  | "memory_update"
  | "chart_generation"
  | "file_generation"
  | "math_reasoning"
  | "web_search"
  | "clarification";

const VALID_TOOLS: ReadonlySet<string> = new Set<DetectedTool>([
  "normal_chat",
  "image_generation",
  "file_analysis",
  "knowledge_query",
  "memory_update",
  "chart_generation",
  "file_generation",
  "web_search",
]);

export interface ToolDetectionResult {
  readonly tool: DetectedTool;
  readonly confidence: number; // 0–1
  readonly extracted_prompt?: string; // refined prompt for the tool
}

/**
 * Build the route classification prompt.
 */
function buildRouteClassifyPrompt(
  userMessage: string,
  hasFileContext: boolean,
): LLMAdapterCall {
  const prompt =
    "TASK: Route Classification\n" +
    "ROLE: Determine which tool should handle the user's message.\n\n" +
    "AVAILABLE TOOLS:\n" +
    '- "normal_chat": General conversation, Q&A, reasoning, analysis, coding help\n' +
    '- "image_generation": User explicitly wants to generate, create, draw, or make an image/picture/art\n' +
    '- "file_analysis": User is asking about, referencing, or analyzing uploaded file content\n' +
    '- "knowledge_query": User asks a deep, complex, or research-level question requiring thorough reasoning (e.g. explain quantum computing, compare frameworks)\n' +
    '- "memory_update": User explicitly asks the AI to remember, save, or store a personal fact, preference, or project\n' +
    '- "chart_generation": User wants a chart, graph, or data visualization (scatter plot, bar chart, histogram, heatmap, etc.)\n\n' +
    "RULES:\n" +
    "- Only choose image_generation if the user EXPLICITLY requests creating a new image.\n" +
    "- Only choose file_analysis if the user references uploaded files or documents" +
    (hasFileContext ? " (files ARE available in context)." : " (NO files in context — use normal_chat instead).") +
    "\n" +
    "- Choose knowledge_query for in-depth questions that need structured, detailed answers.\n" +
    "- Choose memory_update only when the user explicitly asks you to remember, save, store, or keep something in mind.\n" +
    "- Choose chart_generation only for an explicit chart or data-visualization request, not for frontend/design prompts that merely mention visualization.\n" +
    "- Default to normal_chat for anything ambiguous.\n" +
    '- If image_generation, extract the image description into "extracted_prompt".\n' +
    '- If memory_update, extract what should be remembered into "extracted_prompt".\n\n' +
    "USER MESSAGE:\n" +
    userMessage +
    "\n\nRETURN JSON:\n" +
    '{\n  "tool": "normal_chat"|"image_generation"|"file_analysis"|"knowledge_query"|"memory_update"|"chart_generation",\n' +
    '  "confidence": 0.0-1.0,\n' +
    '  "extracted_prompt": "optional refined prompt for the tool"\n}';

  return {
    task: "route_classify",
    prompt,
    prefer: "groq",
  };
}

/**
 * Detect which tool should handle a user message.
 *
 * Uses Groq for fast classification. Falls back to "normal_chat"
 * on any error to ensure the user always gets a response.
 */
export async function detectTool(args: {
  readonly userMessage: string;
  readonly hasFileContext?: boolean;
}): Promise<ToolDetectionResult> {
  // Hard safety rule: chart keywords ALWAYS route to chart_generation.
  // This pre-check bypasses the LLM entirely and guarantees chart requests
  // are never accidentally routed to image_generation.
  if (isChartRequest(args.userMessage)) {
    console.log(`[TOOL DETECTOR] chart keywords detected — hard-routing to chart_generation`);
    return { tool: "chart_generation", confidence: 1.0 };
  }

  const call = buildRouteClassifyPrompt(
    args.userMessage,
    args.hasFileContext ?? false,
  );

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("route_classify");
  }

  try {
    const parsed = strictParseJsonObject(raw);

    const rawTool = typeof parsed.tool === "string" && VALID_TOOLS.has(parsed.tool)
      ? (parsed.tool as DetectedTool)
      : "normal_chat";

    // Secondary safety check: if LLM incorrectly routes a chart request to
    // image_generation, override it to chart_generation.
    const tool: DetectedTool = (rawTool === "image_generation" && isChartRequest(args.userMessage))
      ? "chart_generation"
      : rawTool;

    const confidence =
      typeof parsed.confidence === "number"
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5;

    const extracted_prompt =
      typeof parsed.extracted_prompt === "string" && parsed.extracted_prompt.trim()
        ? parsed.extracted_prompt.trim()
        : undefined;

    console.log(`[TOOL DETECTOR] tool: ${tool}, confidence: ${confidence.toFixed(2)}${extracted_prompt ? `, extracted_prompt: "${extracted_prompt.slice(0, 60)}"` : ""}`);
    return { tool, confidence, extracted_prompt };
  } catch {
    console.log(`[TOOL DETECTOR] parse failed, fallback: normal_chat`);
    return { tool: "normal_chat", confidence: 0.5 };
  }
}
