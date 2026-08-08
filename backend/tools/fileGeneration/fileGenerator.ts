import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import {
  callLLMAdapterDetailed,
  type LLMAdapterResult,
} from "../../ai/PromptBuilders";
import { getGeneratedFileStorageDatabase } from "../../dbRouter";
import {
  deleteGeneratedFileObject,
  saveGeneratedFileMetadata,
  uploadGeneratedFile,
} from "./fileStorageService";
import { composePdf, normalizePdfDocument } from "./pdfDocument";
import { detectGeneratedFileFormat } from "./fileDetector";
import type {
  FileGenerationRequest,
  GeneratedFileFormat,
  GeneratedFilePreview,
  GeneratedFileResult,
} from "./types";
import { PRODUCT_NAME } from "../../branding";

const PRIMARY_MODEL = "minimax";
const FALLBACK_MODEL = "openai-large";
const FILE_GENERATION_TIMEOUT_MS = 150_000;
const FILE_GENERATION_MAX_TOKENS = 6500;
const MIN_RAW_TEXT_REPAIR_CHARS = 24;
const MAX_SECTIONS = 80;
const MAX_SLIDES = 40;
const MAX_BULLETS_PER_SLIDE = 8;
const MAX_SHEETS = 5;
const MAX_ROWS_PER_SHEET = 500;
const MAX_COLUMNS_PER_SHEET = 40;
const MAX_PREVIEW_ROWS_PER_SHEET = 25;

type GeneratedSection = {
  readonly heading?: string;
  readonly body?: readonly string[];
  readonly bullets?: readonly string[];
  readonly ordered?: readonly string[];
  readonly numbered?: readonly string[];
  readonly subsections?: readonly GeneratedSection[];
  readonly tables?: readonly GeneratedTable[];
  readonly callout?: string;
  readonly note?: string;
  readonly page_break_before?: boolean;
  readonly page_break_after?: boolean;
};

type GeneratedTable = {
  readonly caption?: string;
  readonly headers?: readonly string[];
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly unknown[] | Record<string, unknown>)[];
};

type GeneratedSlide = {
  readonly title?: string;
  readonly bullets?: readonly string[];
  readonly notes?: string;
};

type GeneratedSheet = {
  readonly name?: string;
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly unknown[] | Record<string, unknown>)[];
};

export type GeneratedFileSpec = {
  readonly title?: string;
  readonly subtitle?: string;
  readonly introduction?: string;
  readonly intro?: string;
  readonly format?: string;
  readonly html?: string;
  readonly text?: string;
  readonly section?: GeneratedSection | string | readonly GeneratedSection[];
  readonly sections?: readonly GeneratedSection[];
  readonly body?: string | readonly string[];
  readonly bullet?: string | readonly string[];
  readonly bullets?: string | readonly string[];
  readonly blocks?: readonly Record<string, unknown>[];
  readonly slides?: readonly GeneratedSlide[];
  readonly sheets?: readonly GeneratedSheet[];
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly unknown[] | Record<string, unknown>)[];
};

export type RenderedFile = {
  readonly buffer: Buffer;
  readonly preview: GeneratedFilePreview;
  readonly html?: string;
  readonly text?: string;
  readonly usedBasicFallback?: boolean;
  readonly fallbackReason?: string;
};

type FileGeneratorDependencies = {
  readonly callModel?: typeof callLLMAdapterDetailed;
  readonly uploadFile?: typeof uploadGeneratedFile;
  readonly saveMetadata?: typeof saveGeneratedFileMetadata;
  readonly deleteFile?: typeof deleteGeneratedFileObject;
  readonly storageDb?: any;
};

