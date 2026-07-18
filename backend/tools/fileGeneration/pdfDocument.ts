import PDFDocument from "pdfkit";
import { PRODUCT_NAME } from "../../branding";

export type PdfDocumentBlock =
  | { readonly type: "heading"; readonly text: string; readonly level: 2 | 3 }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly type: "table"; readonly caption?: string; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly type: "callout"; readonly text: string }
  | { readonly type: "page_break" };

export type NormalizedPdfDocument = {
  readonly title: string;
  readonly subtitle?: string;
  readonly introduction?: string;
  readonly blocks: readonly PdfDocumentBlock[];
};

export type ComposedPdf = {
  readonly buffer: Buffer;
  readonly text: string;
  readonly pageCount: number;
  readonly usedBasicFallback: boolean;
  readonly fallbackReason?: string;
};

const MAX_BLOCKS = 600;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_ROWS = 120;
const PAGE_COLOR = "#FFFFFF";
const TITLE_COLOR = "#172033";
const TEXT_COLOR = "#273244";
const MUTED_COLOR = "#667085";
const ACCENT_COLOR = "#7656D8";
const ACCENT_LIGHT = "#F4F0FF";
const BORDER_COLOR = "#D8DDE8";
const TABLE_HEADER_COLOR = "#F0ECFC";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, maxLength = 20_000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanInline(value: unknown, maxLength = 8_000): string {
  return cleanText(value, maxLength).replace(/\s+/g, " ").trim();
}

function cleanStringArray(value: unknown, limit = 80): string[] {
  const values = Array.isArray(value) ? value.slice(0, limit) : typeof value === "string" ? [value] : [];
  return values.map((item) => cleanInline(item)).filter(Boolean);
}

const SERIALIZED_DOCUMENT_KEYS = new Set([
  "arguments", "blocks", "document", "format", "input", "response", "sections", "slides", "spec", "sheets", "title",
]);

function looksLikeSerializedDocumentPayload(value: string, documentTitle: string): boolean {
  let current: unknown = value.trim();
  for (let depth = 0; depth < 3 && typeof current === "string"; depth += 1) {
    if (!/^(?:\{[\s\S]*\}|"[\s\S]*")$/.test(current.trim())) return false;
    try {
      current = JSON.parse(current);
    } catch {
      return false;
    }
  }
  const record = asRecord(current);
  if (!record) return false;
  const matched = Object.keys(record).filter((key) => SERIALIZED_DOCUMENT_KEYS.has(key));
  const hasContentShape = ["blocks", "sections", "slides", "sheets"].some((key) => Object.prototype.hasOwnProperty.call(record, key));
  const hasWrapper = ["arguments", "document", "input", "response", "spec"].some((key) => Object.prototype.hasOwnProperty.call(record, key));
  const payloadTitle = cleanInline(record.title, 500);
  return hasWrapper ||
    (hasContentShape && matched.length >= 3) ||
    (hasContentShape && Boolean(payloadTitle) && payloadTitle === documentTitle);
}

function validateVisibleText(value: string, documentTitle: string): void {
  if (looksLikeSerializedDocumentPayload(value, documentTitle)) {
    throw new Error("PDF document contains a serialized document payload");
  }
}

