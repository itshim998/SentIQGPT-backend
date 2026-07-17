import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExecutionMode } from "./executionProfile";

export const SENTIQ_TOOL_REGISTRY_VERSION = "2026-07-pass5-v2";
export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_TOOL_CALLS_PER_TURN = 4;

export const SENTIQ_TOOL_CHOICE_POLICY = [
  "The available SentIQ tools are real executable capabilities.",
  "Call exactly one appropriate tool when the user explicitly requests an available capability or satisfying the request genuinely requires it.",
  "An explicit request for a downloadable file must call file_gen; do not answer with the requested file contents only as chat text.",
  "An explicit request to remember durable identity, preference, or project information must call memory_update; do not merely say it was remembered.",
  "An explicit request to generate a new image must call image_gen.",
  "An explicit request to create a chart must call chart_gen, and a request for current or externally verified web information must call web_surf.",
  "Do not deny these capabilities or say that you cannot create files, save memories, generate images, create charts, search the web, or use tools when the corresponding tool is available.",
  "Never claim that you searched, generated, created, or saved something unless you return the corresponding tool call; only a successful tool result confirms completion.",
  "Answer normally when no SentIQ tool is genuinely required, including ordinary questions that merely discuss files, memory, images, charts, web search, or how those features work.",
  "Do not call a tool merely because a keyword appears or because the user asks for ordinary text that does not require an executable capability.",
  "Use the original user request as the tool argument when it is already suitable.",
  "Refine an argument only as needed for execution, preserving every material user constraint.",
  "Do not invent material facts, entities, dates, identities, scope, or requirements.",
  "If material ambiguity prevents safe execution, ask a concise conversational clarification instead of calling a tool.",
].join(" ");

export type SentIQToolName =
  | "web_surf"
  | "image_gen"
  | "chart_gen"
  | "file_gen"
  | "memory_update";

export type ToolAuthorization = "guest" | "authenticated" | "entitled";
export type ToolHandoff = "assistant_continue" | "terminal_structured";
export type ToolSideEffect = "none" | "idempotent" | "stateful";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolAvailabilityContext {
  readonly authenticated: boolean;
  readonly executionMode?: ExecutionMode;
  readonly entitlements?: Readonly<Partial<Record<SentIQToolName, boolean>>>;
}

export interface ToolDefinition<Name extends SentIQToolName = SentIQToolName> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly resultSchema: JsonSchema;
  readonly authorization: ToolAuthorization;
  readonly handoff: ToolHandoff;
  readonly sideEffect: ToolSideEffect;
  readonly isAvailable: (context: ToolAvailabilityContext) => boolean;
  readonly validateInput: (input: unknown) => Record<string, unknown>;
}

export interface ProviderToolDefinition {
  readonly name: SentIQToolName;
  readonly description: string;
  readonly input_schema: JsonSchema;
}

export interface RawModelToolCall {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly index?: unknown;
}

export interface ValidatedToolCall {
  readonly id: string;
  readonly name: SentIQToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly index: number;
}

export type ToolLifecycleEvent = Readonly<{
  type: "tool_selected" | "tool_started" | "tool_result" | "tool_error";
  tool: SentIQToolName;
  call_id: string;
  code?: string;
}>;

export type AssistantTurn =
  | { readonly kind: "assistant_text"; readonly text: string }
  | { readonly kind: "tool_calls"; readonly calls: readonly ValidatedToolCall[] };

export type ProviderDelta =
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "tool_call_start"; readonly id: string; readonly name: SentIQToolName; readonly index: number }
  | { readonly kind: "tool_argument_delta"; readonly id: string; readonly text: string; readonly index: number }
  | { readonly kind: "tool_calls_complete"; readonly calls: readonly ValidatedToolCall[] }
  | { readonly kind: "done"; readonly finishReason?: string };

const boundedText = z.string().trim().min(1).max(12_000);
const fileFormat = z.enum(["html", "txt", "xlsx", "pptx", "docx", "pdf"]);

