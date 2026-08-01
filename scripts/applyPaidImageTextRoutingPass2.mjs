import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const write = (path, content) => fs.writeFileSync(path, content, "utf8");

function replaceExact(path, before, after, expected = 1) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== expected) {
    throw new Error(`${path}: expected ${expected} occurrence(s), found ${count}: ${before.slice(0, 160)}`);
  }
  write(path, source.split(before).join(after));
}

function replaceRegex(path, pattern, replacement, expected = 1) {
  const source = read(path);
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== expected) {
    throw new Error(`${path}: expected ${expected} regex match(es), found ${matches.length}: ${pattern}`);
  }
  write(path, source.replace(pattern, replacement));
}

function insertAfter(path, marker, addition, expected = 1) {
  replaceExact(path, marker, `${marker}${addition}`, expected);
}

// ---------------------------------------------------------------------------
// Provider-neutral image tool contract: the texting model must classify whether
// generated pixels need readable text before Node selects the paid-plan model.
// ---------------------------------------------------------------------------
replaceExact(
  "backend/orchestrator/toolContract.ts",
  'export const SENTIQ_TOOL_REGISTRY_VERSION = "2026-07-pass5-v2";',
  'export const SENTIQ_TOOL_REGISTRY_VERSION = "2026-08-paid-image-text-routing-v1";',
);
replaceExact(
  "backend/orchestrator/toolContract.ts",
  '  image_gen: z.object({ prompt: boundedText }).strict(),',
  '  image_gen: z.object({\n    prompt: boundedText,\n    requires_text_rendering: z.boolean(),\n  }).strict(),',
);
insertAfter(
  "backend/orchestrator/toolContract.ts",
  'const stringProperty = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({\n  type: "string",\n  minLength: 1,\n  maxLength: 12_000,\n  description,\n  ...extra,\n});\n',
  '\nconst booleanProperty = (description: string): JsonSchema => ({\n  type: "boolean",\n  description,\n});\n',
);
replaceExact(
  "backend/orchestrator/toolContract.ts",
  '    description: "Generate a new image or visual asset. Use this for explicit image-generation requests instead of describing an image in chat text.",\n    inputSchema: objectSchema({ prompt: stringProperty("The image the user wants generated.") }, ["prompt"]),',
  '    description: "Generate a new image or visual asset. Use this for explicit image-generation requests instead of describing an image in chat text. Decide whether readable text must be rendered inside the generated pixels.",\n    inputSchema: objectSchema({\n      prompt: stringProperty("The image the user wants generated. Preserve all material visual and wording constraints."),\n      requires_text_rendering: booleanProperty(\n        "True only when the generated image must visibly render user-requested words, letters, numbers, captions, labels, signage, titles, slogans, logos, UI copy, or other readable text. False for purely visual scenes without required readable text.",\n      ),\n    }, ["prompt", "requires_text_rendering"]),',
);

replaceExact(
  "backend/ai/modelToolExecution.ts",
  '  executeImage: (prompt: string, call: ValidatedToolCall) => Promise<T>;',
  '  executeImage: (prompt: string, requiresTextRendering: boolean, call: ValidatedToolCall) => Promise<T>;',
);
replaceExact(
  "backend/ai/modelToolExecution.ts",
  '      case "image_gen":\n        result = await args.executeImage(String(call.arguments.prompt), call);\n        break;',
  '      case "image_gen":\n        result = await args.executeImage(\n          String(call.arguments.prompt),\n          call.arguments.requires_text_rendering === true,\n          call,\n        );\n        break;',
);

// ---------------------------------------------------------------------------
// Paid-plan model policy. Free remains DreamShaper. Essential, Plus, and Pro
// differ only by quotas; all use the same text-rendering decision.
// ---------------------------------------------------------------------------
replaceRegex(
  "backend/billing/modelEntitlementRouter.ts",
  /const IMAGE_MODEL_BY_PLAN:[\s\S]*?\}\);\n\n/,
  '',
);
replaceExact(
  "backend/billing/modelEntitlementRouter.ts",
  'export function getImageModelPreferenceForPlan(planCode: BillingPlanCode): ImageModelPreference {\n  return IMAGE_MODEL_BY_PLAN[planCode];\n}\n\n/**\n * Resolve the image model strictly from the active billing plan.\n * Prompt wording must not upgrade or downgrade the entitled image model.\n */\nexport function getImageModelForPlan(planCode: BillingPlanCode, _prompt: string): ImageModelRoute {\n  const model = getImageModelPreferenceForPlan(planCode);',
  'export function getImageModelPreferenceForPlan(\n  planCode: BillingPlanCode,\n  requiresTextRendering: boolean,\n): ImageModelPreference {\n  if (planCode === "free") return "dreamshaper";\n  return requiresTextRendering ? "gpt-image-2" : "zimage";\n}\n\n/**\n * Resolve the image model from the active billing plan and the validated\n * texting-model decision carried by image_gen. Prompt wording is never parsed\n * here, so plan enforcement remains server-owned and deterministic.\n */\nexport function getImageModelForPlan(\n  planCode: BillingPlanCode,\n  requiresTextRendering: boolean,\n): ImageModelRoute {\n  const model = getImageModelPreferenceForPlan(planCode, requiresTextRendering);',
);

write("backend/tools/imageGeneration/imageTextRenderingDecision.ts", `/**
 * Emergency fallback used only when the texting-model classification call is
 * unavailable. Normal automatic image generation always uses the validated
 * requires_text_rendering Boolean returned by image_gen.
 */
export function detectExplicitTextRenderingRequirement(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;

  const quotedCopy = /(?:write|say|says|reads?|display|show|include|containing|with(?: the)? (?:text|words?|title|caption|label|headline|slogan))[^\\n]{0,80}["“'][^"”'\\n]{1,160}["”']/i;
  const explicitCopy = /\\b(?:readable|legible|exact)\\s+(?:text|words?|letters?|numbers?|copy|typography)\\b/i;
  const textSurface = /\\b(?:poster|banner|billboard|sign(?:age)?|logo|wordmark|book cover|album cover|menu|flyer|invitation|certificate|name tag|label|caption|subtitle|headline|title card|quote card|infographic|app screen|website mockup|ui mockup)\\b/i;
  const renderingVerb = /\\b(?:write|spell|letter|typeset|render|print|display|show|read|say)\\b[^\\n]{0,80}\\b(?:text|word|phrase|name|title|caption|slogan|quote|number|date|price|label)\\b/i;

  return quotedCopy.test(normalized)
    || explicitCopy.test(normalized)
    || textSurface.test(normalized)
    || renderingVerb.test(normalized);
}
`);