function normalizeTable(value: unknown): Extract<PdfDocumentBlock, { type: "table" }> | null {
  const table = asRecord(value);
  if (!table) return null;
  let headers = cleanStringArray(table.headers ?? table.columns, MAX_TABLE_COLUMNS);
  const rawRows = Array.isArray(table.rows) ? table.rows.slice(0, MAX_TABLE_ROWS) : [];
  const objectKeys = headers.length === 0
    ? Object.keys(asRecord(rawRows[0]) ?? {}).slice(0, MAX_TABLE_COLUMNS)
    : [];
  if (headers.length === 0) headers = objectKeys.map((key) => cleanInline(key)).filter(Boolean);

  const rows = rawRows.map((row) => {
    if (Array.isArray(row)) return row.slice(0, MAX_TABLE_COLUMNS).map((cell) => cleanInline(cell));
    const record = asRecord(row);
    if (!record) return [];
    const keys = objectKeys.length > 0 ? objectKeys : headers;
    return keys.slice(0, MAX_TABLE_COLUMNS).map((key) => cleanInline(record[key]));
  }).filter((row) => row.some(Boolean));
  const width = Math.max(headers.length, ...rows.map((row) => row.length), 0);
  if (width < 1 || rows.length < 1) return null;
  if (headers.length === 0) headers = Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const normalizedHeaders = headers.slice(0, width);
  while (normalizedHeaders.length < width) normalizedHeaders.push(`Column ${normalizedHeaders.length + 1}`);
  const normalizedRows = rows.map((row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  });
  return {
    type: "table",
    caption: cleanInline(table.caption, 500) || undefined,
    headers: normalizedHeaders,
    rows: normalizedRows,
  };
}

function appendDirectBlock(blocks: PdfDocumentBlock[], value: unknown): void {
  const block = asRecord(value);
  if (!block) return;
  const type = cleanInline(block.type, 40).toLowerCase().replace(/-/g, "_");
  if (type === "page_break" || type === "pagebreak") {
    blocks.push({ type: "page_break" });
    return;
  }
  if (type === "table") {
    const table = normalizeTable(block);
    if (table) blocks.push(table);
    return;
  }
  if (type === "list" || type === "ordered_list" || type === "unordered_list") {
    const items = cleanStringArray(block.items);
    if (items.length > 0) blocks.push({
      type: "list",
      ordered: type === "ordered_list" || block.ordered === true || block.style === "ordered",
      items,
    });
    return;
  }
  const text = cleanText(block.text ?? block.content);
  if (!text) return;
  if (type === "heading" || type === "subheading") {
    blocks.push({ type: "heading", text: cleanInline(text), level: block.level === 3 ? 3 : 2 });
  } else if (type === "callout" || type === "note") {
    blocks.push({ type: "callout", text });
  } else if (type === "paragraph" || type === "text") {
    blocks.push({ type: "paragraph", text });
  }
}

function appendSubsection(blocks: PdfDocumentBlock[], value: unknown): void {
  const subsection = asRecord(value);
  if (!subsection) return;
  const heading = cleanInline(subsection.heading ?? subsection.title);
  if (heading) blocks.push({ type: "heading", text: heading, level: 3 });
  for (const paragraph of cleanStringArray(subsection.body ?? subsection.paragraphs, 50)) {
    blocks.push({ type: "paragraph", text: paragraph });
  }
  const ordered = cleanStringArray(subsection.ordered ?? subsection.numbered, 80);
  if (ordered.length > 0) blocks.push({ type: "list", ordered: true, items: ordered });
  const bullets = cleanStringArray(subsection.bullets, 80);
  if (bullets.length > 0) blocks.push({ type: "list", ordered: false, items: bullets });
  for (const listValue of Array.isArray(subsection.lists) ? subsection.lists : []) appendDirectBlock(blocks, { type: "list", ...(asRecord(listValue) ?? {}) });
  for (const tableValue of Array.isArray(subsection.tables) ? subsection.tables : []) {
    const table = normalizeTable(tableValue);
    if (table) blocks.push(table);
  }
  const callout = cleanText(subsection.callout ?? subsection.note);
  if (callout) blocks.push({ type: "callout", text: callout });
}

