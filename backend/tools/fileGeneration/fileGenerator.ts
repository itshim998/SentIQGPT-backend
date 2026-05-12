import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import {
  callLLMAdapterDetailed,
  strictParseJsonObject,
  type LLMAdapterResult,
} from "../../ai/PromptBuilders";
import { getGeneratedFileStorageDatabase } from "../../dbRouter";
import {
  saveGeneratedFileMetadata,
  uploadGeneratedFile,
} from "./fileStorageService";
import { detectGeneratedFileFormat } from "./fileDetector";
import type {
  FileGenerationRequest,
  GeneratedFileFormat,
  GeneratedFilePreview,
  GeneratedFileResult,
} from "./types";

const PRIMARY_MODEL = "minimax";
const FALLBACK_MODEL = "openai-large";
const FILE_GENERATION_TIMEOUT_MS = 150_000;
const FILE_GENERATION_MAX_TOKENS = 6500;

type GeneratedSection = {
  readonly heading?: string;
  readonly body?: readonly string[];
  readonly bullets?: readonly string[];
};

type GeneratedSlide = {
  readonly title?: string;
  readonly bullets?: readonly string[];
  readonly notes?: string;
};

type GeneratedSheet = {
  readonly name?: string;
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly unknown[])[];
};

type GeneratedFileSpec = {
  readonly title?: string;
  readonly format?: string;
  readonly html?: string;
  readonly text?: string;
  readonly sections?: readonly GeneratedSection[];
  readonly slides?: readonly GeneratedSlide[];
  readonly sheets?: readonly GeneratedSheet[];
};

type RenderedFile = {
  readonly buffer: Buffer;
  readonly preview: GeneratedFilePreview;
  readonly html?: string;
  readonly text?: string;
};

type FileGeneratorDependencies = {
  readonly callModel?: typeof callLLMAdapterDetailed;
  readonly uploadFile?: typeof uploadGeneratedFile;
  readonly saveMetadata?: typeof saveGeneratedFileMetadata;
  readonly storageDb?: any;
};

function getMimeType(format: GeneratedFileFormat): string {
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

function getArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampPreviewText(text: string, maxChars = 2400): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized;
}

function stripJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z0-9_-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return cleaned;
}

function parseModelSpec(raw: string, format: GeneratedFileFormat): GeneratedFileSpec {
  const cleaned = stripJsonFence(raw);

  if (format === "html" && /^<!doctype html|^<html[\s>]/i.test(cleaned)) {
    return { format, html: cleaned };
  }

  const parsed = strictParseJsonObject(cleaned) as GeneratedFileSpec;
  return parsed;
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
      'Schema: {"title":"short title","format":"pdf","sections":[{"heading":"...","body":["paragraph"],"bullets":["point"]}]}',
      "Create PDF-ready prose with headings, paragraphs, and optional bullets.",
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
): Promise<{ spec: GeneratedFileSpec; result: LLMAdapterResult }> {
  const result = await callModel({
    task: "file_generate",
    prompt: buildModelPrompt(userMessage, format),
    model_override: modelOverride,
    user_id: userId,
    timeout_ms: FILE_GENERATION_TIMEOUT_MS,
    max_output_tokens: FILE_GENERATION_MAX_TOKENS,
    skip_wrappers: true,
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
    spec: parseModelSpec(result.text, format),
    result,
  };
}

function ensureHtmlDocument(html: string): string {
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
    preview: { text: clampPreviewText(text) },
  };
}

async function renderDocx(spec: GeneratedFileSpec): Promise<RenderedFile> {
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
    preview: { text: clampPreviewText(textPreview) },
  };
}

async function renderPdf(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const lines = collectDocumentLines(spec);
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 54, size: "A4" });
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(20).text(lines[0] || "Document", { align: "left" });
    doc.moveDown();
    for (const line of lines.slice(1)) {
      if (!line) {
        doc.moveDown(0.7);
      } else if (line.startsWith("- ")) {
        doc.fontSize(11).text(`- ${line.slice(2)}`, { indent: 16 });
      } else {
        doc.fontSize(11).text(line, { paragraphGap: 6 });
      }
    }
    doc.end();
  });

  const text = lines.join("\n");
  return {
    buffer,
    text,
    preview: { text: clampPreviewText(text) },
  };
}

function normalizeSheetRows(sheet: GeneratedSheet): string[][] {
  const columns = getArray(sheet.columns).map(normalizeLine).filter(Boolean);
  const rows = getArray(sheet.rows)
    .map((row) => getArray(row).map((cell) => normalizeLine(cell)))
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
  workbook.creator = "SentIQGPT";
  workbook.created = new Date();

  const sheets = getArray(spec.sheets) as readonly GeneratedSheet[];
  const firstSheet = sheets[0];
  if (!firstSheet) throw new Error("XLSX requires at least one sheet");

  let previewRows: string[][] = [];
  let previewName = normalizeString(firstSheet.name, "Sheet 1");

  for (const [index, sheet] of sheets.entries()) {
    const rows = normalizeSheetRows(sheet);
    if (rows.length === 0) continue;

    const worksheet = workbook.addWorksheet(normalizeString(sheet.name, `Sheet ${index + 1}`).slice(0, 31));
    for (const row of rows) worksheet.addRow(row);
    worksheet.columns.forEach((column) => {
      column.width = Math.min(32, Math.max(10, ...((column.values || []) as unknown[]).map((value) => String(value || "").length + 2)));
    });
    worksheet.getRow(1).font = { bold: true };

    if (previewRows.length === 0) {
      previewRows = rows.slice(0, 16);
      previewName = worksheet.name;
    }
  }

  if (workbook.worksheets.length === 0) throw new Error("XLSX content is empty");
  const rawBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);

  return {
    buffer,
    preview: {
      sheet: {
        name: previewName,
        rows: previewRows,
      },
    },
  };
}