// ---------------------------------------------------------------------------
// Text-model classification helper. Fast uses the native provider chain
// Groq -> Gemini -> Pollinations. Intuitive uses the native Nemotron lane.
// ---------------------------------------------------------------------------
insertAfter(
  "backend/ai/ChatHandler.ts",
  'import { GenerationBudgetError } from "../orchestrator/contextBudgetManager";\n',
  'import type { ExecutionMode } from "../orchestrator/executionProfile";\nimport { detectExplicitTextRenderingRequirement } from "../tools/imageGeneration/imageTextRenderingDecision";\n',
);
replaceExact(
  "backend/ai/ChatHandler.ts",
  '  readonly allowedModelTools: readonly SentIQToolName[];\n  readonly signal?: AbortSignal;',
  '  readonly allowedModelTools: readonly SentIQToolName[];\n  readonly executionMode?: ExecutionMode;\n  readonly signal?: AbortSignal;',
);
replaceExact(
  "backend/ai/ChatHandler.ts",
  '    execution_mode: "fast",',
  '    execution_mode: args.executionMode ?? "fast",',
);
insertAfter(
  "backend/ai/ChatHandler.ts",
  '  return result.assistant_turn?.kind === "tool_calls"\n    ? result.assistant_turn.calls\n    : [];\n}\n',
  `

export interface ImageTextRenderingDecision {
  readonly requiresTextRendering: boolean;
  readonly source: "model" | "deterministic_fallback" | "free_not_applicable";
}

export async function classifyImageTextRendering(args: {
  readonly prompt: string;
  readonly executionMode: ExecutionMode;
  readonly userId?: string;
  readonly authenticated: boolean;
  readonly signal?: AbortSignal;
}): Promise<ImageTextRenderingDecision> {
  try {
    const calls = await selectChatToolCalls({
      userMessage: args.prompt,
      modelOverride: "gpt-oss-120b",
      userId: args.userId,
      modelToolContext: {
        authenticated: args.authenticated,
        executionMode: args.executionMode,
        entitlements: { image_gen: true },
      },
      allowedModelTools: ["image_gen"],
      executionMode: args.executionMode,
      signal: args.signal,
    });
    const imageCall = calls.find((call) => call.name === "image_gen");
    if (imageCall) {
      return {
        requiresTextRendering: imageCall.arguments.requires_text_rendering === true,
        source: "model",
      };
    }
  } catch (error) {
    console.warn(JSON.stringify({
      scope: "image_text_rendering",
      event: "model_classification_unavailable",
      execution_mode: args.executionMode,
      error_type: error instanceof Error ? error.name : "unknown",
    }));
  }
  return {
    requiresTextRendering: detectExplicitTextRenderingRequirement(args.prompt),
    source: "deterministic_fallback",
  };
}
`,
);

// ---------------------------------------------------------------------------
// Orchestrator propagation: the validated Boolean travels with image_gen and
// is ignored for Free by the billing router.
// ---------------------------------------------------------------------------
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  '        allowedModelTools: automaticTools,\n        signal,',
  '        allowedModelTools: automaticTools,\n        executionMode: profile.mode,\n        signal,',
);
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  'async function execImageGeneration(\n  input: string,\n  ctx: BuiltContext,\n  profile: ExecutionProfile,\n  signal?: AbortSignal,\n): Promise<StepResult> {',
  'async function execImageGeneration(\n  input: string,\n  ctx: BuiltContext,\n  profile: ExecutionProfile,\n  signal?: AbortSignal,\n  requiresTextRendering = false,\n): Promise<StepResult> {',
);
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  '    const initialRoute = getImageModelForPlan("free", input);',
  '    const initialRoute = getImageModelForPlan("free", false);',
);
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  '    const entitledRoute = getImageModelForPlan(reservation.planCode, input);',
  '    const entitledRoute = getImageModelForPlan(reservation.planCode, requiresTextRendering);',
);
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  '      executeImage: (prompt) => execImageGeneration(prompt, ctx, profile, signal),',
  '      executeImage: (prompt, requiresTextRendering) => execImageGeneration(\n        prompt,\n        ctx,\n        profile,\n        signal,\n        requiresTextRendering,\n      ),',
);

// ---------------------------------------------------------------------------
// Direct image endpoint: reserve quota first, classify only paid requests, then
// select the same paid-plan model policy used by automatic image_gen.
// ---------------------------------------------------------------------------
replaceExact(
  "backend/server.ts",
  'import { handleChat } from "./ai/ChatHandler";',
  'import { classifyImageTextRendering, handleChat } from "./ai/ChatHandler";',
);
replaceExact(
  "backend/server.ts",
  '    const initialImageRoute = getImageModelForPlan("free", providerPrompt);',
  '    const initialImageRoute = getImageModelForPlan("free", false);',
);
replaceExact(
  "backend/server.ts",
  '    const entitledImageRoute = getImageModelForPlan(imageReservation.planCode, providerPrompt);',
  `    const textRenderingDecision = imageReservation.planCode === "free"
      ? { requiresTextRendering: false, source: "free_not_applicable" as const }
      : await classifyImageTextRendering({
          prompt: providerPrompt,
          executionMode: parsed.data.executionMode,
          userId,
          authenticated: !isGuest,
        });
    const entitledImageRoute = getImageModelForPlan(
      imageReservation.planCode,
      textRenderingDecision.requiresTextRendering,
    );`,
);
replaceExact(
  "backend/server.ts",
  '      metadata: { endpoint: "images.generate" },',
  '      metadata: { endpoint: "images.generate" },',
);
replaceExact(
  "backend/server.ts",
  '      route: entitledImageRoute.route,\n    };',
  '      route: entitledImageRoute.route,\n      metadata: {\n        ...(imageReservation.metadata ?? {}),\n        requires_text_rendering: textRenderingDecision.requiresTextRendering,\n        text_rendering_decision_source: textRenderingDecision.source,\n      },\n    };',
);
replaceExact(
  "backend/server.ts",
  '                execution_mode: "fast" as const,',
  '                execution_mode: "intuitive" as const,',
  2,
);