function appendSection(blocks: PdfDocumentBlock[], value: unknown): void {
  const section = asRecord(value);
  if (!section) return;
  if (section.page_break_before === true || section.pageBreakBefore === true) blocks.push({ type: "page_break" });
  const heading = cleanInline(section.heading ?? section.title);
  if (heading) blocks.push({ type: "heading", text: heading, level: 2 });
  for (const paragraph of cleanStringArray(section.body ?? section.paragraphs, 80)) {
    blocks.push({ type: "paragraph", text: paragraph });
  }
  const ordered = cleanStringArray(section.ordered ?? section.numbered, 120);
  if (ordered.length > 0) blocks.push({ type: "list", ordered: true, items: ordered });
  const bullets = cleanStringArray(section.bullets, 120);
  if (bullets.length > 0) blocks.push({ type: "list", ordered: false, items: bullets });
  for (const listValue of Array.isArray(section.lists) ? section.lists : []) appendDirectBlock(blocks, { type: "list", ...(asRecord(listValue) ?? {}) });
  for (const tableValue of Array.isArray(section.tables) ? section.tables : []) {
    const table = normalizeTable(tableValue);
    if (table) blocks.push(table);
  }
  const callout = cleanText(section.callout ?? section.note);
  if (callout) blocks.push({ type: "callout", text: callout });
  for (const subsection of Array.isArray(section.subsections) ? section.subsections : []) appendSubsection(blocks, subsection);
  for (const directBlock of Array.isArray(section.blocks) ? section.blocks : []) appendDirectBlock(blocks, directBlock);
  if (section.page_break_after === true || section.pageBreakAfter === true) blocks.push({ type: "page_break" });
}

export function normalizePdfDocument(specValue: unknown): NormalizedPdfDocument {
  const spec = asRecord(specValue);
  if (!spec) throw new Error("PDF document specification must be an object");
  const title = cleanInline(spec.title, 500);
  if (!title) throw new Error("PDF document title is required");
  const blocks: PdfDocumentBlock[] = [];
  const rawSections = Array.isArray(spec.sections)
    ? spec.sections
    : Array.isArray(spec.section)
      ? spec.section
      : spec.section !== undefined
        ? [spec.section]
        : [];
  for (const section of rawSections) {
    if (typeof section === "string") {
      appendSection(blocks, {
        heading: section,
        body: spec.body,
        bullets: spec.bullets ?? spec.bullet,
      });
    } else {
      appendSection(blocks, section);
    }
  }
  if (rawSections.length === 0 && (spec.body !== undefined || spec.bullets !== undefined || spec.bullet !== undefined)) {
    appendSection(blocks, {
      body: spec.body,
      bullets: spec.bullets ?? spec.bullet,
    });
  }
  for (const block of Array.isArray(spec.blocks) ? spec.blocks : []) appendDirectBlock(blocks, block);
  if (blocks.length === 0 && typeof spec.text === "string" && spec.text.trim()) {
    blocks.push({ type: "paragraph", text: cleanText(spec.text) });
  }
  const meaningfulBlocks = blocks.filter((block) => block.type !== "page_break");
  if (meaningfulBlocks.length === 0) throw new Error("PDF document content is required");
  const document = {
    title,
    subtitle: cleanInline(spec.subtitle, 1_000) || undefined,
    introduction: cleanText(spec.introduction ?? spec.intro, 10_000) || undefined,
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
  validateVisibleText(document.title, document.title);
  if (document.subtitle) validateVisibleText(document.subtitle, document.title);
  if (document.introduction) validateVisibleText(document.introduction, document.title);
  for (const block of document.blocks) {
    if (block.type === "heading" || block.type === "paragraph" || block.type === "callout") validateVisibleText(block.text, document.title);
    else if (block.type === "list") block.items.forEach((item) => validateVisibleText(item, document.title));
    else if (block.type === "table") {
      if (block.caption) validateVisibleText(block.caption, document.title);
      block.headers.forEach((header) => validateVisibleText(header, document.title));
      block.rows.forEach((row) => row.forEach((cell) => validateVisibleText(cell, document.title)));
    }
  }
  return document;
}

function collectPdfText(document: NormalizedPdfDocument): string {
  const lines = [document.title];
  if (document.subtitle) lines.push(document.subtitle);
  if (document.introduction) lines.push(document.introduction);
  for (const block of document.blocks) {
    if (block.type === "page_break") continue;
    if (block.type === "heading" || block.type === "paragraph" || block.type === "callout") lines.push(block.text);
    else if (block.type === "list") block.items.forEach((item, index) => lines.push(`${block.ordered ? `${index + 1}.` : "-"} ${item}`));
    else {
      if (block.caption) lines.push(block.caption);
      lines.push(block.headers.join(" | "));
      block.rows.forEach((row) => lines.push(row.join(" | ")));
    }
  }
  return lines.join("\n");
}

type PdfFonts = { regular: string; bold: string };

function configureFonts(doc: PDFKit.PDFDocument): PdfFonts {
  void doc;
  return { regular: "Helvetica", bold: "Helvetica-Bold" };
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function contentBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom;
}

function usablePageHeight(doc: PDFKit.PDFDocument): number {
  return contentBottom(doc) - doc.page.margins.top;
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > contentBottom(doc)) doc.addPage();
}

