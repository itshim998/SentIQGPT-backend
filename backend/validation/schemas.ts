import { z } from "zod";

// SentIQGPT v1 — Input Validation Schemas (Zod)
//
// Validates all incoming API payloads before they reach handlers.

// --- Chat ---

export const ChatRequestSchema = z.object({
  message: z.string().min(1, "Message is required").max(10000, "Message too long"),
  conversation_id: z.string().min(1).optional(),
  context: z.object({
    recent_messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })).max(50).optional(),
    memories: z.array(z.object({
      type: z.string(),
      summary: z.string(),
    })).max(100).optional(),
    file_references: z.array(z.object({
      filename: z.string(),
      extractedText: z.string(),
    })).max(10).optional(),
  }).optional(),
});

// --- Memory ---

export const MemoryClassifyRequestSchema = z.object({
  message: z.string().min(1).max(10000),
  recent_messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).max(20).optional(),
});

export const MemoryCompressRequestSchema = z.object({
  memories: z.array(z.object({
    id: z.string(),
    type: z.string(),
    summary: z.string(),
    importance: z.number().min(1).max(10),
    timestamp: z.string(),
  })).min(2, "Need at least 2 memories to compress"),
});

// --- File Upload ---

export const FileExtractRequestSchema = z.object({
  file_id: z.string().min(1),
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
});

// --- Image Generation ---

export const ImageGenerateRequestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(2000, "Prompt too long"),
  style: z.string().max(100).optional(),
  size: z.enum(["256x256", "512x512", "1024x1024"]).optional(),
});

// --- Prompt injection detection ---

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a\s+)?different/i,
  /disregard\s+(all\s+)?prior/i,
  /override\s+system\s+prompt/i,
  /pretend\s+you\s+are/i,
  /\bDAN\b.*\bmode\b/i,
  /jailbreak/i,
  /forget\s+(all\s+)?(your|previous)\s+(instructions|rules)/i,
  /act\s+as\s+if\s+you\s+(have\s+)?no\s+(restrictions|rules)/i,
  /reveal\s+(your|the)\s+(system|internal)\s+(prompt|instructions)/i,
  /bypass\s+(safety|content)\s+(filter|policy)/i,
  /do\s+anything\s+now/i,
  /new\s+instructions?\s*:/i,
  /\[system\]/i,
  /\bsystem\s*:\s*you\s+are\b/i,
];

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