// ---------------------------------------------------------------------------
// Node capability registry: Groq and Gemini retain native transports;
// Pollinations gains an OpenAI-compatible native transport; Nvidia uses the
// existing rollout flags and native OpenAI-compatible stream.
// ---------------------------------------------------------------------------
insertAfter(
  "backend/ai/modelToolCapability.ts",
  'import type { SentIQToolName } from "../orchestrator/toolContract";\n',
  'import { getNemotronRolloutSnapshot } from "../nemotronRolloutFlags";\n',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  'export type LLMProviderKind = "groq" | "gemini" | "gemma" | "pollinations" | "unknown";',
  'export type LLMProviderKind = "groq" | "gemini" | "gemma" | "pollinations" | "nvidia" | "unknown";',
);
insertAfter(
  "backend/ai/modelToolCapability.ts",
  '  geminiTransport: "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",\n',
  '  pollinationsTransport: "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",\n',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '  readonly geminiTransportEnabled: boolean;\n  readonly webSurfSelectionEnabled: boolean;',
  '  readonly geminiTransportEnabled: boolean;\n  readonly pollinationsTransportEnabled: boolean;\n  readonly nvidiaTransportEnabled: boolean;\n  readonly webSurfSelectionEnabled: boolean;',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '  pollinations: { provider: "pollinations", buffered: false, streaming: false, reason: "text_only_transport" },\n  unknown:',
  '  pollinations: { provider: "pollinations", buffered: true, streaming: true, reason: "openai_function_transport" },\n  nvidia: { provider: "nvidia", buffered: true, streaming: true, reason: "openai_function_transport" },\n  unknown:',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '  const transportEnabled = provider === "groq"\n    ? isGroqSentIQToolTransportEnabled()\n    : provider === "gemini"\n      ? isGeminiSentIQToolTransportEnabled()\n      : false;',
  '  const transportEnabled = provider === "groq"\n    ? isGroqSentIQToolTransportEnabled()\n    : provider === "gemini"\n      ? isGeminiSentIQToolTransportEnabled()\n      : provider === "pollinations"\n        ? isPollinationsSentIQToolTransportEnabled()\n        : provider === "nvidia"\n          ? isNvidiaSentIQToolTransportEnabled()\n          : false;',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '  if (provider === "gemini" || provider === "gemma" || provider === "pollinations") {\n    return provider;\n  }',
  '  if (provider === "gemini" || provider === "gemma" || provider === "pollinations" || provider === "nvidia") {\n    return provider;\n  }',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '  if (provider === "groq") return isGroqSentIQToolTransportEnabled();\n  if (provider === "gemini") return isGeminiSentIQToolTransportEnabled();\n  return false;',
  '  if (provider === "groq") return isGroqSentIQToolTransportEnabled();\n  if (provider === "gemini") return isGeminiSentIQToolTransportEnabled();\n  if (provider === "pollinations") return isPollinationsSentIQToolTransportEnabled();\n  if (provider === "nvidia") return isNvidiaSentIQToolTransportEnabled();\n  return false;',
);
insertAfter(
  "backend/ai/modelToolCapability.ts",
  'export function isGeminiSentIQToolTransportEnabled(\n  value = process.env[SENTIQ_MODEL_TOOL_ENV.geminiTransport],\n): boolean {\n  return value?.trim().toLowerCase() === "true";\n}\n',
  '\nexport function isPollinationsSentIQToolTransportEnabled(\n  value = process.env[SENTIQ_MODEL_TOOL_ENV.pollinationsTransport],\n): boolean {\n  return value === undefined ? true : value.trim().toLowerCase() === "true";\n}\n\nexport function isNvidiaSentIQToolTransportEnabled(): boolean {\n  const flags = getNemotronRolloutSnapshot();\n  return flags.nvidiaProvider && flags.nemotronIntuitive;\n}\n',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '    geminiTransportEnabled: isGeminiSentIQToolTransportEnabled(),\n    webSurfSelectionEnabled:',
  '    geminiTransportEnabled: isGeminiSentIQToolTransportEnabled(),\n    pollinationsTransportEnabled: isPollinationsSentIQToolTransportEnabled(),\n    nvidiaTransportEnabled: isNvidiaSentIQToolTransportEnabled(),\n    webSurfSelectionEnabled:',
);
replaceExact(
  "backend/ai/modelToolCapability.ts",
  '  if (!flags.groqTransportEnabled && !flags.geminiTransportEnabled) return [];',
  '  if (\n    !flags.groqTransportEnabled\n    && !flags.geminiTransportEnabled\n    && !flags.pollinationsTransportEnabled\n    && !flags.nvidiaTransportEnabled\n  ) return [];',
);

for (const path of [".env.example", ".env.template"]) {
  insertAfter(
    path,
    'SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED=false\n',
    'SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED=true\n',
  );
}

// ---------------------------------------------------------------------------
// Python gateway capability parity and native Pollinations/Nvidia transports.
// ---------------------------------------------------------------------------
insertAfter(
  "llm_adapter.py",
  'SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED = _parse_bool_env("SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED", False)\n',
  'SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED = _parse_bool_env("SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED", True)\n',
);
insertAfter(
  "llm_adapter.py",
  '    "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",\n',
  '    "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",\n',
);
replaceExact(
  "llm_adapter.py",
  '    "gemini_transport_enabled": SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,\n',
  '    "gemini_transport_enabled": SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,\n    "pollinations_transport_enabled": SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED,\n',
);
replaceExact(
  "llm_adapter.py",
  '    reason = "text_only_model" if _is_gemma_model(model) else "text_only_transport"\n    return {"provider": normalized_provider or "unknown", "supported": False, "streaming": False, "reason": reason}',
  '    if normalized_provider == "pollinations":\n        enabled = SENTIQ_MODEL_TOOL_REGISTRY_ENABLED and SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED\n        return {"provider": "pollinations", "supported": enabled, "streaming": enabled, "reason": "openai_function_transport" if enabled else "transport_disabled"}\n    if normalized_provider == "nvidia":\n        enabled = (\n            SENTIQ_MODEL_TOOL_REGISTRY_ENABLED\n            and _parse_bool_env("SENTIQ_NVIDIA_PROVIDER_ENABLED", False)\n            and _parse_bool_env("SENTIQ_NEMOTRON_INTUITIVE_ENABLED", False)\n        )\n        return {"provider": "nvidia", "supported": enabled, "streaming": enabled, "reason": "openai_function_transport" if enabled else "transport_disabled"}\n    reason = "text_only_model" if _is_gemma_model(model) else "text_only_transport"\n    return {"provider": normalized_provider or "unknown", "supported": False, "streaming": False, "reason": reason}',
);
replaceExact(
  "llm_adapter.py",
  '    if sentiq_tool_request:\n        return False\n    return "image_input" not in set(required_capabilities or [])',
  '    if "image_input" in set(required_capabilities or []):\n        return False\n    if sentiq_tool_request:\n        return bool(get_sentiq_tool_capability("nvidia", NVIDIA_NEMOTRON_MODEL).get("supported"))\n    return True',
);

replaceExact(
  "llm_adapter.py",
  'def _build_pollinations_payload(\n    prompt: str,\n    model: str,\n    temperature: float,\n    max_output_tokens: Optional[int] = None,\n    image_attachments: Optional[list[dict[str, Any]]] = None,\n) -> dict:',
  'def _build_pollinations_payload(\n    prompt: str,\n    model: str,\n    temperature: float,\n    max_output_tokens: Optional[int] = None,\n    image_attachments: Optional[list[dict[str, Any]]] = None,\n    sentiq_tool_request: Optional[dict[str, Any]] = None,\n) -> dict:',
);
replaceExact(
  "llm_adapter.py",
  '    payload = {\n        "model": _normalize_pollinations_model(model),\n        "messages": [{"role": "user", "content": content}],\n        "temperature": temperature,\n    }\n    if max_output_tokens is not None:\n        payload["max_tokens"] = max_output_tokens\n    return payload',
  '    messages: list[dict[str, Any]] = []\n    policy = str((sentiq_tool_request or {}).get("tool_choice_policy") or "").strip()\n    if policy:\n        messages.append({"role": "system", "content": policy})\n    messages.append({"role": "user", "content": content})\n    payload = {\n        "model": _normalize_pollinations_model(model),\n        "messages": messages,\n        "temperature": temperature,\n    }\n    sentiq_tools = _serialize_openai_sentiq_tools(sentiq_tool_request) if sentiq_tool_request else []\n    if sentiq_tools:\n        payload["tools"] = sentiq_tools\n        payload["tool_choice"] = "auto"\n        payload["parallel_tool_calls"] = False\n    if max_output_tokens is not None:\n        payload["max_tokens"] = max_output_tokens\n    return payload',
);