function addFooterAndHeader(doc: PDFKit.PDFDocument, fonts: PdfFonts, title: string): number {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const left = doc.page.margins.left;
    const width = contentWidth(doc);
    const footerY = doc.page.height - 38;
    doc.save();
    doc.page.margins.bottom = 0;
    if (index > 0) {
      doc.font(fonts.regular).fontSize(8).fillColor(MUTED_COLOR)
        .text(title, left, 27, { width, ellipsis: true, lineBreak: false });
      doc.strokeColor(BORDER_COLOR).lineWidth(0.4).moveTo(left, 42).lineTo(left + width, 42).stroke();
    }
    doc.strokeColor(BORDER_COLOR).lineWidth(0.5).moveTo(left, footerY - 8).lineTo(left + width, footerY - 8).stroke();
    doc.font(fonts.regular).fontSize(8).fillColor(MUTED_COLOR)
      .text(`Generated by ${PRODUCT_NAME}`, left, footerY, { width: width / 2, lineBreak: false })
      .text(`Page ${index + 1} of ${range.count}`, left + width / 2, footerY, { width: width / 2, align: "right", lineBreak: false });
    doc.restore();
  }
  return range.count;
}

function renderTitle(doc: PDFKit.PDFDocument, fonts: PdfFonts, document: NormalizedPdfDocument): void {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(PAGE_COLOR);
  doc.font(fonts.bold).fillColor(TITLE_COLOR).fontSize(25).text(document.title, { lineGap: 3, paragraphGap: 8 });
  if (document.subtitle) doc.font(fonts.regular).fillColor(MUTED_COLOR).fontSize(12).text(document.subtitle, { lineGap: 3, paragraphGap: 6 });
  doc.moveDown(0.25);
  doc.strokeColor(ACCENT_COLOR).lineWidth(2).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 74, doc.y).stroke();
  doc.moveDown(0.8);
  if (document.introduction) {
    doc.font(fonts.regular).fillColor(TEXT_COLOR).fontSize(10.8).text(document.introduction, { lineGap: 4, paragraphGap: 10 });
  }
}

function renderHeading(doc: PDFKit.PDFDocument, fonts: PdfFonts, block: Extract<PdfDocumentBlock, { type: "heading" }>): void {
  const fontSize = block.level === 2 ? 16 : 12.5;
  doc.font(fonts.bold).fontSize(fontSize);
  const height = doc.heightOfString(block.text, { width: contentWidth(doc), lineGap: 2 });
  ensureSpace(doc, height + (block.level === 2 ? 48 : 34));
  doc.moveDown(block.level === 2 ? 0.75 : 0.45);
  if (block.level === 2) {
    const y = doc.y + 3;
    doc.roundedRect(doc.page.margins.left, y, 4, Math.max(18, height), 2).fill(ACCENT_COLOR);
    doc.font(fonts.bold).fillColor(TITLE_COLOR).fontSize(fontSize).text(block.text, doc.page.margins.left + 13, doc.y, {
      width: contentWidth(doc) - 13,
      lineGap: 2,
      paragraphGap: 6,
    });
  } else {
    doc.font(fonts.bold).fillColor(ACCENT_COLOR).fontSize(fontSize).text(block.text, { lineGap: 2, paragraphGap: 5 });
  }
}