export function getGeneratedFileMimeType(format: GeneratedFileFormat): string {
  switch (format) {
    case "html": return "text/html";
    case "txt": return "text/plain";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function inferTitleFromText(value: string, fallback = "Generated file"): string {
  const firstLine = splitNonEmptyLines(value)
    .map(stripMarkdownPrefix)
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.replace(/[|*_`~]/g, "").slice(0, 90).trim() || fallback;
}

function slugifyFileBase(value: string, fallback = "generated-file"): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .toLowerCase()
    .slice(0, 70);
  return cleaned || fallback;
}

function buildGeneratedFileName(format: GeneratedFileFormat, spec: GeneratedFileSpec, userMessage: string): string {
  const title = normalizeString(spec.title) || inferTitleFromText(spec.text || spec.html || userMessage);
  return `${slugifyFileBase(title)}.${format}`;
}

function getArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampPreviewText(text: string, maxChars = 2400): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized;
}

function countWords(text: string): number {
  return (text.match(/\b[\p{L}\p{N}'-]+\b/gu) || []).length;
}

function stripJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z0-9_-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return cleaned;
}

function extractJsonObject(raw: string): string {
  const cleaned = stripJsonFence(raw);
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) return cleaned;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) return cleaned.slice(start, index + 1);
    }
  }
  return cleaned;
}

function splitNonEmptyLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripMarkdownPrefix(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s+/, "")
    .trim();
}

function rawTextLooksRepairable(raw: string, format: GeneratedFileFormat): boolean {
  const cleaned = stripJsonFence(raw);
  if (cleaned.length < MIN_RAW_TEXT_REPAIR_CHARS) return false;
  if (format === "html") return /<\w+[\s>]|<!doctype html/i.test(cleaned);
  if (format === "xlsx") return /\|.+\||(?:^|\n)[^,\n]+,[^,\n]+/m.test(cleaned);
  if (format === "pptx") return /\bslide\s*\d+|^#{1,3}\s+|(?:^|\n)[-*]\s+/im.test(cleaned);
  return splitNonEmptyLines(cleaned).length >= 2 || cleaned.split(/\s+/).length >= 12;
}

function specFromRawText(raw: string, format: GeneratedFileFormat): GeneratedFileSpec {
  const cleaned = stripJsonFence(raw).trim();
  if (!rawTextLooksRepairable(cleaned, format)) {
    throw new Error("Model returned non-JSON content that is too small to repair");
  }
  if (format === "html") return { format, html: cleaned };
  return { format, text: cleaned, title: inferTitleFromText(cleaned) };
}

const FILE_SPEC_KEYS = new Set(["title", "subtitle", "introduction", "intro", "format", "html", "text", "section", "sections", "body", "bullet", "bullets", "blocks", "slides", "sheets", "columns", "rows"]);
const FILE_SPEC_WRAPPER_KEYS = ["document", "spec", "result", "data", "response", "content", "arguments", "input"] as const;

function hasFileSpecShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (!keys.some((key) => FILE_SPEC_KEYS.has(key))) return false;
  if (Object.prototype.hasOwnProperty.call(value, "title")) return true;
  if (["section", "sections", "blocks", "slides", "sheets", "columns", "rows"].some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return true;
  }
  const hasWrapper = FILE_SPEC_WRAPPER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
  return !hasWrapper && ["html", "text", "body", "bullet", "bullets"].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function unwrapFileSpec(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current === "string") {
      const cleaned = stripJsonFence(current);
      try {
        current = JSON.parse(cleaned);
        continue;
      } catch {
        const extracted = extractJsonObject(cleaned);
        if (extracted === cleaned) return current;
        try {
          current = JSON.parse(extracted);
          continue;
        } catch {
          return current;
        }
      }
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    const record = current as Record<string, unknown>;
    if (hasFileSpecShape(record)) return record;
    const wrapper = FILE_SPEC_WRAPPER_KEYS.find((key) => Object.prototype.hasOwnProperty.call(record, key));
    if (!wrapper) return record;
    current = record[wrapper];
  }
  return current;
}

export function parseGeneratedFileSpec(raw: unknown, format: GeneratedFileFormat): GeneratedFileSpec {
  const cleaned = typeof raw === "string" ? stripJsonFence(raw) : raw;

  if (format === "html" && typeof cleaned === "string" && /^(?:<!doctype html|<html[\s>]|<[\w-]+[\s>])/i.test(cleaned)) {
    return { format, html: cleaned };
  }

  const unwrapped = unwrapFileSpec(cleaned);
  if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
    return unwrapped as GeneratedFileSpec;
  }
  if (typeof unwrapped === "string" && format !== "pdf" && format !== "docx") {
    return specFromRawText(unwrapped, format);
  }
  throw new Error("Model returned an invalid structured document specification");
}

function buildModelPrompt(userMessage: string, format: GeneratedFileFormat): string {
  const baseContract = [
    "TASK: Generate a downloadable file specification.",
    `FORMAT: ${format}`,
    "Return ONLY one JSON object. Do not use markdown fences.",
    "Use concise, polished content. Do not include hidden reasoning.",
    "The server will render the native file; do not invent URLs.",
  ];

  const formatContract: Record<GeneratedFileFormat, string> = {
    html: [
      'Schema: {"title":"short title","format":"html","html":"complete self-contained HTML document"}',
      "The html string must include <!DOCTYPE html>, <html>, <head>, CSS, and <body>.",
    ].join("\n"),
    txt: [
      'Schema: {"title":"short title","format":"txt","text":"complete plain text content"}',
      "Use plain text only.",
    ].join("\n"),
    docx: [
      'Schema: {"title":"short title","format":"docx","sections":[{"heading":"...","body":["paragraph"],"bullets":["point"]}]}',
      "Create document-ready prose with headings, paragraphs, and optional bullets.",
    ].join("\n"),
    pdf: [
      'Schema: {"title":"short title","subtitle":"optional purpose","introduction":"optional short guidance","format":"pdf","sections":[{"heading":"...","body":["paragraph"],"subsections":[{"heading":"...","body":["paragraph"],"bullets":["point"],"ordered":["step"]}],"bullets":["point"],"ordered":["step"],"tables":[{"caption":"optional","headers":["Column"],"rows":[["value"]]}],"callout":"optional","page_break_before":false}]}',
      "Create a complete, document-ready hierarchy. Use prose, lists, and simple tables only when they suit the content.",
      "For plans, schedules, study guides, and reports, group related items into clear sections; use subsections for individually readable days, topics, or work items.",
      "Include a practical introduction and a concluding review, checklist, or continuation section when the request supports them.",
      "Do not emit coordinates, styling, drawing commands, renderer code, tool schemas, or provider metadata.",
    ].join("\n"),
    pptx: [
      'Schema: {"title":"short title","format":"pptx","slides":[{"title":"...","bullets":["point"],"notes":"optional speaker note"}]}',
      "Create slide-sized bullets. Include the requested number of slides when specified.",
    ].join("\n"),
    xlsx: [
      'Schema: {"title":"short title","format":"xlsx","sheets":[{"name":"Sheet name","columns":["A","B"],"rows":[["value","value"]]}]}',
      "Rows must be rectangular. Use strings or numbers only.",
    ].join("\n"),
  };

  return [
    ...baseContract,
    formatContract[format],
    "",
    "USER REQUEST:",
    userMessage,
  ].join("\n");
}

async function invokeFileModel(
  userMessage: string,
  format: GeneratedFileFormat,
  modelOverride: string,
  callModel: typeof callLLMAdapterDetailed,
  userId: string,
  signal?: AbortSignal,
): Promise<{ spec: GeneratedFileSpec; result: LLMAdapterResult }> {
  const result = await callModel({
    task: "file_generate",
    prompt: buildModelPrompt(userMessage, format),
    model_override: modelOverride,
    user_id: userId,
    timeout_ms: FILE_GENERATION_TIMEOUT_MS,
    max_output_tokens: FILE_GENERATION_MAX_TOKENS,
    skip_wrappers: true,
    signal,
  });

  if (result.error) {
    throw new Error(result.error_detail || result.error);
  }
  if (result.truncated) {
    throw new Error(`Model response truncated (${result.finish_reason || "unknown"})`);
  }
  if (!result.text.trim()) {
    throw new Error("Model returned empty file specification");
  }

  return {
    spec: parseGeneratedFileSpec(result.text, format),
    result,
  };
}

export function ensureHtmlDocument(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) throw new Error("HTML content is empty");
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return trimmed;
  }
  if (/<body[\s>]/i.test(trimmed)) {
    return `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Document</title></head>\n${trimmed}\n</html>`;
  }
  return `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Document</title></head>\n<body>\n${trimmed}\n</body>\n</html>`;
}

function repairDocumentSectionsFromSlides(spec: GeneratedFileSpec): GeneratedFileSpec {
  if (getArray(spec.sections).length > 0) return spec;
  const slides = getArray(spec.slides) as readonly GeneratedSlide[];
  if (slides.length === 0) return spec;
  return {
    ...spec,
    sections: slides.map((slide) => ({
      heading: normalizeString(slide.title, "Section"),
      body: normalizeString(slide.notes) ? [normalizeString(slide.notes)] : [],
      bullets: getArray(slide.bullets).map(normalizeLine).filter(Boolean),
    })),
  };
}

function repairSlidesFromDocumentSections(spec: GeneratedFileSpec): GeneratedFileSpec {
  if (getArray(spec.slides).length > 0) return spec;
  const sections = getArray(spec.sections) as readonly GeneratedSection[];
  if (sections.length === 0) return spec;
  return {
    ...spec,
    slides: sections.map((section) => ({
      title: normalizeString(section.heading, "Slide"),
      bullets: [
        ...getArray(section.bullets).map(normalizeLine),
        ...getArray(section.body).map(normalizeLine),
      ].filter(Boolean).slice(0, 8),
    })),
  };
}

function repairXlsxSheets(spec: GeneratedFileSpec): GeneratedFileSpec {
  if (getArray(spec.sheets).length > 0) return spec;
  if (getArray(spec.columns).length === 0 && getArray(spec.rows).length === 0) return spec;
  return {
    ...spec,
    sheets: [{
      name: normalizeString(spec.title, "Sheet 1"),
      columns: getArray(spec.columns).map(normalizeLine).filter(Boolean),
      rows: getArray(spec.rows) as readonly (readonly unknown[] | Record<string, unknown>)[],
    }],
  };
}

function parseMarkdownTable(text: string): GeneratedSheet | null {
  const tableLines = splitNonEmptyLines(text).filter((line) => line.includes("|"));
  if (tableLines.length < 2) return null;
  const rows = tableLines
    .filter((line) => !/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line))
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(normalizeLine))
    .filter((row) => row.length >= 2 && row.some(Boolean));
  if (rows.length < 2) return null;
  return {
    name: "Sheet 1",
    columns: rows[0].slice(0, MAX_COLUMNS_PER_SHEET),
    rows: rows.slice(1, MAX_ROWS_PER_SHEET + 1).map((row) => row.slice(0, MAX_COLUMNS_PER_SHEET)),
  };
}

function parseDelimitedTable(text: string): GeneratedSheet | null {
  const lines = splitNonEmptyLines(text)
    .filter((line) => line.includes(",") || line.includes("\t"));
  if (lines.length < 2) return null;
  const delimiter = lines.filter((line) => line.includes("\t")).length > lines.length / 2 ? "\t" : ",";
  const rows = lines
    .map((line) => line.split(delimiter).map(normalizeLine))
    .filter((row) => row.length >= 2 && row.some(Boolean));
  if (rows.length < 2) return null;
  const width = rows[0].length;
  if (rows.slice(0, 5).some((row) => Math.abs(row.length - width) > 1)) return null;
  return {
    name: "Sheet 1",
    columns: rows[0].slice(0, MAX_COLUMNS_PER_SHEET),
    rows: rows.slice(1, MAX_ROWS_PER_SHEET + 1).map((row) => row.slice(0, MAX_COLUMNS_PER_SHEET)),
  };
}

function repairXlsxSheetsFromText(spec: GeneratedFileSpec): GeneratedFileSpec {
  if (getArray(spec.sheets).length > 0 || !spec.text) return spec;
  const parsed = parseMarkdownTable(spec.text) || parseDelimitedTable(spec.text);
  return parsed ? { ...spec, sheets: [parsed] } : spec;
}

function repairSlidesFromText(spec: GeneratedFileSpec): GeneratedFileSpec {
  if (getArray(spec.slides).length > 0 || !spec.text) return spec;
  const lines = splitNonEmptyLines(spec.text);
  const slides: GeneratedSlide[] = [];
  let current: { title: string; bullets: string[]; notes: string[] } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const bullets = current.bullets.map(normalizeLine).filter(Boolean).slice(0, MAX_BULLETS_PER_SLIDE);
    const notes = current.notes.map(stripMarkdownPrefix).join(" ").trim();
    if (current.title || bullets.length > 0 || notes) {
      slides.push({
        title: normalizeString(current.title, `Slide ${slides.length + 1}`),
        bullets: bullets.length > 0 ? bullets : (notes ? [notes] : []),
        notes: notes || undefined,
      });
    }
  };

  for (const line of lines) {
    const slideMatch = line.match(/^(?:#{1,3}\s*)?(?:slide\s*)?(\d{1,2})[.:)\-\s]+(.+)$/i);
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (slideMatch || (headingMatch && slides.length < MAX_SLIDES)) {
      pushCurrent();
      current = { title: stripMarkdownPrefix(slideMatch?.[2] || headingMatch?.[1] || ""), bullets: [], notes: [] };
      continue;
    }
    if (!current) current = { title: inferTitleFromText(spec.text, "Slide 1"), bullets: [], notes: [] };
    if (/^[-*+]\s+|^\d+[.)]\s+/.test(line)) {
      current.bullets.push(stripMarkdownPrefix(line));
    } else {
      current.notes.push(line);
    }
  }
  pushCurrent();

  return slides.length > 0 ? { ...spec, slides: slides.slice(0, MAX_SLIDES) } : spec;
}

function repairDocumentSectionsFromText(spec: GeneratedFileSpec): GeneratedFileSpec {
  if (getArray(spec.sections).length > 0 || !spec.text) return spec;
  const lines = spec.text.replace(/\r\n?/g, "\n").split("\n");
  const sections: GeneratedSection[] = [];
  let current: { heading: string; body: string[]; bullets: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.map(normalizeLine).filter(Boolean);
    const bullets = current.bullets.map(normalizeLine).filter(Boolean);
    if (current.heading || body.length > 0 || bullets.length > 0) {
      sections.push({
        heading: current.heading || `Section ${sections.length + 1}`,
        body,
        bullets,
      });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flush();
      current = { heading: stripMarkdownPrefix(heading[1]), body: [], bullets: [] };
      continue;
    }
    if (!current) current = { heading: inferTitleFromText(spec.text, "Document"), body: [], bullets: [] };
    if (/^[-*+]\s+|^\d+[.)]\s+/.test(line)) {
      current.bullets.push(stripMarkdownPrefix(line));
    } else {
      current.body.push(line);
    }
  }
  flush();

  return sections.length > 0 ? { ...spec, text: undefined, sections: sections.slice(0, MAX_SECTIONS) } : spec;
}

function limitSpecForFormat(spec: GeneratedFileSpec, format: GeneratedFileFormat): GeneratedFileSpec {
  if (format === "pptx") {
    return {
      ...spec,
      slides: getArray(spec.slides).slice(0, MAX_SLIDES).map((slide) => {
        const typed = slide as GeneratedSlide;
        return {
          ...typed,
          bullets: getArray(typed.bullets).slice(0, MAX_BULLETS_PER_SLIDE).map(normalizeLine).filter(Boolean),
        };
      }),
    };
  }
  if (format === "docx") {
    return {
      ...spec,
      sections: getArray(spec.sections).slice(0, MAX_SECTIONS).map((section) => {
        const typed = section as GeneratedSection;
        return {
          heading: typed.heading,
          body: getArray(typed.body).slice(0, 30).map(normalizeLine).filter(Boolean),
          bullets: getArray(typed.bullets).slice(0, 30).map(normalizeLine).filter(Boolean),
        };
      }),
    };
  }
  if (format === "xlsx") {
    return {
      ...spec,
      sheets: getArray(spec.sheets).slice(0, MAX_SHEETS).map((sheet) => {
        const typed = sheet as GeneratedSheet;
        return {
          ...typed,
          columns: getArray(typed.columns).slice(0, MAX_COLUMNS_PER_SHEET).map(normalizeLine).filter(Boolean),
          rows: getArray(typed.rows).slice(0, MAX_ROWS_PER_SHEET) as readonly (readonly unknown[] | Record<string, unknown>)[],
        };
      }),
    };
  }
  return spec;
}

export function repairSpecForFormat(spec: GeneratedFileSpec, format: GeneratedFileFormat): GeneratedFileSpec {
  const normalized: GeneratedFileSpec = { ...spec, format };
  let repaired: GeneratedFileSpec;
  switch (format) {
    case "docx":
      repaired = repairDocumentSectionsFromText(repairDocumentSectionsFromSlides(normalized));
      break;
    case "pdf":
      repaired = repairDocumentSectionsFromSlides(normalized);
      break;
    case "pptx":
      repaired = repairSlidesFromText(repairSlidesFromDocumentSections(normalized));
      break;
    case "xlsx":
      repaired = repairXlsxSheetsFromText(repairXlsxSheets(normalized));
      break;
    default:
      repaired = normalized;
      break;
  }
  return limitSpecForFormat(repaired, format);
}

function collectDocumentLines(spec: GeneratedFileSpec): string[] {
  const lines: string[] = [];
  const title = normalizeString(spec.title, "Document");
  lines.push(title);

  if (typeof spec.text === "string" && spec.text.trim()) {
    lines.push("", spec.text.trim());
  }

  for (const section of getArray(spec.sections) as readonly GeneratedSection[]) {
    const heading = normalizeString(section.heading);
    if (heading) lines.push("", heading);
    for (const paragraph of getArray(section.body)) {
      const text = normalizeLine(paragraph);
      if (text) lines.push(text);
    }
    for (const bullet of getArray(section.bullets)) {
      const text = normalizeLine(bullet);
      if (text) lines.push(`- ${text}`);
    }
  }

  const normalized = lines.filter((line, index) => line || lines[index - 1] !== "");
  if (normalized.join("\n").trim().length < 10) {
    throw new Error("Document content is too short");
  }
  return normalized;
}

async function renderHtml(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const html = ensureHtmlDocument(normalizeString(spec.html));
  return {
    buffer: Buffer.from(html, "utf8"),
    html,
    preview: { html, text: clampPreviewText(html) },
  };
}

async function renderTxt(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const text = normalizeString(spec.text) || collectDocumentLines(spec).join("\n");
  if (!text.trim()) throw new Error("Text content is empty");
  return {
    buffer: Buffer.from(text.trim(), "utf8"),
    text: text.trim(),
    preview: {
      text: clampPreviewText(text),
      document: {
        title: inferTitleFromText(text),
        word_count: countWords(text),
      },
    },
  };
}

export async function renderDocx(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const title = normalizeString(spec.title, "Document");
  const children: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];

  for (const section of getArray(spec.sections) as readonly GeneratedSection[]) {
    const heading = normalizeString(section.heading);
    if (heading) {
      children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const paragraph of getArray(section.body)) {
      const text = normalizeLine(paragraph);
      if (text) children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
    for (const bullet of getArray(section.bullets)) {
      const text = normalizeLine(bullet);
      if (text) children.push(new Paragraph({ text, bullet: { level: 0 } }));
    }
  }

  if (children.length === 1 && typeof spec.text === "string" && spec.text.trim()) {
    for (const paragraph of spec.text.split(/\n{2,}/)) {
      const text = normalizeLine(paragraph);
      if (text) children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
  }

  if (children.length < 2) throw new Error("DOCX content is too short");

  const document = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(document);
  const textPreview = collectDocumentLines(spec).join("\n");
  return {
    buffer,
    text: textPreview,
    preview: {
      text: clampPreviewText(textPreview),
      document: {
        title,
        section_count: getArray(spec.sections).length || undefined,
        word_count: countWords(textPreview),
      },
    },
  };
}

export async function renderPdf(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const document = normalizePdfDocument(spec);
  const composed = await composePdf(document);
  const text = composed.text;
  return {
    buffer: composed.buffer,
    text,
    usedBasicFallback: composed.usedBasicFallback,
    fallbackReason: composed.fallbackReason,
    preview: {
      text: clampPreviewText(text),
      document: {
        title: document.title,
        section_count: document.blocks.filter((block) => block.type === "heading" && block.level === 2).length || undefined,
        word_count: countWords(text),
      },
    },
  };
}

function collectObjectColumns(rows: readonly unknown[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      const normalized = normalizeLine(key);
      const lookup = normalized.toLowerCase();
      if (!normalized || seen.has(lookup)) continue;
      seen.add(lookup);
      columns.push(normalized);
    }
  }
  return columns;
}

function normalizeSheetRows(sheet: GeneratedSheet): string[][] {
  const rawRows = getArray(sheet.rows);
  const explicitColumns = getArray(sheet.columns).map(normalizeLine).filter(Boolean);
  const objectColumns = explicitColumns.length > 0 ? explicitColumns : collectObjectColumns(rawRows);
  const columns = objectColumns;
  const rows = getArray(sheet.rows)
    .map((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const record = row as Record<string, unknown>;
        const lowerLookup = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
        return columns.map((column) => normalizeLine(record[column] ?? lowerLookup.get(column.toLowerCase()) ?? ""));
      }
      return getArray(row).map((cell) => normalizeLine(cell));
    })
    .filter((row) => row.some(Boolean));

  if (columns.length > 0) {
    return [columns, ...rows.map((row) => {
      const normalized = [...row];
      while (normalized.length < columns.length) normalized.push("");
      return normalized.slice(0, columns.length);
    })];
  }

  return rows;
}

async function renderXlsx(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = PRODUCT_NAME;
  workbook.created = new Date();

  const sheets = getArray(spec.sheets) as readonly GeneratedSheet[];
  const firstSheet = sheets[0];
  if (!firstSheet) throw new Error("XLSX requires at least one sheet");

  const previewSheets: Array<{
    name: string;
    rows: string[][];
    row_count: number;
    column_count: number;
  }> = [];

  for (const [index, sheet] of sheets.entries()) {
    const rows = normalizeSheetRows(sheet)
      .slice(0, MAX_ROWS_PER_SHEET + 1)
      .map((row) => row.slice(0, MAX_COLUMNS_PER_SHEET));
    if (rows.length === 0) continue;

    const worksheet = workbook.addWorksheet(normalizeString(sheet.name, `Sheet ${index + 1}`).slice(0, 31));
    for (const row of rows) worksheet.addRow(row);
    worksheet.columns.forEach((column) => {
      column.width = Math.min(32, Math.max(10, ...((column.values || []) as unknown[]).map((value) => String(value || "").length + 2)));
    });
    worksheet.getRow(1).font = { bold: true };

    previewSheets.push({
      name: worksheet.name,
      rows: rows.slice(0, MAX_PREVIEW_ROWS_PER_SHEET),
      row_count: rows.length,
      column_count: Math.max(...rows.map((row) => row.length)),
    });
  }

  if (workbook.worksheets.length === 0) throw new Error("XLSX content is empty");
  const rawBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);

  return {
    buffer,
    preview: {
      sheets: previewSheets,
      sheet: {
        name: previewSheets[0]?.name || "Sheet 1",
        rows: previewSheets[0]?.rows || [],
        row_count: previewSheets[0]?.row_count,
        column_count: previewSheets[0]?.column_count,
      },
    },
  };
}

async function validateRenderedXlsx(rendered: RenderedFile): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(rendered.buffer as unknown as ArrayBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.actualRowCount < 1) {
    throw new Error("XLSX validation failed: generated workbook is empty");
  }
  const previewRows = rendered.preview.sheet?.rows ?? [];
  if (previewRows.length > 0) {
    const firstPreviewRow = previewRows[0].map((cell) => String(cell ?? ""));
    const firstWorkbookRow = (worksheet.getRow(1).values as unknown[])
      .slice(1, firstPreviewRow.length + 1)
      .map((cell) => String(cell ?? ""));
    if (firstPreviewRow.join("\u0001") !== firstWorkbookRow.join("\u0001")) {
      throw new Error("XLSX validation failed: workbook rows do not match preview");
    }
  }
}

async function validateOfficeZip(rendered: RenderedFile, format: "docx" | "pptx"): Promise<void> {
  if (rendered.buffer[0] !== 0x50 || rendered.buffer[1] !== 0x4b || rendered.buffer.length < 1000) {
    throw new Error(`${format.toUpperCase()} validation failed: invalid Office ZIP envelope`);
  }
  const zip = await JSZip.loadAsync(rendered.buffer);
  if (!zip.file("[Content_Types].xml")) {
    throw new Error(`${format.toUpperCase()} validation failed: missing content types`);
  }
  if (format === "docx") {
    if (!zip.file("word/document.xml")) {
      throw new Error("DOCX validation failed: missing word/document.xml");
    }
    return;
  }
  if (!zip.file("ppt/presentation.xml")) {
    throw new Error("PPTX validation failed: missing ppt/presentation.xml");
  }
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  if (slideFiles.length === 0) {
    throw new Error("PPTX validation failed: no slide XML files");
  }
  const previewSlides = rendered.preview.slides ?? [];
  if (slideFiles.length !== previewSlides.length) {
    throw new Error("PPTX validation failed: slide package does not match preview");
  }
  for (let index = 0; index < previewSlides.length; index += 1) {
    if (!zip.file(`ppt/notesSlides/notesSlide${index + 1}.xml`)) {
      throw new Error(`PPTX validation failed: missing notes package for slide ${index + 1}`);
    }
  }
}

async function validateRenderedFile(rendered: RenderedFile, format: GeneratedFileFormat): Promise<void> {
  if (!Buffer.isBuffer(rendered.buffer) || rendered.buffer.length === 0) {
    throw new Error(`${format.toUpperCase()} validation failed: empty file buffer`);
  }

  switch (format) {
    case "html":
      if (!rendered.html || !/^<!doctype html|^<html[\s>]/i.test(rendered.html.trim())) {
        throw new Error("HTML validation failed: missing document shell");
      }
      break;
    case "txt":
      if (!rendered.text?.trim()) throw new Error("TXT validation failed: empty text");
      break;
    case "pdf":
      if (rendered.buffer.subarray(0, 4).toString("utf8") !== "%PDF") {
        throw new Error("PDF validation failed: invalid PDF header");
      }
      if (!rendered.buffer.toString("latin1").includes("%%EOF") || !/\/Page\b/.test(rendered.buffer.toString("latin1"))) {
        throw new Error("PDF validation failed: missing EOF or page marker");
      }
      break;
    case "docx":
    case "pptx":
      await validateOfficeZip(rendered, format);
      break;
    case "xlsx":
      await validateRenderedXlsx(rendered);
      break;
    default:
      break;
  }
}

function escapeOfficeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pptxTextParagraph(text: string, options: { readonly bullet?: boolean; readonly title?: boolean } = {}): string {
  const escaped = escapeOfficeXml(text || " ");
  const paragraphProperties = options.bullet
    ? '<a:pPr marL="342900" indent="-285750"><a:spcAft><a:spcPts val="1000"/></a:spcAft><a:buChar char="&#x2022;"/></a:pPr>'
    : '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>';
  const fontSize = options.title ? 2800 : 1800;
  const fontFace = options.title ? "Aptos Display" : "Aptos";
  const color = options.title ? "111827" : "1F2937";
  const bold = options.title ? ' b="1"' : "";
  return `<a:p>${paragraphProperties}<a:r><a:rPr lang="en-US" sz="${fontSize}"${bold} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${fontFace}"/><a:ea typeface="${fontFace}"/><a:cs typeface="${fontFace}"/></a:rPr><a:t xml:space="preserve">${escaped}</a:t></a:r><a:endParaRPr lang="en-US" sz="${fontSize}" dirty="0"/></a:p>`;
}

function pptxTextShape(
  id: number,
  name: string,
  bounds: { readonly x: number; readonly y: number; readonly cx: number; readonly cy: number },
  paragraphs: string,
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeOfficeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${bounds.x}" y="${bounds.y}"/><a:ext cx="${bounds.cx}" cy="${bounds.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function pptxGroupShape(): string {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

async function renderPptx(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const slides = (getArray(spec.slides) as readonly GeneratedSlide[])
    .slice(0, MAX_SLIDES)
    .map((slide) => ({
      title: normalizeString(slide.title, "Slide"),
      bullets: getArray(slide.bullets).map(normalizeLine).filter(Boolean).slice(0, MAX_BULLETS_PER_SLIDE),
      notes: normalizeString(slide.notes),
    }))
    .filter((slide) => slide.title || slide.bullets.length > 0);

  if (slides.length === 0) throw new Error("PPTX requires at least one slide");

  const zip = new JSZip();
  const presentationTitle = normalizeString(spec.title, "Generated presentation");
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const slideOverrides = slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const notesOverrides = slides.map((_, index) => `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}${notesOverrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slides.length}</Slides><Notes>${slides.filter((slide) => slide.notes).length}</Notes><Company>${escapeOfficeXml(PRODUCT_NAME)}</Company><AppVersion>16.0000</AppVersion></Properties>`);
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeOfficeXml(presentationTitle)}</dc:title><dc:subject>${escapeOfficeXml(presentationTitle)}</dc:subject><dc:creator>${escapeOfficeXml(PRODUCT_NAME)}</dc:creator><cp:lastModifiedBy>${escapeOfficeXml(PRODUCT_NAME)}</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified></cp:coreProperties>`);

  const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${slides.length + 2}"/></p:notesMasterIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="12192000"/><p:defaultTextStyle><a:lvl1pPr marL="0"><a:defRPr sz="1800" lang="en-US"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`);
  const slideRelationships = slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRelationships}<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/></Relationships>`);

  zip.file("ppt/theme/theme1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="SentIQ"><a:themeElements><a:clrScheme name="SentIQ"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="111827"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="7C3AED"/></a:accent2><a:accent3><a:srgbClr val="059669"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="SentIQ"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="SentIQ"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>');
  zip.file("ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${pptxGroupShape()}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:hf sldNum="0" hdr="0" ftr="0" dt="0"/><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2800" lang="en-US"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-285750"><a:buChar char="&#x2022;"/><a:defRPr sz="1800" lang="en-US"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800" lang="en-US"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
  zip.file("ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" preserve="1"><p:cSld name="SentIQ"><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${pptxGroupShape()}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');
  zip.file("ppt/notesMasters/notesMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${pptxGroupShape()}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0"><a:defRPr sz="1200" lang="en-US"/></a:lvl1pPr></p:notesStyle></p:notesMaster>`);
  zip.file("ppt/notesMasters/_rels/notesMaster1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');

  slides.forEach((slideSpec, index) => {
    const slideNumber = index + 1;
    const titleParagraph = pptxTextParagraph(slideSpec.title, { title: true });
    const bulletParagraphs = slideSpec.bullets.length > 0
      ? slideSpec.bullets.map((bullet) => pptxTextParagraph(bullet, { bullet: true })).join("")
      : pptxTextParagraph(" ");
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Slide ${slideNumber}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree>${pptxGroupShape()}${pptxTextShape(2, "Title", { x: 594360, y: 411480, cx: 10972800, cy: 594360 }, titleParagraph)}${pptxTextShape(3, "Bullets", { x: 777240, y: 1325880, cx: 10241280, cy: 4023360 }, bulletParagraphs)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    zip.file(`ppt/slides/slide${slideNumber}.xml`, slideXml);
    zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${slideNumber}.xml"/></Relationships>`);

    const noteParagraphs = (slideSpec.notes || " ").split(/\r?\n/).map((line) => pptxTextParagraph(line)).join("");
    zip.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${pptxGroupShape()}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${noteParagraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
    zip.file(`ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNumber}.xml"/></Relationships>`);
  });

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  });
  return {
    buffer,
    preview: {
      slides: slides.map((slide, index) => ({
        title: slide.title,
        bullets: slide.bullets,
        notes: slide.notes || undefined,
        index: index + 1,
      })),
      slide_count: slides.length,
      slide: {
        title: slides[0].title,
        bullets: slides[0].bullets,
        notes: slides[0].notes || undefined,
        index: 1,
      },
    },
  };
}

async function renderSpec(spec: GeneratedFileSpec, format: GeneratedFileFormat): Promise<RenderedFile> {
  switch (format) {
    case "html": return renderHtml(spec);
    case "txt": return renderTxt(spec);
    case "docx": return renderDocx(spec);
    case "pdf": return renderPdf(spec);
    case "xlsx": return renderXlsx(spec);
    case "pptx": return renderPptx(spec);
    default: throw new Error(`Unsupported file format: ${format}`);
  }
}

async function attemptGenerate(
  args: FileGenerationRequest,
  format: GeneratedFileFormat,
  modelOverride: string,
  dependencies: Required<Pick<FileGeneratorDependencies, "callModel">>,
): Promise<{ rendered: RenderedFile; llm: LLMAdapterResult; spec: GeneratedFileSpec }> {
  const { spec, result } = await invokeFileModel(
    args.userMessage,
    format,
    modelOverride,
    dependencies.callModel,
    args.userId,
    args.signal,
  );

  const repairedSpec = repairSpecForFormat(spec, format);
  const rendered = await renderSpec(repairedSpec, format);
  await validateRenderedFile(rendered, format);
  return { rendered, llm: result, spec: repairedSpec };
}

function chunkText(value: string, chunkSize = 320): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function routeFileGeneration(
  args: FileGenerationRequest,
  options: {
    readonly onHtmlToken?: (token: string) => Promise<void> | void;
  } = {},
  dependencies: FileGeneratorDependencies = {},
): Promise<GeneratedFileResult> {
  const throwIfAborted = () => {
    if (!args.signal?.aborted) return;
    throw args.signal.reason instanceof Error ? args.signal.reason : new Error("File generation aborted");
  };
  throwIfAborted();
  const format = args.requestedFormat ?? detectGeneratedFileFormat(args.userMessage);
  if (!format) {
    return {
      success: false,
      format: "txt",
      file_name: "doc.txt",
      mime_type: getGeneratedFileMimeType("txt"),
      error: "No supported output file format was requested.",
    };
  }
  if (!args.userId || !args.conversationId || !args.userDb) {
    return {
      success: false,
      format,
      file_name: `doc.${format}`,
      mime_type: getGeneratedFileMimeType(format),
      error: "File generation requires an authenticated conversation.",
    };
  }

  const callModel = dependencies.callModel ?? callLLMAdapterDetailed;
  const uploadFile = dependencies.uploadFile ?? uploadGeneratedFile;
  const saveMetadata = dependencies.saveMetadata ?? saveGeneratedFileMetadata;
  const deleteFile = dependencies.deleteFile ?? deleteGeneratedFileObject;
  const storageDb = dependencies.storageDb ?? args.storageDb ?? getGeneratedFileStorageDatabase();

  let rendered: RenderedFile;
  let llmResult: LLMAdapterResult;
  let generatedSpec: GeneratedFileSpec | null = null;
  let fallback = false;
  let fallbackReason: string | null = null;

  try {
    throwIfAborted();
    const primary = await attemptGenerate(args, format, PRIMARY_MODEL, { callModel });
    rendered = primary.rendered;
    llmResult = primary.llm;
    generatedSpec = primary.spec;
    fallback = primary.llm.fallback === true || primary.rendered.usedBasicFallback === true;
    fallbackReason = primary.rendered.fallbackReason ?? primary.llm.fallback_reason ?? null;
  } catch (primaryError) {
    fallback = true;
    fallbackReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
    try {
      throwIfAborted();
      const secondary = await attemptGenerate(args, format, FALLBACK_MODEL, { callModel });
      rendered = secondary.rendered;
      generatedSpec = secondary.spec;
      llmResult = {
        ...secondary.llm,
        fallback: true,
        fallback_reason: secondary.rendered.fallbackReason ?? fallbackReason,
      };
      fallbackReason = secondary.rendered.fallbackReason ?? fallbackReason;
    } catch (secondaryError) {
      const secondaryMessage = secondaryError instanceof Error ? secondaryError.message : String(secondaryError);
      return {
        success: false,
        format,
        file_name: `${slugifyFileBase(args.userMessage)}.${format}`,
        mime_type: getGeneratedFileMimeType(format),
        fallback: true,
        fallback_reason: fallbackReason,
        error: `File generation failed after fallback: ${secondaryMessage}`,
      };
    }
  }

  if (format === "html" && rendered.html && options.onHtmlToken) {
    for (const token of chunkText(rendered.html)) {
      throwIfAborted();
      await options.onHtmlToken(token);
    }
  }

  throwIfAborted();
  const mimeType = getGeneratedFileMimeType(format);
  const fileName = buildGeneratedFileName(format, generatedSpec || { format }, args.userMessage);
  const uploaded = await uploadFile(storageDb, {
    userId: args.userId,
    chatId: args.conversationId,
    format,
    buffer: rendered.buffer,
    mimeType,
  });

  if (!uploaded.success || !uploaded.fileUrl || !uploaded.storagePath || !uploaded.fileId) {
    return {
      success: false,
      format,
      file_name: fileName,
      mime_type: mimeType,
      preview: rendered.preview,
      html: rendered.html,
      text: rendered.text,
      model_used: llmResult.model_used,
      fallback: true,
      fallback_reason: uploaded.error || fallbackReason,
      error: uploaded.error || "Generated file could not be uploaded.",
    };
  }

  if (args.signal?.aborted) {
    if (uploaded.storageBucket && uploaded.storagePath) {
      await deleteFile(storageDb, uploaded.storageBucket, uploaded.storagePath).catch((cleanupError) => {
        console.warn(`[FileGeneration] cancellation cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      });
    }
    throwIfAborted();
  }

  try {
    await saveMetadata(args.userDb, {
      fileId: uploaded.fileId,
      userId: args.userId,
      chatId: args.conversationId,
      format,
      fileName,
      mimeType,
      fileUrl: uploaded.fileUrl,
      storagePath: uploaded.storagePath,
      fileSizeBytes: uploaded.fileSizeBytes ?? rendered.buffer.length,
      storageBucket: uploaded.storageBucket,
      contentSha256: uploaded.contentSha256,
      version: uploaded.version,
      prompt: args.userMessage,
      provider: llmResult.model_used,
      preview: rendered.preview,
    });
  } catch (metadataError) {
    let cleanupFailed = false;
    let cleanupMessage: string | undefined;
    if (uploaded.storageBucket && uploaded.storagePath) {
      try {
        await deleteFile(storageDb, uploaded.storageBucket, uploaded.storagePath);
      } catch (cleanupError) {
        cleanupFailed = true;
        cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.warn(
          `[FileGeneration] metadata save failed and orphan cleanup failed ` +
          `fileId=${uploaded.fileId} bucket=${uploaded.storageBucket} path=${uploaded.storagePath} error=${cleanupMessage}`,
        );
      }
    }
    return {
      success: false,
      format,
      file_name: fileName,
      mime_type: mimeType,
      preview: rendered.preview,
      html: rendered.html,
      text: rendered.text,
      model_used: llmResult.model_used,
      fallback: true,
      fallback_reason: metadataError instanceof Error ? metadataError.message : String(metadataError),
      error: "Generated file could not be saved. Please try again.",
      warning: cleanupFailed ? "Uploaded generated file could not be cleaned up after metadata failure." : undefined,
      cleanup_failed: cleanupFailed || undefined,
      orphaned_storage_bucket: cleanupFailed ? uploaded.storageBucket : undefined,
      orphaned_storage_path: cleanupFailed ? uploaded.storagePath : undefined,
    };
  }

  return {
    type: "file",
    success: true,
    format,
    file_name: fileName,
    mime_type: mimeType,
    file_url: uploaded.fileUrl,
    storage_path: uploaded.storagePath,
    storage_bucket: uploaded.storageBucket,
    file_size_bytes: uploaded.fileSizeBytes ?? rendered.buffer.length,
    content_sha256: uploaded.contentSha256,
    version: uploaded.version,
    file_id: uploaded.fileId,
    preview: rendered.preview,
    html: rendered.html,
    text: rendered.text,
    model_used: llmResult.model_used,
    fallback: fallback || llmResult.fallback === true,
    fallback_reason: llmResult.fallback_reason ?? fallbackReason,
  };
}