insertAfter(
  "llm_adapter.py",
  'def _extract_openai_text_stream(content) -> str:\n    return _extract_openai_text(content, trim=False)\n',
  `

def _openai_dict_assistant_turn(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        return _assistant_text_turn("")
    raw_calls = message.get("tool_calls")
    if isinstance(raw_calls, list) and raw_calls:
        calls: list[dict[str, Any]] = []
        for index, call in enumerate(raw_calls):
            if not isinstance(call, dict):
                continue
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            calls.append({
                "id": str(call.get("id") or f"pollinations_call_{index}"),
                "name": str(function.get("name") or ""),
                "arguments": function.get("arguments") or "{}",
                "index": index,
            })
        if calls:
            return {"kind": "tool_calls", "calls": calls}
    return _assistant_text_turn(_extract_openai_text(message.get("content")))
`,
);
replaceExact(
  "llm_adapter.py",
  'def _extract_pollinations_response(resp: _requests_lib.Response) -> tuple[str, Optional[str]]:',
  'def _extract_pollinations_response(\n    resp: _requests_lib.Response,\n    sentiq_tool_request: Optional[dict[str, Any]] = None,\n) -> tuple[Any, Optional[str]]:',
);
replaceExact(
  "llm_adapter.py",
  '                message = first_choice.get("message")\n                if isinstance(message, dict):\n                    text = _extract_openai_text(message.get("content"))\n                    if text:\n                        return text, finish_reason',
  '                message = first_choice.get("message")\n                if isinstance(message, dict):\n                    if sentiq_tool_request:\n                        return _openai_dict_assistant_turn(message), finish_reason\n                    text = _extract_openai_text(message.get("content"))\n                    if text:\n                        return text, finish_reason',
);
replaceExact(
  "llm_adapter.py",
  '    return resp.text.strip(), finish_reason\n\n\ndef _pollinations_candidate_endpoints',
  '    fallback_text = resp.text.strip()\n    return (_assistant_text_turn(fallback_text) if sentiq_tool_request else fallback_text), finish_reason\n\n\ndef _pollinations_candidate_endpoints',
);
replaceExact(
  "llm_adapter.py",
  '            delta = first_choice.get("delta")\n            if isinstance(delta, dict):\n                text = _extract_openai_text_stream(delta.get("content"))\n\n    return {\n        "kind": "chunk",\n        "text": text,\n        "finish_reason": finish_reason,\n        "payload": payload,\n    }',
  '            delta = first_choice.get("delta")\n            tool_calls: list[dict[str, Any]] = []\n            if isinstance(delta, dict):\n                text = _extract_openai_text_stream(delta.get("content"))\n                raw_tool_calls = delta.get("tool_calls")\n                if isinstance(raw_tool_calls, list):\n                    tool_calls = [call for call in raw_tool_calls if isinstance(call, dict)]\n\n    return {\n        "kind": "chunk",\n        "text": text,\n        "tool_calls": tool_calls if "tool_calls" in locals() else [],\n        "finish_reason": finish_reason,\n        "payload": payload,\n    }',
);
replaceExact(
  "llm_adapter.py",
  'def _call_pollinations(\n    prompt: str,\n    model: str,\n    temperature: float = 0.7,\n    max_output_tokens: Optional[int] = None,\n    image_attachments: Optional[list[dict[str, Any]]] = None,\n) -> tuple[str, Optional[str], bool]:',
  'def _call_pollinations(\n    prompt: str,\n    model: str,\n    temperature: float = 0.7,\n    max_output_tokens: Optional[int] = None,\n    image_attachments: Optional[list[dict[str, Any]]] = None,\n    sentiq_tool_request: Optional[dict[str, Any]] = None,\n) -> tuple[Any, Optional[str], bool]:',
);
replaceExact(
  "llm_adapter.py",
  '        max_output_tokens,\n        effective_images,\n    )',
  '        max_output_tokens,\n        effective_images,\n        sentiq_tool_request,\n    )',
  2,
);
replaceExact(
  "llm_adapter.py",
  '    result, finish_reason = _extract_pollinations_response(resp)\n    truncated = finish_reason in {"length", "max_tokens", "content_filter", "reason-length"}\n    logger.info(\n        "[Pollinations] response received status=%s endpoint=%s chars=%d finish_reason=%s",\n        resp.status_code,\n        endpoint_used,\n        len(result),\n        finish_reason,\n    )',
  '    result, finish_reason = _extract_pollinations_response(resp, sentiq_tool_request)\n    truncated = finish_reason in {"length", "max_tokens", "content_filter", "reason-length"}\n    response_chars = len(result.get("text", "")) if isinstance(result, dict) else len(result)\n    _log_sentiq_tool_diagnostic(\n        boundary="pollinations_provider_outcome",\n        provider="pollinations",\n        model=model,\n        streaming=False,\n        sentiq_tool_request=sentiq_tool_request,\n        declarations_attached=bool((sentiq_tool_request or {}).get("tools")),\n        tool_choice_mode="auto" if sentiq_tool_request else "none",\n        sdk_path="openai_compatible_http",\n        provider_outcome="function_call" if isinstance(result, dict) and result.get("kind") == "tool_calls" else "text",\n        selected_tool=(result.get("calls") or [{}])[0].get("name") if isinstance(result, dict) and result.get("kind") == "tool_calls" else None,\n    )\n    logger.info(\n        "[Pollinations] response received status=%s endpoint=%s chars=%d finish_reason=%s",\n        resp.status_code,\n        endpoint_used,\n        response_chars,\n        finish_reason,\n    )',
);
replaceExact(
  "llm_adapter.py",
  '            len(result),\n            payload["model"],',
  '            response_chars,\n            payload["model"],',
);
replaceExact(
  "llm_adapter.py",
  'def _call_pollinations_stream(\n    prompt: str, \n    model: str, \n    temperature: float = 0.7,\n    image_attachments: Optional[list[dict[str, Any]]] = None,\n    max_output_tokens: Optional[int] = None,\n):',
  'def _call_pollinations_stream(\n    prompt: str, \n    model: str, \n    temperature: float = 0.7,\n    image_attachments: Optional[list[dict[str, Any]]] = None,\n    max_output_tokens: Optional[int] = None,\n    sentiq_tool_request: Optional[dict[str, Any]] = None,\n):',
);
replaceExact(
  "llm_adapter.py",
  '    finish_reason = None\n    first_text_ms: Optional[int] = None\n    text_chunks = 0\n    saw_done = False',
  '    finish_reason = None\n    first_text_ms: Optional[int] = None\n    text_chunks = 0\n    saw_done = False\n    emitted_sentiq_outcome = False\n    tool_call_state: dict[int, dict[str, Any]] = {}',
);
replaceExact(
  "llm_adapter.py",
  '            text = event.get("text") or ""\n            if not text:\n                continue\n\n            if first_text_ms is None:',
  '            for raw_call in event.get("tool_calls") or []:\n                index = int(raw_call.get("index") or 0)\n                state = tool_call_state.setdefault(index, {"id": "", "name": "", "arguments": "", "started": False})\n                call_id = str(raw_call.get("id") or "")\n                function = raw_call.get("function") if isinstance(raw_call.get("function"), dict) else {}\n                name_delta = str(function.get("name") or "")\n                arguments_delta = str(function.get("arguments") or "")\n                if call_id:\n                    state["id"] = call_id\n                if name_delta:\n                    state["name"] = str(state.get("name") or "") + name_delta\n                if arguments_delta:\n                    state["arguments"] = str(state.get("arguments") or "") + arguments_delta\n                if sentiq_tool_request and not state.get("started") and state.get("name"):\n                    state["started"] = True\n                    emitted_sentiq_outcome = True\n                    yield {\n                        "kind": "tool_call_start",\n                        "id": str(state.get("id") or f"pollinations_call_{index}"),\n                        "name": str(state.get("name") or ""),\n                        "index": index,\n                    }\n                    buffered_arguments = str(state.get("arguments") or "")\n                    if buffered_arguments:\n                        yield {\n                            "kind": "tool_argument_delta",\n                            "id": str(state.get("id") or f"pollinations_call_{index}"),\n                            "text": buffered_arguments,\n                            "index": index,\n                        }\n                        state["arguments"] = ""\n                elif sentiq_tool_request and state.get("started") and arguments_delta:\n                    yield {\n                        "kind": "tool_argument_delta",\n                        "id": str(state.get("id") or f"pollinations_call_{index}"),\n                        "text": arguments_delta,\n                        "index": index,\n                    }\n                    state["arguments"] = ""\n\n            text = event.get("text") or ""\n            if not text:\n                continue\n\n            emitted_sentiq_outcome = True\n            if first_text_ms is None:',
);
replaceExact(
  "llm_adapter.py",
  '            text_chunks += 1\n            yield text',
  '            text_chunks += 1\n            yield {"kind": "text_delta", "text": text} if sentiq_tool_request else text',
);
replaceExact(
  "llm_adapter.py",
  '    if first_text_ms is None:\n        raise RuntimeError(\n            f"Pollinations stream produced no text within {first_chunk_timeout}s"\n        )',
  '    if sentiq_tool_request:\n        if any(not state.get("started") for state in tool_call_state.values()):\n            raise RuntimeError("Pollinations stream produced an incomplete SentIQ tool call")\n        if not emitted_sentiq_outcome:\n            raise RuntimeError("Pollinations stream produced neither assistant text nor a tool call")\n        _log_sentiq_tool_diagnostic(\n            boundary="pollinations_provider_outcome",\n            provider="pollinations",\n            model=model,\n            streaming=True,\n            sentiq_tool_request=sentiq_tool_request,\n            declarations_attached=True,\n            tool_choice_mode="auto",\n            sdk_path="openai_compatible_http",\n            provider_outcome="function_call" if tool_call_state else "text",\n            selected_tool=next((str(state.get("name") or "") for state in tool_call_state.values()), None),\n        )\n        yield {"kind": "done", "finishReason": finish_reason} if finish_reason else {"kind": "done"}\n        return\n    if first_text_ms is None:\n        raise RuntimeError(\n            f"Pollinations stream produced no text within {first_chunk_timeout}s"\n        )',
);