function renderParagraph(doc: PDFKit.PDFDocument, fonts: PdfFonts, text: string): void {
  doc.font(fonts.regular).fontSize(10.6);
  const previewHeight = Math.min(doc.heightOfString(text, { width: contentWidth(doc), lineGap: 3.6 }), 72);
  ensureSpace(doc, Math.max(34, previewHeight));
  doc.fillColor(TEXT_COLOR).text(text, { align: "left", lineGap: 3.6, paragraphGap: 8 });
}

function renderList(doc: PDFKit.PDFDocument, fonts: PdfFonts, block: Extract<PdfDocumentBlock, { type: "list" }>): void {
  const left = doc.page.margins.left;
  const markerWidth = block.ordered ? 27 : 18;
  const width = contentWidth(doc) - markerWidth;
  block.items.forEach((item, index) => {
    doc.font(fonts.regular).fontSize(10.4);
    const height = doc.heightOfString(item, { width, lineGap: 3.2 });
    ensureSpace(doc, Math.min(Math.max(height + 7, 26), usablePageHeight(doc)));
    const y = doc.y;
    doc.fillColor(ACCENT_COLOR);
    if (block.ordered) doc.font(fonts.bold).text(`${index + 1}.`, left, y, { width: markerWidth - 4, align: "right", lineBreak: false });
    else doc.circle(left + 5, y + 6, 2.1).fill(ACCENT_COLOR);
    doc.font(fonts.regular).fillColor(TEXT_COLOR).text(item, left + markerWidth, y, { width, lineGap: 3.2, paragraphGap: 6 });
  });
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  fonts: PdfFonts,
  cells: readonly string[],
  widths: readonly number[],
  header: boolean,
): void {
  const left = doc.page.margins.left;
  doc.font(header ? fonts.bold : fonts.regular).fontSize(header ? 9.1 : 8.8);
  const padding = 6;
  const heights = cells.map((cell, index) => doc.heightOfString(cell, { width: widths[index] - padding * 2, lineGap: 2 }));
  const rowHeight = Math.max(header ? 27 : 24, ...heights.map((height) => height + padding * 2));
  ensureSpace(doc, rowHeight);
  const y = doc.y;
  doc.rect(left, y, widths.reduce((sum, width) => sum + width, 0), rowHeight).fill(header ? TABLE_HEADER_COLOR : PAGE_COLOR);
  let x = left;
  cells.forEach((cell, index) => {
    doc.rect(x, y, widths[index], rowHeight).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
    doc.font(header ? fonts.bold : fonts.regular).fillColor(header ? TITLE_COLOR : TEXT_COLOR).fontSize(header ? 9.1 : 8.8)
      .text(cell, x + padding, y + padding, { width: widths[index] - padding * 2, height: rowHeight - padding * 2, lineGap: 2 });
    x += widths[index];
  });
  doc.y = y + rowHeight;
}

function renderTable(doc: PDFKit.PDFDocument, fonts: PdfFonts, block: Extract<PdfDocumentBlock, { type: "table" }>): void {
  if (block.caption) {
    ensureSpace(doc, 36);
    doc.font(fonts.bold).fillColor(TITLE_COLOR).fontSize(10.2).text(block.caption, { paragraphGap: 5 });
  }
  const width = contentWidth(doc);
  const columnWidth = width / block.headers.length;
  const widths = block.headers.map(() => columnWidth);
  ensureSpace(doc, 58);
  drawTableRow(doc, fonts, block.headers, widths, true);
  for (const row of block.rows) {
    doc.font(fonts.regular).fontSize(8.8);
    const estimated = Math.max(...row.map((cell, index) => doc.heightOfString(cell, { width: widths[index] - 12, lineGap: 2 }) + 12), 24);
    if (estimated > usablePageHeight(doc) - 40) {
      if (doc.y + 42 > contentBottom(doc)) doc.addPage();
      row.forEach((cell, index) => {
        if (!cell) return;
        renderHeading(doc, fonts, { type: "heading", level: 3, text: block.headers[index] || `Column ${index + 1}` });
        renderParagraph(doc, fonts, cell);
      });
      continue;
    }
    if (doc.y + estimated > contentBottom(doc)) {
      doc.addPage();
      drawTableRow(doc, fonts, block.headers, widths, true);
    }
    drawTableRow(doc, fonts, row, widths, false);
  }
  doc.moveDown(0.65);
}