const schemas = {
  web_surf: z.object({ query: boundedText }).strict(),
  image_gen: z.object({ prompt: boundedText }).strict(),
  chart_gen: z.object({ request: boundedText }).strict(),
  file_gen: z.object({ request: boundedText, format: fileFormat.optional() }).strict(),
  memory_update: z.object({
    content: boundedText,
    type: z.enum(["identity", "preference", "project"]).optional(),
    scope: z.enum(["global", "chat"]).optional(),
  }).strict(),
} as const;

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[],
): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const stringProperty = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({
  type: "string",
  minLength: 1,
  maxLength: 12_000,
  description,
  ...extra,
});

function authenticated(context: ToolAvailabilityContext): boolean {
  return context.authenticated;
}

function guestOrAuthenticated(context: ToolAvailabilityContext): boolean {
  return context.entitlements?.image_gen !== false;
}

function definition<Name extends SentIQToolName>(args: Omit<ToolDefinition<Name>, "validateInput">): ToolDefinition<Name> {
  return {
    ...args,
    validateInput(input: unknown): Record<string, unknown> {
      return schemas[args.name].parse(input) as Record<string, unknown>;
    },
  };
}

export const SENTIQ_TOOL_REGISTRY: readonly ToolDefinition[] = [
  definition({
    name: "web_surf",
    description: "Search live web sources when current or externally verified information is genuinely required.",
    inputSchema: objectSchema({ query: stringProperty("The user's web research request.") }, ["query"]),
    resultSchema: objectSchema({ evidence: { type: "object" } }, ["evidence"]),
    authorization: "guest",
    handoff: "assistant_continue",
    sideEffect: "none",
    isAvailable: () => true,
  }),
  definition({
    name: "image_gen",
    description: "Generate a new image or visual asset. Use this for explicit image-generation requests instead of describing an image in chat text.",
    inputSchema: objectSchema({ prompt: stringProperty("The image the user wants generated.") }, ["prompt"]),
    resultSchema: objectSchema({ image: { type: "object" } }, ["image"]),
    authorization: "entitled",
    handoff: "terminal_structured",
    sideEffect: "idempotent",
    isAvailable: guestOrAuthenticated,
  }),
  definition({
    name: "chart_gen",
    description: "Create a chart or data visualization explicitly requested by the user.",
    inputSchema: objectSchema({ request: stringProperty("The requested chart, including supplied data and constraints.") }, ["request"]),
    resultSchema: objectSchema({ chart: { type: "object" } }, ["chart"]),
    authorization: "authenticated",
    handoff: "terminal_structured",
    sideEffect: "idempotent",
    isAvailable: authenticated,
  }),
  definition({
    name: "file_gen",
    description: "Create and return a downloadable file, such as a PDF, TXT, DOCX, PPTX, XLSX, or HTML file. Use this whenever the user explicitly asks for a downloadable file instead of returning only chat text.",
    inputSchema: objectSchema({
      request: stringProperty("The requested file and its material content constraints."),
      format: stringProperty("Optional supported output format.", { enum: fileFormat.options }),
    }, ["request"]),
    resultSchema: objectSchema({ file: { type: "object" } }, ["file"]),
    authorization: "authenticated",
    handoff: "terminal_structured",
    sideEffect: "idempotent",
    isAvailable: authenticated,
  }),
  definition({
    name: "memory_update",
    description: "Persist durable identity, preference, or project information when the user explicitly asks SentIQ to remember or save it. The server controls authorization, scope, and persistence.",
    inputSchema: objectSchema({
      content: stringProperty("The durable fact the user explicitly asked SentIQ to remember. Preserve the user's requested meaning."),
      type: stringProperty("Optional memory category when it is clear from the request. The server infers it when omitted.", { enum: ["identity", "preference", "project"] }),
      scope: stringProperty("Optional requested scope. Use chat only when the user limits the memory to this chat; otherwise the server defaults to global.", { enum: ["global", "chat"] }),
    }, ["content"]),
    resultSchema: objectSchema({ memory: { type: "object" } }, ["memory"]),
    authorization: "authenticated",
    handoff: "terminal_structured",
    sideEffect: "stateful",
    isAvailable: authenticated,
  }),
] as const;