// Pass tool declarations through all provider and fallback paths that may carry
// a tool-capability requirement.
replaceExact(
  "llm_adapter.py",
  '            image_attachments=image_attachments,\n        )\n        payload = _build_response_payload(fallback_result)',
  '            image_attachments=image_attachments,\n            sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "pollinations", pollinations_model),\n        )\n        payload = _build_response_payload(fallback_result)',
  1,
);
replaceExact(
  "llm_adapter.py",
  '                image_attachments=image_attachments,\n            )\n        elif provider == "groq":',
  '                image_attachments=image_attachments,\n                sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "pollinations", resolved_override or model),\n            )\n        elif provider == "groq":',
);
replaceExact(
  "llm_adapter.py",
  '                reasoning_budget=reasoning_budget,\n            )\n            _nvidia_call_state.telemetry',
  '                reasoning_budget=reasoning_budget,\n                sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "nvidia", NVIDIA_NEMOTRON_MODEL),\n            )\n            _nvidia_call_state.telemetry',
);
replaceExact(
  "llm_adapter.py",
  '                reasoning_budget=reasoning_budget,\n            ):\n                if isinstance(event, str):',
  '                reasoning_budget=reasoning_budget,\n                sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "nvidia", NVIDIA_NEMOTRON_MODEL, streaming=True),\n            ):\n                if isinstance(event, str):',
);
replaceExact(
  "llm_adapter.py",
  '                if isinstance(event, dict) and event.get("kind") == "provider_usage":',
  '                if isinstance(event, dict) and event.get("kind") in {"tool_call_start", "tool_argument_delta", "done"}:\n                    emitted_visible_text = True\n                    yield event\n                    continue\n                if isinstance(event, dict) and event.get("kind") == "provider_usage":',
);
replaceExact(
  "llm_adapter.py",
  '                max_output_tokens=max_output_tokens,\n            )\n            return\n\n    # --- Groq',
  '                max_output_tokens=max_output_tokens,\n                sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "pollinations", POLLINATIONS_INTUITIVE_MODEL, streaming=True),\n            )\n            return\n\n    # --- Groq',
);
replaceExact(
  "llm_adapter.py",
  '                max_output_tokens=max_output_tokens,\n            ):\n                if chunk:\n                    emitted_primary_text = True',
  '                max_output_tokens=max_output_tokens,\n                sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "pollinations", resolved_override or model, streaming=True),\n            ):\n                if chunk:\n                    emitted_primary_text = True',
);
replaceExact(
  "llm_adapter.py",
  '                    max_output_tokens=max_output_tokens,\n                ):\n                    if chunk:\n                        emitted_alt_text = True',
  '                    max_output_tokens=max_output_tokens,\n                    sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "pollinations", alt_pollinations_model, streaming=True),\n                ):\n                    if chunk:\n                        emitted_alt_text = True',
);
replaceExact(
  "llm_adapter.py",
  '            max_output_tokens=max_output_tokens,\n        )\n        return\n\n\n# ==============================\n# Safety Model',
  '            max_output_tokens=max_output_tokens,\n            sentiq_tool_request=_sentiq_tool_request_for_route(sentiq_tool_request, "pollinations", pollinations_model, streaming=True),\n        )\n        return\n\n\n# ==============================\n# Safety Model',
);