function renderCallout(doc: PDFKit.PDFDocument, fonts: PdfFonts, text: string): void {
  const width = contentWidth(doc);
  doc.font(fonts.regular).fontSize(10.2);
  const textHeight = doc.heightOfString(text, { width: width - 26, lineGap: 3.2 });
  const boxHeight = textHeight + 20;
  if (boxHeight > usablePageHeight(doc) - 20) {
    ensureSpace(doc, 40);
    doc.strokeColor(ACCENT_COLOR).lineWidth(2).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 48, doc.y).stroke();
    doc.moveDown(0.5);
    renderParagraph(doc, fonts, text);
    return;
  }
  ensureSpace(doc, boxHeight);
  const y = doc.y;
  doc.roundedRect(doc.page.margins.left, y, width, boxHeight, 5).fill(ACCENT_LIGHT);
  doc.rect(doc.page.margins.left, y, 4, boxHeight).fill(ACCENT_COLOR);
  doc.font(fonts.regular).fillColor(TEXT_COLOR).fontSize(10.2).text(text, doc.page.margins.left + 14, y + 10, {
    width: width - 26,
    lineGap: 3.2,
  });
  doc.y = y + boxHeight + 8;
}

async function compose(document: NormalizedPdfDocument, basic: boolean): Promise<ComposedPdf> {
  let pageCount = 0;
  const buffer = await new Promise<Buffer>((resolveBuffer, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 58, right: 58, bottom: 68, left: 58 },
      bufferPages: true,
      info: { Title: document.title, Author: PRODUCT_NAME, Subject: "Generated document" },
    });
    const fonts = configureFonts(doc);
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolveBuffer(Buffer.concat(chunks)));
    renderTitle(doc, fonts, document);

    for (const block of document.blocks) {
      if (block.type === "page_break") {
        if (doc.y > doc.page.margins.top + 20) doc.addPage();
      } else if (basic) {
        if (block.type === "heading") renderHeading(doc, fonts, block);
        else if (block.type === "paragraph" || block.type === "callout") renderParagraph(doc, fonts, block.text);
        else if (block.type === "list") renderList(doc, fonts, block);
        else {
          if (block.caption) renderParagraph(doc, fonts, block.caption);
          renderParagraph(doc, fonts, block.headers.join(" | "));
          block.rows.forEach((row) => renderParagraph(doc, fonts, row.join(" | ")));
        }
      } else if (block.type === "heading") renderHeading(doc, fonts, block);
      else if (block.type === "paragraph") renderParagraph(doc, fonts, block.text);
      else if (block.type === "list") renderList(doc, fonts, block);
      else if (block.type === "table") renderTable(doc, fonts, block);
      else if (block.type === "callout") renderCallout(doc, fonts, block.text);
    }
    pageCount = addFooterAndHeader(doc, fonts, document.title);
    doc.end();
  });
  return { buffer, text: collectPdfText(document), pageCount, usedBasicFallback: basic };
}

export async function composePdf(document: NormalizedPdfDocument): Promise<ComposedPdf> {
  try {
    return await compose(document, false);
  } catch (error) {
    try {
      return {
        ...await compose(document, true),
        fallbackReason: error instanceof Error ? error.message : String(error),
      };
    } catch {
      throw error;
    }
  }
}
