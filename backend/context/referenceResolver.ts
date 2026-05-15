export type ReferenceResolverTool =
  | "conversation"
  | "image_generation"
  | "file_analysis"
  | "chart_generation"
  | "file_generation"
  | "web_search";

export type ReferenceResolverMemory = {
  readonly type: string;
  readonly summary: string;
  readonly importance?: number;
  readonly scope?: "global" | "chat";
  readonly chat_id?: string | null;
};

export type ReferenceResolverMessage = {
  readonly role: string;
  readonly content: string;
};

export type ReferenceResolution = {
  readonly original: string;
  readonly resolved: string;
  readonly changed: boolean;
  readonly subject?: string;
  readonly confidence: number;
  readonly source?: "conversation" | "summary" | "chat_memory";
  readonly needsClarification: boolean;
  readonly candidates: readonly string[];
};

type Candidate = {
  readonly text: string;
  readonly score: number;
  readonly source: "conversation" | "summary" | "chat_memory";
};

const MAX_CANDIDATES = 6;

const REFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:it|its|they|them|their|that|this)\b/i,
  /\b(?:same\s+one|same\s+thing|like\s+before|as\s+before|previous\s+one)\b/i,
];

const IMAGE_NOUNS = "(?:image|picture|photo|illustration|artwork|portrait|render)";

const STOP_PHRASES: readonly RegExp[] = [
  /^\s*(?:hi|hello|hey)\b/i,
  /^\s*(?:can|could|would)\s+you\s+(?:please\s+)?(?:tell|explain|describe|show|give|generate|create|make|draw|search|find|look\s+up|fix|debug|analy[sz]e)\b/i,
  /^\s*(?:please\s+)?(?:tell|explain|describe|show|give|generate|create|make|draw|search|find|look\s+up|fix|debug|analy[sz]e)\b/i,
  /^\s*(?:i\s+am|i'm|you(?:'re| are)|we(?:'re| are))\s+/i,
  /\b(?:please|thanks|thank you)\b/gi,
];

const LOW_SIGNAL_TERMS = new Set([
  "anything",
  "details",
  "help",
  "image",
  "information",
  "one",
  "picture",
  "photo",
  "something",
  "that",
  "thing",
  "this",
]);

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeSpace(value.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, " "));
}

function hasContextReference(input: string): boolean {
  return REFERENCE_PATTERNS.some((pattern) => pattern.test(input));
}

function stripCommandNoise(value: string): string {
  let text = value
    .replace(/^generate\s+image\s*:\s*/i, " ")
    .replace(/^selected\s+text\s*:\s*/i, " ");
  for (const phrase of STOP_PHRASES) {
    text = text.replace(phrase, " ");
  }
  return normalizeSpace(text.replace(/^[:\-–—]+/, " "));
}

function trimCandidate(raw: string): string {
  let text = stripCommandNoise(raw)
    .replace(/\b(?:earlier|before|currently|specific|different|perhaps)\b.*$/i, " ")
    .replace(/\b(?:would|could|should|can|will|is|are|was|were)\b.*$/i, " ")
    .replace(/[.?!;:,]+$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "");

  text = normalizeSpace(text);
  const words = text.split(" ").filter(Boolean);
  if (words.length > 8) {
    text = words.slice(0, 8).join(" ");
  }
  return normalizeSpace(text);
}

function isUsefulCandidate(value: string, currentInputKey: string): boolean {
  const key = normalizeKey(value);
  if (!key || key === currentInputKey) return false;
  if (key.length < 3) return false;
  if (LOW_SIGNAL_TERMS.has(key)) return false;
  if (/^(?:it|its|they|them|their|that|this|same one|same thing)$/i.test(key)) return false;
  return true;
}