// ---------------------------------------------------------------------------
// Native Nvidia OpenAI-compatible tool transport.
// ---------------------------------------------------------------------------
insertAfter(
  "backend/nvidia_nemotron.py",
  'def _extract_visible_content(value: object) -> str:\n    if isinstance(value, str):\n        return value\n    if not isinstance(value, list):\n        return ""\n    parts: list[str] = []\n    for item in value:\n        if isinstance(item, str):\n            parts.append(item)\n        elif isinstance(item, Mapping):\n            text = item.get("text")\n            if isinstance(text, str):\n                parts.append(text)\n    return "".join(parts)\n',
  `

def _serialize_sentiq_tools(request: Optional[Mapping[str, object]]) -> list[dict[str, object]]:
    serialized: list[dict[str, object]] = []
    if not isinstance(request, Mapping):
        return serialized
    for raw_tool in request.get("tools") or []:
        if not isinstance(raw_tool, Mapping):
            continue
        name = str(raw_tool.get("name") or "").strip()
        schema = raw_tool.get("input_schema")
        if not name or not isinstance(schema, Mapping):
            continue
        serialized.append({
            "type": "function",
            "function": {
                "name": name,
                "description": str(raw_tool.get("description") or "").strip(),
                "parameters": dict(schema),
            },
        })
    return serialized
`,
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        reasoning_budget: int,\n    ) -> dict[str, object]:\n        return {\n            "model": self.settings.model,\n            "messages": [{"role": "user", "content": prompt}],',
  '        reasoning_budget: int,\n        sentiq_tool_request: Optional[Mapping[str, object]] = None,\n    ) -> dict[str, object]:\n        messages: list[dict[str, object]] = []\n        policy = str((sentiq_tool_request or {}).get("tool_choice_policy") or "").strip()\n        if policy:\n            messages.append({"role": "system", "content": policy})\n        messages.append({"role": "user", "content": prompt})\n        payload: dict[str, object] = {\n            "model": self.settings.model,\n            "messages": messages,',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '            "reasoning_budget": max(0, int(reasoning_budget)),\n        }\n\n    def _open_response',
  '            "reasoning_budget": max(0, int(reasoning_budget)),\n        }\n        tools = _serialize_sentiq_tools(sentiq_tool_request)\n        if tools:\n            payload["tools"] = tools\n            payload["tool_choice"] = "auto"\n            payload["parallel_tool_calls"] = False\n        return payload\n\n    def _open_response',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        reasoning_budget: int,\n    ) -> object:\n',
  '        reasoning_budget: int,\n        sentiq_tool_request: Optional[Mapping[str, object]] = None,\n    ) -> object:\n',
  1,
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '                    reasoning_budget=reasoning_budget,\n                ),',
  '                    reasoning_budget=reasoning_budget,\n                    sentiq_tool_request=sentiq_tool_request,\n                ),',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        reasoning_budget: int,\n    ) -> Iterator[str]:',
  '        reasoning_budget: int,\n        sentiq_tool_request: Optional[Mapping[str, object]] = None,\n    ) -> Iterator[object]:',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '            reasoning_budget=reasoning_budget,\n        )\n        first_chunk_ms:',
  '            reasoning_budget=reasoning_budget,\n            sentiq_tool_request=sentiq_tool_request,\n        )\n        first_chunk_ms:',
);
insertAfter(
  "backend/nvidia_nemotron.py",
  '        reported_total_tokens: Optional[int] = None\n',
  '        tool_call_state: dict[int, dict[str, object]] = {}\n',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '                visible = _extract_visible_content(delta.get("content"))\n                if visible:\n                    visible_parts.append(visible)\n                    yield visible',
  '                raw_tool_calls = delta.get("tool_calls")\n                if isinstance(raw_tool_calls, list):\n                    for raw_call in raw_tool_calls:\n                        if not isinstance(raw_call, Mapping):\n                            continue\n                        index = int(raw_call.get("index") or 0)\n                        state = tool_call_state.setdefault(index, {"id": "", "name": "", "arguments": "", "started": False})\n                        call_id = str(raw_call.get("id") or "")\n                        function = raw_call.get("function") if isinstance(raw_call.get("function"), Mapping) else {}\n                        name_delta = str(function.get("name") or "")\n                        arguments_delta = str(function.get("arguments") or "")\n                        if call_id:\n                            state["id"] = call_id\n                        if name_delta:\n                            state["name"] = str(state.get("name") or "") + name_delta\n                        if arguments_delta:\n                            state["arguments"] = str(state.get("arguments") or "") + arguments_delta\n                        if sentiq_tool_request and not state.get("started") and state.get("name"):\n                            state["started"] = True\n                            yield {\n                                "kind": "tool_call_start",\n                                "id": str(state.get("id") or f"nvidia_call_{index}"),\n                                "name": str(state.get("name") or ""),\n                                "index": index,\n                            }\n                            buffered_arguments = str(state.get("arguments") or "")\n                            if buffered_arguments:\n                                yield {\n                                    "kind": "tool_argument_delta",\n                                    "id": str(state.get("id") or f"nvidia_call_{index}"),\n                                    "text": buffered_arguments,\n                                    "index": index,\n                                }\n                                state["arguments"] = ""\n                        elif sentiq_tool_request and state.get("started") and arguments_delta:\n                            yield {\n                                "kind": "tool_argument_delta",\n                                "id": str(state.get("id") or f"nvidia_call_{index}"),\n                                "text": arguments_delta,\n                                "index": index,\n                            }\n                            state["arguments"] = ""\n\n                visible = _extract_visible_content(delta.get("content"))\n                if visible:\n                    visible_parts.append(visible)\n                    yield {"kind": "text_delta", "text": visible} if sentiq_tool_request else visible',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        visible_text = "".join(visible_parts)\n        if not visible_text.strip():\n            raise NvidiaProviderError(\n                "Intuitive provider stream produced no visible answer.",\n                category="empty_stream",\n            )',
  '        visible_text = "".join(visible_parts)\n        if sentiq_tool_request:\n            if any(not state.get("started") for state in tool_call_state.values()):\n                raise NvidiaProviderError("Intuitive provider returned an incomplete tool call.", category="malformed")\n            if not visible_text.strip() and not tool_call_state:\n                raise NvidiaProviderError("Intuitive provider stream produced no answer or tool call.", category="empty_stream")\n            yield {"kind": "done", "finishReason": "tool_calls" if tool_call_state else "stop"}\n        elif not visible_text.strip():\n            raise NvidiaProviderError(\n                "Intuitive provider stream produced no visible answer.",\n                category="empty_stream",\n            )',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        estimated_output_floor = _estimate_tokens(visible_text) + hidden_reasoning_tokens',
  '        tool_argument_text = json.dumps(tool_call_state, separators=(",", ":"), sort_keys=True) if tool_call_state else ""\n        estimated_output_floor = _estimate_tokens(visible_text + tool_argument_text) + hidden_reasoning_tokens',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        reasoning_budget: int,\n    ) -> Iterator[object]:',
  '        reasoning_budget: int,\n        sentiq_tool_request: Optional[Mapping[str, object]] = None,\n    ) -> Iterator[object]:',
  1,
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '                    reasoning_budget=reasoning_budget,\n                )\n                while True:',
  '                    reasoning_budget=reasoning_budget,\n                    sentiq_tool_request=sentiq_tool_request,\n                )\n                while True:',
  1,
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        reasoning_budget: int,\n    ) -> tuple[str, NvidiaUsage, str]:\n        visible: list[str] = []',
  '        reasoning_budget: int,\n        sentiq_tool_request: Optional[Mapping[str, object]] = None,\n    ) -> tuple[object, NvidiaUsage, str]:\n        visible: list[str] = []\n        tool_calls: dict[int, dict[str, object]] = {}',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '            reasoning_budget=reasoning_budget,\n        ):\n            if isinstance(item, str):\n                visible.append(item)\n            elif isinstance(item, Mapping) and item.get("kind") == "provider_usage":',
  '            reasoning_budget=reasoning_budget,\n            sentiq_tool_request=sentiq_tool_request,\n        ):\n            if isinstance(item, str):\n                visible.append(item)\n            elif isinstance(item, Mapping) and item.get("kind") == "text_delta":\n                visible.append(str(item.get("text") or ""))\n            elif isinstance(item, Mapping) and item.get("kind") == "tool_call_start":\n                index = int(item.get("index") or 0)\n                tool_calls[index] = {\n                    "id": str(item.get("id") or f"nvidia_call_{index}"),\n                    "name": str(item.get("name") or ""),\n                    "arguments": "",\n                    "index": index,\n                }\n            elif isinstance(item, Mapping) and item.get("kind") == "tool_argument_delta":\n                index = int(item.get("index") or 0)\n                state = tool_calls.setdefault(index, {"id": str(item.get("id") or f"nvidia_call_{index}"), "name": "", "arguments": "", "index": index})\n                state["arguments"] = str(state.get("arguments") or "") + str(item.get("text") or "")\n            elif isinstance(item, Mapping) and item.get("kind") == "provider_usage":',
);
replaceExact(
  "backend/nvidia_nemotron.py",
  '        if usage is None:\n            raise NvidiaProviderError("Intuitive provider usage accounting was unavailable.")\n        return "".join(visible), usage, slot_id',
  '        if usage is None:\n            raise NvidiaProviderError("Intuitive provider usage accounting was unavailable.")\n        if tool_calls:\n            return {"kind": "tool_calls", "calls": [tool_calls[index] for index in sorted(tool_calls)]}, usage, slot_id\n        return "".join(visible), usage, slot_id',
);