const REGISTRY_BY_NAME = new Map<SentIQToolName, ToolDefinition>(
  SENTIQ_TOOL_REGISTRY.map((tool) => [tool.name, tool]),
);

export function isSentIQToolName(value: string): value is SentIQToolName {
  return REGISTRY_BY_NAME.has(value as SentIQToolName);
}

export function getToolDefinition(name: SentIQToolName): ToolDefinition {
  const tool = REGISTRY_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown SentIQ tool: ${name}`);
  return tool;
}

export function getAvailableToolDefinitions(context: ToolAvailabilityContext): readonly ToolDefinition[] {
  return SENTIQ_TOOL_REGISTRY.filter((tool) => (
    tool.isAvailable(context) && context.entitlements?.[tool.name] !== false
  ));
}

export function getProviderToolDefinitions(context: ToolAvailabilityContext): readonly ProviderToolDefinition[] {
  return getAvailableToolDefinitions(context).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function getAllowedToolFingerprint(tools: readonly ProviderToolDefinition[]): string {
  const canonical = tools
    .map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
    throw new Error("Tool arguments exceed the allowed size.");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
}

export function validateModelToolCalls(
  rawCalls: readonly RawModelToolCall[],
  context: ToolAvailabilityContext,
  allowedTools: readonly SentIQToolName[] = getAvailableToolDefinitions(context).map((tool) => tool.name),
): readonly ValidatedToolCall[] {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) throw new Error("At least one tool call is required.");
  if (rawCalls.length > MAX_TOOL_CALLS_PER_TURN) throw new Error("Too many tool calls were returned.");

  const allowed = new Set<SentIQToolName>(allowedTools);
  const ids = new Set<string>();
  const indexes = new Set<number>();
  return rawCalls.map((raw, position) => {
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Tool call ID is malformed.");
    if (ids.has(id)) throw new Error("Duplicate tool call ID.");
    ids.add(id);

    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!isSentIQToolName(name)) throw new Error(`Unknown SentIQ tool: ${name || "(missing)"}`);
    if (!allowed.has(name)) throw new Error(`SentIQ tool is unavailable: ${name}`);
    const tool = getToolDefinition(name);
    if (!tool.isAvailable(context) || context.entitlements?.[name] === false) {
      throw new Error(`SentIQ tool is unavailable: ${name}`);
    }

    const serialized = typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? null);
    if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
      throw new Error("Tool arguments exceed the allowed size.");
    }
    const argumentsValue = tool.validateInput(parseArguments(raw.arguments));
    const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0
      ? raw.index
      : position;
    if (indexes.has(index)) throw new Error("Duplicate tool call index.");
    indexes.add(index);
    return { id, name, arguments: argumentsValue, index };
  });
}

export function validateSingleAutomaticToolCall(
  calls: readonly ValidatedToolCall[],
  context: ToolAvailabilityContext,
  allowedTools: readonly SentIQToolName[],
): ValidatedToolCall {
  if (calls.length !== 1) {
    throw new Error("Automatic SentIQ execution permits exactly one tool call per turn.");
  }
  return validateModelToolCalls(calls, context, allowedTools)[0];
}

export function normalizeAssistantTurn(
  raw: unknown,
  context: ToolAvailabilityContext,
  allowedTools?: readonly SentIQToolName[],
): AssistantTurn {
  if (!raw || typeof raw !== "object") throw new Error("Assistant turn is malformed.");
  const candidate = raw as { kind?: unknown; text?: unknown; calls?: unknown };
  if (candidate.kind === "assistant_text") {
    return { kind: "assistant_text", text: typeof candidate.text === "string" ? candidate.text : "" };
  }
  if (candidate.kind === "tool_calls" && Array.isArray(candidate.calls)) {
    return { kind: "tool_calls", calls: validateModelToolCalls(candidate.calls, context, allowedTools) };
  }
  throw new Error("Assistant turn kind is unsupported.");
}