async function renderPptx(spec: GeneratedFileSpec): Promise<RenderedFile> {
  const slides = (getArray(spec.slides) as readonly GeneratedSlide[])
    .map((slide) => ({
      title: normalizeString(slide.title, "Slide"),
      bullets: getArray(slide.bullets).map(normalizeLine).filter(Boolean).slice(0, 8),
      notes: normalizeString(slide.notes),
    }))
    .filter((slide) => slide.title || slide.bullets.length > 0);

  if (slides.length === 0) throw new Error("PPTX requires at least one slide");

  const deck = new pptxgen();
  deck.author = "SentIQGPT";
  deck.subject = normalizeString(spec.title, "Generated presentation");
  deck.title = normalizeString(spec.title, "Generated presentation");
  deck.company = "SentIQGPT";
  deck.layout = "LAYOUT_WIDE";

  for (const slideSpec of slides) {
    const slide = deck.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(slideSpec.title, {
      x: 0.65,
      y: 0.45,
      w: 12.0,
      h: 0.65,
      fontFace: "Aptos Display",
      fontSize: 28,
      bold: true,
      color: "111827",
      fit: "shrink",
    });
    const bulletText = slideSpec.bullets.length > 0
      ? slideSpec.bullets.map((bullet) => ({ text: bullet, options: { bullet: { type: "bullet" as const } } }))
      : [{ text: " ", options: {} }];
    slide.addText(bulletText, {
      x: 0.85,
      y: 1.45,
      w: 11.2,
      h: 4.4,
      fontFace: "Aptos",
      fontSize: 18,
      color: "1F2937",
      breakLine: false,
      fit: "shrink",
      paraSpaceAfter: 10,
    });
    if (slideSpec.notes) {
      slide.addNotes(slideSpec.notes);
    }
  }

  const raw = await deck.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
  return {
    buffer,
    preview: {
      slide: {
        title: slides[0].title,
        bullets: slides[0].bullets,
        notes: slides[0].notes || undefined,
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
  );

  const rendered = await renderSpec(spec, format);
  return { rendered, llm: result, spec };
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
  const format = detectGeneratedFileFormat(args.userMessage);
  if (!format) {
    return {
      success: false,
      format: "txt",
      file_name: "doc.txt",
      mime_type: getMimeType("txt"),
      error: "No supported output file format was requested.",
    };
  }
  if (!args.userId || !args.conversationId || !args.userDb) {
    return {
      success: false,
      format,
      file_name: `doc.${format}`,
      mime_type: getMimeType(format),
      error: "File generation requires an authenticated conversation.",
    };
  }

  const callModel = dependencies.callModel ?? callLLMAdapterDetailed;
  const uploadFile = dependencies.uploadFile ?? uploadGeneratedFile;
  const saveMetadata = dependencies.saveMetadata ?? saveGeneratedFileMetadata;
  const storageDb = dependencies.storageDb ?? args.storageDb ?? getGeneratedFileStorageDatabase();

  let rendered: RenderedFile;
  let llmResult: LLMAdapterResult;
  let fallback = false;
  let fallbackReason: string | null = null;

  try {
    const primary = await attemptGenerate(args, format, PRIMARY_MODEL, { callModel });
    rendered = primary.rendered;
    llmResult = primary.llm;
    fallback = primary.llm.fallback === true;
    fallbackReason = primary.llm.fallback_reason ?? null;
  } catch (primaryError) {
    fallback = true;
    fallbackReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const secondary = await attemptGenerate(args, format, FALLBACK_MODEL, { callModel });
    rendered = secondary.rendered;
    llmResult = {
      ...secondary.llm,
      fallback: true,
      fallback_reason: fallbackReason,
    };
  }

  if (format === "html" && rendered.html && options.onHtmlToken) {
    for (const token of chunkText(rendered.html)) {
      await options.onHtmlToken(token);
    }
  }

  const mimeType = getMimeType(format);
  const fileName = `doc.${format}`;
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
    prompt: args.userMessage,
    provider: llmResult.model_used,
    preview: rendered.preview,
  });

  return {
    type: "file",
    success: true,
    format,
    file_name: fileName,
    mime_type: mimeType,
    file_url: uploaded.fileUrl,
    storage_path: uploaded.storagePath,
    file_size_bytes: uploaded.fileSizeBytes ?? rendered.buffer.length,
    file_id: uploaded.fileId,
    preview: rendered.preview,
    html: rendered.html,
    text: rendered.text,
    model_used: llmResult.model_used,
    fallback: fallback || llmResult.fallback === true,
    fallback_reason: llmResult.fallback_reason ?? fallbackReason,
  };
}
