import {
  buildMemoryClassifyPrompt,
  buildMemorySummarizePrompt,
  buildMemoryCompressPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  strictParseJsonObject,
} from "./PromptBuilders";
import { generateEmbedding } from "../memory/memoryEmbedding";

// SentIQGPT v1 — Memory Processor
//
// Orchestrates the Groq-powered memory pipeline:
// 1. CLASSIFY: Should this message be stored as memory?
// 2. SUMMARIZE: Extract a concise memory from the message.
// 3. COMPRESS: Merge old memories into condensed entries.

export interface MemoryClassification {
  readonly should_store: boolean;
  readonly type: "identity" | "preference" | "project" | "knowledge" | null;
  readonly reason: string;
}

export interface MemorySummary {
  readonly summary: string;
  readonly importance: number;
}

export interface MemoryCompression {
  readonly compressed_summary: string;
  readonly importance: number;
}

// ==============================
// Step 1: Classify
// ==============================

export async function classifyMemory(args: {
  readonly message: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
}): Promise<MemoryClassification> {
  const call = buildMemoryClassifyPrompt(args);

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("memory_classify");
  }

  try {
    const parsed = strictParseJsonObject(raw);
    const result: MemoryClassification = {
      should_store: parsed.should_store === true,
      type: typeof parsed.type === "string" ? parsed.type as MemoryClassification["type"] : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
    };
    console.log(`[MEMORY] classification: store=${result.should_store}, type=${result.type}, reason=${result.reason}`);
    return result;
  } catch {
    console.log(`[MEMORY] classification parse failed, defaulting to should_store=false`);
    return { should_store: false, type: null, reason: "parse_error" };
  }
}

// ==============================
// Step 2: Summarize
// ==============================

export async function summarizeMemory(args: {
  readonly message: string;
  readonly memoryType: string;
  readonly existingMemories?: readonly { summary: string }[];
}): Promise<MemorySummary> {
  const call = buildMemorySummarizePrompt(args);

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("memory_summarize");
  }

  try {
    const parsed = strictParseJsonObject(raw);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      importance: typeof parsed.importance === "number" ? Math.min(10, Math.max(1, parsed.importance)) : 5,
    };
  } catch {
    return { summary: "", importance: 1 };
  }
}

// ==============================
// Step 3: Compress
// ==============================

export async function compressMemories(args: {
  readonly memories: readonly { summary: string; importance: number; timestamp: string }[];
}): Promise<MemoryCompression> {
  if (args.memories.length < 2) {
    throw new Error("Need at least 2 memories to compress.");
  }

  const call = buildMemoryCompressPrompt(args);

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("memory_compress");
  }

  try {
    const parsed = strictParseJsonObject(raw);
    return {
      compressed_summary: typeof parsed.compressed_summary === "string" ? parsed.compressed_summary : "",
      importance: typeof parsed.importance === "number" ? Math.min(10, Math.max(1, parsed.importance)) : 5,
    };
  } catch {
    return { compressed_summary: "", importance: 1 };
  }
}

// ==============================
// Full pipeline: Classify → Summarize
// ==============================

export async function processMessageForMemory(args: {
  readonly message: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
  readonly existingMemories?: readonly { type: string; summary: string }[];
  readonly forceStore?: boolean;
}): Promise<{
  readonly stored: boolean;
  readonly memory?: {
    type: string;
    summary: string;
    importance: number;
    embedding?: readonly number[];
  };
}> {
  // Step 1: Classify
  const classification = await classifyMemory({
    message: args.message,
    recentMessages: args.recentMessages,
  });

  // Skip "knowledge" type — it causes unnecessary storage overhead.
  // Only store meaningful long-term memory: identity, preference, project.
  if (classification.type === "knowledge") {
    console.log(`[MEMORY] skipping knowledge storage (overhead reduction)`);
    return { stored: false };
  }

  const shouldStore = args.forceStore || (classification.should_store && !!classification.type);
  const memType = classification.type || "project";

  if (!shouldStore) {
    return { stored: false };
  }

  // Step 2: Summarize
  const typeMemories = (args.existingMemories ?? [])
    .filter((m) => m.type === memType)
    .map((m) => ({ summary: m.summary }));

  const summary = await summarizeMemory({
    message: args.message,
    memoryType: memType,
    existingMemories: typeMemories,
  });

  console.log(`[MEMORY] summary generated: "${summary.summary.slice(0, 80)}" (importance: ${summary.importance})`);

  if (!summary.summary) {
    console.log(`[MEMORY] empty summary, not storing`);
    return { stored: false };
  }

  // Step 3: Generate embedding for semantic retrieval
  const embedding = await generateEmbedding(summary.summary);
  if (embedding) {
    console.log(`[MEMORY] embedding generated (${embedding.length} dims)`);
  } else {
    console.log(`[MEMORY] embedding skipped (service unavailable)`);
  }

  console.log(`[MEMORY] stored successfully: type=${memType}`);
  return {
    stored: true,
    memory: {
      type: memType,
      summary: summary.summary,
      importance: summary.importance,
      embedding,
    },
  };
}
