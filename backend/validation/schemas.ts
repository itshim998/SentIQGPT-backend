import { z } from "zod";

// SentIQGPT v1 — Input Validation Schemas (Zod)
//
// Validates all incoming API payloads before they reach handlers.

// --- Chat ---

export const ChatRequestSchema = z.object({
  message: z.string().min(1, "Message is required").max(10000, "Message too long"),
  conversationId: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(120).optional(),
  client_request_id: z.string().min(1).max(120).optional(),
  clarification_response: z.object({
    clarification_id: z.string().min(1).max(120).optional(),
    original_message: z.string().min(1).max(10000).optional(),
    question: z.string().min(1).max(500).optional(),
    options: z.array(z.object({
      id: z.string().min(1).max(120),
      label: z.string().min(1).max(120),
      description: z.string().max(240).optional(),
    })).max(4).optional(),
    answers: z.array(z.string().min(1).max(1000)).max(2).optional(),
    source: z.enum(["option", "custom"]).optional(),
    selected_option_id: z.string().min(1).max(120).optional(),
  }).optional(),
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
    image_attachments: z.array(z.object({
      filename: z.string().min(1).max(255),
      mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
      base64: z.string().min(1).max(14_000_000),
      size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
    })).max(3).optional(),
    web_search_mode: z.enum(["basic", "advanced"]).optional(),
  }).optional(),
}).transform(({ conversation_id, client_request_id, ...rest }) => ({
  ...rest,
  conversationId: rest.conversationId ?? conversation_id,
  clientRequestId: rest.clientRequestId ?? client_request_id,
}));

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
  conversationId: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(120).optional(),
  client_request_id: z.string().min(1).max(120).optional(),
}).transform(({ conversation_id, client_request_id, ...rest }) => ({
  ...rest,
  conversationId: rest.conversationId ?? conversation_id,
  clientRequestId: rest.clientRequestId ?? client_request_id,
}));

// --- Chart Generation ---

export const ChartGenerateRequestSchema = z.object({
  message: z.string().min(1, "Message is required").max(2000, "Message too long"),
  fetch_preview: z.boolean().optional(),
});

export const GeneratedFileUpdateRequestSchema = z.object({
  html: z.string().min(1, "HTML is required").max(1_000_000, "HTML too large"),
  version: z.number().int().min(1).optional(),
});

// --- Chat Selection (Ask SentIQGPT text selection tool) ---

export const SelectionContextSchema = z.object({
  selected_text: z
    .string()
    .min(1, "Selected text is required")
    .max(2000, "Selected text too long"),
  context_before: z.string().max(1000).optional(),
  context_after: z.string().max(1000).optional(),
  conversationId: z.string().min(1).optional(),
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
  }).optional(),
}).transform(({ conversation_id, ...rest }) => ({
  ...rest,
  conversationId: rest.conversationId ?? conversation_id,
}));

export type SelectionContextPayload = z.infer<typeof SelectionContextSchema>;

export const ProfileUpdateRequestSchema = z.object({
  display_name: z.string({
    required_error: "display_name is required",
    invalid_type_error: "display_name must be a string",
  }),
});

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