function addCandidate(
  candidates: Candidate[],
  seen: Set<string>,
  raw: string,
  score: number,
  source: Candidate["source"],
  currentInputKey: string,
): void {
  const text = trimCandidate(raw);
  if (!isUsefulCandidate(text, currentInputKey)) return;
  const key = normalizeKey(text);
  const existingIndex = candidates.findIndex((candidate) => normalizeKey(candidate.text) === key);
  if (existingIndex >= 0) {
    const existing = candidates[existingIndex];
    candidates[existingIndex] = { ...existing, score: Math.max(existing.score, score) };
    return;
  }
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ text, score, source });
}

function extractSubjectsFromText(
  text: string,
  score: number,
  source: Candidate["source"],
  currentInputKey: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const cleaned = normalizeSpace(text);
  if (!cleaned) return candidates;

  const patterns: readonly RegExp[] = [
    /\b(?:about|regarding|on|into|interested in|talking about|discussing|focused on)\s+([^.!?\n]{3,90})/gi,
    /\b(?:called|named|known as)\s+([^.!?\n]{3,70})/gi,
    /\b(?:the subject is|current topic is|topic is)\s+([^.!?\n]{3,90})/gi,
    /\b(?:a|an|the)\s+([A-Z][\p{L}\p{N}-]*(?:\s+[A-Z]?[a-z][\p{L}\p{N}-]*){0,4})\b/gu,
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      addCandidate(candidates, seen, match[1] || "", score, source, currentInputKey);
    }
  }

  if (candidates.length === 0 && cleaned.length <= 80 && !hasContextReference(cleaned)) {
    addCandidate(candidates, seen, cleaned, score - 0.5, source, currentInputKey);
  }

  return candidates;
}

function collectConversationCandidates(args: {
  readonly recentMessages?: readonly ReferenceResolverMessage[];
  readonly currentInput: string;
}): Candidate[] {
  const currentInputKey = normalizeKey(args.currentInput);
  const messages = args.recentMessages ?? [];
  const collected: Candidate[] = [];
  const seen = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const content = normalizeSpace(message.content || "");
    const contentKey = normalizeKey(content);
    if (!content || contentKey === currentInputKey) continue;
    if (contentKey === normalizeKey(`Generate image: ${args.currentInput}`)) continue;

    const recency = messages.length - index;
    const roleBoost = message.role === "user" ? 2 : 1;
    const score = Math.max(1, 14 - recency) + roleBoost;
    const extracted = extractSubjectsFromText(content, score, "conversation", currentInputKey);
    for (const candidate of extracted) {
      addCandidate(collected, seen, candidate.text, candidate.score, candidate.source, currentInputKey);
    }
  }

  return collected;
}

function collectSummaryCandidates(summary: string | undefined, currentInput: string): Candidate[] {
  if (!summary) return [];
  return extractSubjectsFromText(summary, 3, "summary", normalizeKey(currentInput));
}

function collectChatMemoryCandidates(
  memories: readonly ReferenceResolverMemory[] | undefined,
  currentInput: string,
): Candidate[] {
  const currentInputKey = normalizeKey(currentInput);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const memory of memories ?? []) {
    if (memory.scope !== "chat") continue;
    if (!["project", "preference", "identity"].includes(memory.type)) continue;
    const score = 2 + Math.min(3, Math.max(0, (memory.importance ?? 5) - 5));
    const extracted = extractSubjectsFromText(memory.summary, score, "chat_memory", currentInputKey);
    for (const candidate of extracted) {
      addCandidate(candidates, seen, candidate.text, candidate.score, candidate.source, currentInputKey);
    }
  }
  return candidates;
}

function selectCandidate(candidates: readonly Candidate[]): {
  readonly selected?: Candidate;
  readonly ambiguous: boolean;
  readonly visibleCandidates: readonly string[];
} {
  const sorted = [...candidates]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CANDIDATES);
  const selected = sorted[0];
  if (!selected) {
    return { ambiguous: false, visibleCandidates: [] };
  }
  const competing = sorted.find((candidate) =>
    normalizeKey(candidate.text) !== normalizeKey(selected.text) &&
    candidate.source === selected.source &&
    Math.abs(candidate.score - selected.score) <= 1,
  );
  return {
    selected,
    ambiguous: Boolean(competing),
    visibleCandidates: sorted.map((candidate) => candidate.text),
  };
}