// ---------------------------------------------------------------------------
// Tests and contracts.
// ---------------------------------------------------------------------------
replaceExact(
  "backend/testToolContract.ts",
  'assert.match(SENTIQ_TOOL_REGISTRY_VERSION, /^2026-07-pass5-v\\d+$/);',
  'assert.match(SENTIQ_TOOL_REGISTRY_VERSION, /^2026-08-paid-image-text-routing-v\\d+$/);',
);
replaceExact(
  "backend/testToolContract.ts",
  '{ id: "duplicate", name: "image_gen", arguments: { prompt: "two" } },',
  '{ id: "duplicate", name: "image_gen", arguments: { prompt: "two", requires_text_rendering: false } },',
);
replaceExact(
  "backend/testToolContract.ts",
  '{ id: "index_2", name: "image_gen", arguments: { prompt: "two" }, index: 0 },',
  '{ id: "index_2", name: "image_gen", arguments: { prompt: "two", requires_text_rendering: false }, index: 0 },',
);
replaceExact(
  "backend/testToolContract.ts",
  'calls: [{ id: "call_7", name: "image_gen", arguments: { prompt: "A calm lake" } }],',
  'calls: [{ id: "call_7", name: "image_gen", arguments: { prompt: "A calm lake", requires_text_rendering: false } }],',
);
insertAfter(
  "backend/testToolContract.ts",
  'assert.throws(() => validateModelToolCalls([\n  { id: "call_missing", name: "web_surf", arguments: {} },\n], authenticated), /Required/);\n',
  'assert.throws(() => validateModelToolCalls([\n  { id: "image_missing_text_decision", name: "image_gen", arguments: { prompt: "A lake" } },\n], authenticated), /Required/);\nassert.equal(validateModelToolCalls([\n  { id: "image_with_text", name: "image_gen", arguments: { prompt: "A poster reading Welcome", requires_text_rendering: true } },\n], authenticated)[0]?.arguments.requires_text_rendering, true);\n',
);

replaceExact(
  "backend/fixtures/modelToolCapabilityParity.json",
  '  { "alias": "pollinations:mistral", "provider": "pollinations", "model": "pollinations:mistral", "buffered": false, "streaming": false }',
  '  { "alias": "pollinations:mistral", "provider": "pollinations", "model": "pollinations:mistral", "buffered": true, "streaming": true },\n  { "alias": "nvidia:nemotron-3-ultra", "provider": "nvidia", "model": "nvidia/nemotron-3-ultra-550b-a55b", "buffered": true, "streaming": true }',
);

replaceExact(
  "backend/testModelToolProviderTransport.py",
  '        assert adapter.get_sentiq_tool_capability("pollinations", "openai-large")["supported"] is False',
  '        assert adapter.get_sentiq_tool_capability("pollinations", "openai-large")["supported"] is True',
);
replaceExact(
  "backend/testModelToolProviderTransport.py",
  '        assert adapter._sentiq_tool_request_for_route(TOOL_REQUEST, "pollinations", "openai-large") is None',
  '        assert adapter._sentiq_tool_request_for_route(TOOL_REQUEST, "pollinations", "openai-large") is TOOL_REQUEST',
);
replaceExact(
  "backend/testModelToolProviderTransport.py",
  '    ), patch.object(adapter, "GOOGLE_GENAI_MODULE", object()\n    ), patch.object(',
  '    ), patch.object(adapter, "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED", True), patch.object(adapter, "GOOGLE_GENAI_MODULE", object()\n    ), patch.object(',
  1,
);

// Existing image routing tests now assert the Boolean-driven paid policy.
replaceRegex(
  "backend/testImageRoutingSafety.ts",
  /getImageModelForPlan\("free", "[^"]*"\)/g,
  'getImageModelForPlan("free", false)',
  2,
);
replaceRegex(
  "backend/testImageRoutingSafety.ts",
  /getImageModelForPlan\("student_core", "[^"]*"\)/g,
  (match) => match.includes("poster") ? 'getImageModelForPlan("student_core", true)' : 'getImageModelForPlan("student_core", false)',
  2,
);
replaceRegex(
  "backend/testImageRoutingSafety.ts",
  /getImageModelForPlan\("premium", "[^"]*"\)/g,
  (match) => match.includes("poster") ? 'getImageModelForPlan("premium", true)' : 'getImageModelForPlan("premium", false)',
  2,
);
replaceRegex(
  "backend/testImageRoutingSafety.ts",
  /getImageModelForPlan\("pro", "[^"]*"\)/g,
  (match) => match.includes("poster") ? 'getImageModelForPlan("pro", true)' : 'getImageModelForPlan("pro", false)',
  2,
);
replaceExact(
  "backend/testImageRoutingSafety.ts",
  'function routeOrder(planCode: "free" | "student_core" | "premium" | "pro", prompt: string): readonly string[] {\n  const route = getImageModelForPlan(planCode, prompt);',
  'function routeOrder(planCode: "free" | "student_core" | "premium" | "pro", prompt: string, requiresTextRendering = false): readonly string[] {\n  const route = getImageModelForPlan(planCode, requiresTextRendering);',
);
replaceExact(
  "backend/testImageRoutingSafety.ts",
  '  assert.deepEqual(routeOrder("premium", "a detailed poster with text").slice(0, 2), ["zimage", "klein"]);',
  '  assert.deepEqual(routeOrder("premium", "a detailed poster with text", true).slice(0, 2), ["gpt-image-2", "kontext"]);',
);
replaceExact(
  "backend/testImageRoutingSafety.ts",
  '  assert.deepEqual(routeOrder("pro", "a puppy in snow").slice(0, 2), ["gpt-image-2", "kontext"]);',
  '  assert.deepEqual(routeOrder("pro", "a puppy in snow").slice(0, 2), ["zimage", "klein"]);',
);

write("backend/testPaidImageTextRouting.ts", `import assert from "node:assert/strict";
import { getImageModelForPlan } from "./billing/modelEntitlementRouter";
import { getImageProviderOrder } from "./tools/imageGeneration/imageRouter";
import { detectExplicitTextRenderingRequirement } from "./tools/imageGeneration/imageTextRenderingDecision";
import { getProviderToolDefinitions, validateModelToolCalls } from "./orchestrator/toolContract";

for (const plan of ["student_core", "premium", "pro"] as const) {
  const visual = getImageModelForPlan(plan, false);
  const text = getImageModelForPlan(plan, true);
  assert.equal(visual.model, "zimage", `${plan} non-text image route`);
  assert.equal(text.model, "gpt-image-2", `${plan} text-rendering image route`);
  assert.deepEqual(getImageProviderOrder("visual", visual.model).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(getImageProviderOrder("text", text.model).slice(0, 2), ["gpt-image-2", "kontext"]);
}
assert.equal(getImageModelForPlan("free", false).model, "dreamshaper");
assert.equal(getImageModelForPlan("free", true).model, "dreamshaper");

const imageTool = getProviderToolDefinitions({ authenticated: true })
  .find((tool) => tool.name === "image_gen");
assert(imageTool);
assert.deepEqual(imageTool.input_schema.required, ["prompt", "requires_text_rendering"]);
assert.equal((imageTool.input_schema.properties as any).requires_text_rendering.type, "boolean");

const call = validateModelToolCalls([{
  id: "paid_text_image",
  name: "image_gen",
  arguments: { prompt: "A poster reading Welcome", requires_text_rendering: true },
}], { authenticated: true });
assert.equal(call[0].arguments.requires_text_rendering, true);
assert.throws(() => validateModelToolCalls([{
  id: "missing_decision",
  name: "image_gen",
  arguments: { prompt: "A poster" },
}], { authenticated: true }), /Required/);

assert.equal(detectExplicitTextRenderingRequirement('A poster that says "Welcome"'), true);
assert.equal(detectExplicitTextRenderingRequirement("A calm lake at sunrise"), false);

console.log("Paid-plan image text-rendering policy checks passed.");
`);