function rewriteImagePrompt(input: string, subject: string): string {
  let output = input.trim();

  output = output.replace(
    new RegExp(`\\b(?:their|its)\\s+${IMAGE_NOUNS}\\b`, "i"),
    `an image of ${subject}`,
  );
  output = output.replace(
    new RegExp(`\\b(?:that|this|same|previous)\\s+${IMAGE_NOUNS}\\b`, "i"),
    `an image of ${subject}`,
  );
  output = output.replace(/\b(?:of\s+)?(?:it|them|that|this)\b/i, `of ${subject}`);
  output = output.replace(/\b(?:same\s+one|same\s+thing|like\s+before|as\s+before|previous\s+one)\b/i, subject);

  if (normalizeKey(output) === normalizeKey(input)) {
    output = `Generate an image of ${subject}`;
  }

  output = output
    .replace(/\bgenerate\s+an image\s+an image\b/i, "Generate an image")
    .replace(/\bgenerate\s+image\s+of\b/i, "Generate an image of")
    .replace(/\s+/g, " ")
    .trim();

  return output;
}

function rewriteGeneralPrompt(input: string, subject: string): string {
  return input
    .replace(/\b(?:about|on|regarding)\s+(?:it|them|that|this)\b/i, (match) =>
      match.replace(/\b(?:it|them|that|this)\b/i, subject),
    )
    .replace(/\b(?:it|them|that|this)\b/i, subject)
    .replace(/\b(?:its|their)\b/i, `${subject}'s`)
    .replace(/\b(?:same\s+one|same\s+thing|like\s+before|as\s+before|previous\s+one)\b/i, subject)
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveContextReferences(args: {
  readonly input: string;
  readonly tool: ReferenceResolverTool;
  readonly recentMessages?: readonly ReferenceResolverMessage[];
  readonly conversationSummary?: string;
  readonly memories?: readonly ReferenceResolverMemory[];
}): ReferenceResolution {
  const original = args.input.trim();
  if (!original || !hasContextReference(original)) {
    return {
      original: args.input,
      resolved: args.input,
      changed: false,
      confidence: 1,
      needsClarification: false,
      candidates: [],
    };
  }

  const conversationCandidates = collectConversationCandidates({
    recentMessages: args.recentMessages,
    currentInput: original,
  });
  const summaryCandidates = conversationCandidates.length > 0
    ? []
    : collectSummaryCandidates(args.conversationSummary, original);
  const chatMemoryCandidates = conversationCandidates.length > 0 || summaryCandidates.length > 0
    ? []
    : collectChatMemoryCandidates(args.memories, original);
  const candidates = [...conversationCandidates, ...summaryCandidates, ...chatMemoryCandidates];
  const { selected, ambiguous, visibleCandidates } = selectCandidate(candidates);

  if (!selected || ambiguous) {
    return {
      original: args.input,
      resolved: args.input,
      changed: false,
      confidence: selected ? 0.45 : 0.2,
      source: selected?.source,
      subject: selected?.text,
      needsClarification: true,
      candidates: visibleCandidates,
    };
  }

  const resolved = args.tool === "image_generation"
    ? rewriteImagePrompt(original, selected.text)
    : rewriteGeneralPrompt(original, selected.text);

  return {
    original: args.input,
    resolved,
    changed: normalizeKey(resolved) !== normalizeKey(original),
    subject: selected.text,
    confidence: Math.min(0.95, Math.max(0.55, selected.score / 16)),
    source: selected.source,
    needsClarification: false,
    candidates: visibleCandidates,
  };
}