write("backend/testExpandedModelToolProviders.py", `import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter
from backend.nvidia_nemotron import (
    NvidiaKeyPool,
    NvidiaKeyRecord,
    NvidiaNemotronProvider,
    NvidiaProviderSettings,
)

TOOL_REQUEST = {
    "registry_version": "2026-08-paid-image-text-routing-v1",
    "allowed_tool_fingerprint": "image-only",
    "tool_choice_policy": "Call image_gen for this explicit image request.",
    "allowed_tool_names": ["image_gen"],
    "availability_context": {"authenticated": True, "executionMode": "fast"},
    "tools": [{
        "name": "image_gen",
        "description": "Generate an image and classify text rendering.",
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "prompt": {"type": "string"},
                "requires_text_rendering": {"type": "boolean"},
            },
            "required": ["prompt", "requires_text_rendering"],
        },
    }],
}


def test_pollinations_buffered_tool_payload_and_response():
    payload = adapter._build_pollinations_payload(
        "Create a poster reading Welcome",
        "mistral",
        0.1,
        200,
        None,
        TOOL_REQUEST,
    )
    assert payload["tool_choice"] == "auto"
    assert payload["parallel_tool_calls"] is False
    assert payload["tools"][0]["function"]["name"] == "image_gen"
    assert payload["messages"][0]["role"] == "system"

    response = SimpleNamespace(
        json=lambda: {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": None,
                    "tool_calls": [{
                        "id": "poll_1",
                        "type": "function",
                        "function": {
                            "name": "image_gen",
                            "arguments": json.dumps({
                                "prompt": "Create a poster reading Welcome",
                                "requires_text_rendering": True,
                            }),
                        },
                    }],
                },
            }],
        },
        text="",
    )
    turn, finish = adapter._extract_pollinations_response(response, TOOL_REQUEST)
    assert finish == "tool_calls"
    assert turn["kind"] == "tool_calls"
    assert turn["calls"][0]["name"] == "image_gen"


def test_pollinations_stream_tool_fragments():
    first = adapter._parse_pollinations_sse_event("data: " + json.dumps({
        "choices": [{"delta": {"tool_calls": [{
            "index": 0,
            "id": "poll_stream_1",
            "function": {"name": "image_gen", "arguments": '{"prompt":"poster",'},
        }]}}],
    }))
    second = adapter._parse_pollinations_sse_event("data: " + json.dumps({
        "choices": [{"finish_reason": "tool_calls", "delta": {"tool_calls": [{
            "index": 0,
            "function": {"arguments": '"requires_text_rendering":true}'},
        }]}}],
    }))
    assert first["tool_calls"][0]["function"]["name"] == "image_gen"
    assert second["finish_reason"] == "tool_calls"


class FakeResponse:
    status_code = 200
    headers = {}

    def __init__(self, events):
        self.events = events

    def iter_lines(self, decode_unicode=True):
        for event in self.events:
            yield "data: " + json.dumps(event)
        yield "data: [DONE]"

    def close(self):
        pass


def test_nvidia_native_tool_transport():
    events = [
        {"choices": [{"delta": {"tool_calls": [{
            "index": 0,
            "id": "nvidia_1",
            "function": {"name": "image_gen", "arguments": '{"prompt":"poster",'},
        }]}}]},
        {"choices": [{"finish_reason": "tool_calls", "delta": {"tool_calls": [{
            "index": 0,
            "function": {"arguments": '"requires_text_rendering":true}'},
        }]}}]},
        {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}},
    ]
    requests = []

    def fake_request(*args, **kwargs):
        requests.append(kwargs)
        return FakeResponse(events)

    provider = NvidiaNemotronProvider(
        NvidiaProviderSettings(enabled=True),
        NvidiaKeyPool([NvidiaKeyRecord(index=1, env_name="NVIDIA_API_KEY_1", key="secret")]),
        request=fake_request,
    )
    turn, usage, slot = provider.complete(
        "Create a poster",
        max_tokens=200,
        reasoning_budget=0,
        sentiq_tool_request=TOOL_REQUEST,
    )
    assert turn["kind"] == "tool_calls"
    assert turn["calls"][0]["name"] == "image_gen"
    assert json.loads(turn["calls"][0]["arguments"])["requires_text_rendering"] is True
    assert usage.total_tokens >= 18
    assert slot == "nvidia-slot-1"
    assert requests[0]["json"]["tool_choice"] == "auto"
    assert requests[0]["json"]["tools"][0]["function"]["name"] == "image_gen"


if __name__ == "__main__":
    with patch.object(adapter, "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED", True), patch.object(
        adapter, "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED", True
    ), patch.dict("os.environ", {
        "SENTIQ_NVIDIA_PROVIDER_ENABLED": "true",
        "SENTIQ_NEMOTRON_INTUITIVE_ENABLED": "true",
    }):
        assert adapter.get_sentiq_tool_capability("pollinations", "mistral", True)["supported"] is True
        assert adapter.get_sentiq_tool_capability("nvidia", adapter.NVIDIA_NEMOTRON_MODEL, True)["supported"] is True
    test_pollinations_buffered_tool_payload_and_response()
    test_pollinations_stream_tool_fragments()
    test_nvidia_native_tool_transport()
    print("Expanded Pollinations and Nvidia tool transport checks passed.")
`);

// Documentation reflects model-decided routing and unchanged quota differences.
replaceExact(
  "docs/BILLING_AND_PRICING.md",
  '- Free: `dreamshaper` primary, then `flux`.\n- Student Core: `zimage` primary, then `klein`.\n- Premium: `zimage` primary, then `klein`.\n- Pro: `gpt-image-2` primary, then `kontext`.\n\nThe plan decides the primary image model. Prompt wording does not silently upgrade or downgrade it.',
  '- Free: `dreamshaper` primary, then `flux`.\n- Essential, Plus, and Pro without required readable text: `zimage` primary, then `klein`.\n- Essential, Plus, and Pro with required readable text: `gpt-image-2` primary, then `kontext`.\n\nFor paid plans, the validated `image_gen.requires_text_rendering` decision is made by the active texting model. Paid plans differ by image quota only, not model access. Free ignores this decision and retains its existing route.',
);

// Contract assertions ensure the patch did not leave legacy prompt-based routing.
for (const path of [
  "backend/billing/modelEntitlementRouter.ts",
  "backend/orchestrator/toolExecutor.ts",
  "backend/server.ts",
]) {
  const source = read(path);
  if (/getImageModelForPlan\([^,]+,\s*(?:input|providerPrompt|prompt)\)/.test(source)) {
    throw new Error(`${path}: prompt text still controls paid image entitlement routing`);
  }
}
for (const path of ["backend/orchestrator/toolContract.ts", "backend/ai/modelToolExecution.ts"]) {
  if (!read(path).includes("requires_text_rendering")) {
    throw new Error(`${path}: required text-rendering decision is missing`);
  }
}

console.log("Applied paid-plan image text-rendering and expanded tool transport Pass 2.");
