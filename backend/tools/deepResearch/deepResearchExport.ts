import PDFDocument from "pdfkit";
import {
  AlignmentType,
  convertInchesToTwip,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from "docx";
import { PRODUCT_NAME } from "../../branding";

export type DeepResearchExportBlock = {
  type: "heading" | "paragraph" | "bullet" | "numbered" | "citation";
  text: string;
  level?: 1 | 2 | 3;
  marker?: string;
  worksCited: boolean;
};

export type ParsedDeepResearchDocument = {
  title: string;
  subtitle: string;
  blocks: DeepResearchExportBlock[];
};

export type DeepResearchExportInput = {
  title: string;
  content: string;
  generatedAt?: Date;
};

const MOJIBAKE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["â€œ", "“"],
  ["â€", "”"],
  ["â€˜", "‘"],
  ["â€™", "’"],
  ["â€”", "—"],
  ["â€“", "–"],
  ["â€¦", "…"],
  ["Â ", " "],
];

/** Removes transport/control artifacts without flattening intentional punctuation. */
export function sanitizeDeepResearchExportText(value: unknown): string {
  let text = String(value ?? "").normalize("NFC");
  for (const [broken, replacement] of MOJIBAKE_REPLACEMENTS) {
    text = text.split(broken).join(replacement);
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/\u00AD/g, "-")
    .replace(/[\u2010\u2011\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF\uFFFD]/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_]+)_(?!_)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s*/, "")
    .replace(/\\([#*_[\]()`>+.!-])/g, "$1")
    .trim();
}

function sameNormalizedText(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalize(left) === normalize(right);
}

export function parseDeepResearchMarkdown(
  titleValue: unknown,
  contentValue: unknown,
): ParsedDeepResearchDocument {
  const storedTitle = cleanInlineMarkdown(sanitizeDeepResearchExportText(titleValue)) || "Deep Research Report";
  const content = sanitizeDeepResearchExportText(contentValue);
  const blocks: DeepResearchExportBlock[] = [];
  let paragraphLines: string[] = [];
  let worksCited = false;

  const flushParagraph = () => {
    const text = cleanInlineMarkdown(paragraphLines.join(" "));
    if (text) blocks.push({ type: "paragraph", text, worksCited });
    paragraphLines = [];
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const text = cleanInlineMarkdown(headingMatch[2]);
      const level = headingMatch[1].length as 1 | 2 | 3;
      const isWorksCitedHeading = /^(works cited|references|sources|bibliography)$/i.test(text);
      if (isWorksCitedHeading) worksCited = true;
      blocks.push({ type: "heading", text, level, worksCited: worksCited || isWorksCitedHeading });
      continue;
    }

    if (/^(?:---+|___+|\*\*\*+)$/.test(line)) {
      flushParagraph();
      continue;
    }

    const citationMatch = line.match(/^\[(\d+)\]\s+(.+)$/);
    if (citationMatch) {
      flushParagraph();
      blocks.push({
        type: "citation",
        marker: `[${citationMatch[1]}]`,
        text: cleanInlineMarkdown(citationMatch[2]),
        worksCited: true,
      });
      continue;
    }

    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({ type: "bullet", text: cleanInlineMarkdown(bulletMatch[1]), worksCited });
      continue;
    }

    const numberedMatch = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push({
        type: worksCited ? "citation" : "numbered",
        marker: worksCited ? `[${numberedMatch[1]}]` : `${numberedMatch[1]}.`,
        text: cleanInlineMarkdown(numberedMatch[2]),
        worksCited,
      });
      continue;
    }

    paragraphLines.push(line);
  }
  flushParagraph();

  const firstH1Index = blocks.findIndex((block) => block.type === "heading" && block.level === 1);
  const firstH1 = firstH1Index >= 0 ? blocks[firstH1Index].text : "";
  if (firstH1Index >= 0) blocks.splice(firstH1Index, 1);

  const title = firstH1 || storedTitle;
  const subtitle = firstH1 && !sameNormalizedText(firstH1, storedTitle)
    ? storedTitle
    : "Deep Research Report";
  return { title, subtitle, blocks };
}

function formatExportDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function ensurePdfSpace(doc: PDFKit.PDFDocument, minimumHeight: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + minimumHeight > bottom) doc.addPage();
}

function renderPdfBlock(doc: PDFKit.PDFDocument, block: DeepResearchExportBlock): void {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  if (block.type === "heading") {
    const level = block.level ?? 2;
    ensurePdfSpace(doc, level === 1 ? 82 : 60);
    doc.moveDown(level === 1 ? 0.8 : 0.55);
    doc
      .font("Helvetica-Bold")
      .fillColor(level === 1 ? "#111827" : "#1F3A5F")
      .fontSize(level === 1 ? 17 : level === 2 ? 14 : 12)
      .text(block.text, { lineGap: 2, paragraphGap: level === 1 ? 8 : 6 });
    return;
  }

  const isSource = block.worksCited || block.type === "citation";
  const fontSize = isSource ? 9 : 10.5;
  const textColor = isSource ? "#374151" : "#1F2937";
  ensurePdfSpace(doc, isSource ? 34 : 42);
  doc.font("Helvetica").fillColor(textColor).fontSize(fontSize);

  if (block.type === "bullet") {
    doc.text(`•  ${block.text}`, {
      indent: 14,
      width: contentWidth - 14,
      lineGap: isSource ? 2 : 3,
      paragraphGap: isSource ? 5 : 7,
    });
    return;
  }
  if (block.type === "numbered" || block.type === "citation") {
    doc.text(`${block.marker || ""}  ${block.text}`, {
      indent: 14,
      width: contentWidth - 14,
      lineGap: isSource ? 2 : 3,
      paragraphGap: isSource ? 5 : 7,
    });
    return;
  }
  doc.text(block.text, {
    align: "left",
    lineGap: isSource ? 2 : 3.5,
    paragraphGap: isSource ? 6 : 9,
  });
}

function addPdfFooters(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    doc.switchToPage(range.start + index);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.page.height - 38;
    doc
      .strokeColor("#D1D5DB")
      .lineWidth(0.5)
      .moveTo(left, y - 7)
      .lineTo(left + width, y - 7)
      .stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#6B7280");
    doc.text(`Generated by ${PRODUCT_NAME}`, left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${index + 1} of ${range.count}`, left + width / 2, y, {
      width: width / 2,
      align: "right",
      lineBreak: false,
    });
    doc.page.margins.bottom = originalBottomMargin;
  }
}

export async function renderDeepResearchPdf(input: DeepResearchExportInput): Promise<Buffer> {
  const parsed = parseDeepResearchMarkdown(input.title, input.content);
  const generatedAt = input.generatedAt ?? new Date();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 62, right: 64, bottom: 64, left: 64 },
      bufferPages: true,
      info: { Title: parsed.title, Author: PRODUCT_NAME, Subject: "Deep Research Report" },
    });
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.font("Helvetica-Bold").fillColor("#111827").fontSize(24).text(parsed.title, {
      lineGap: 2,
      paragraphGap: 7,
    });
    doc.font("Helvetica").fillColor("#4B5563").fontSize(11).text(parsed.subtitle, {
      lineGap: 2,
      paragraphGap: 3,
    });
    doc.font("Helvetica").fillColor("#6B7280").fontSize(9).text(`Exported ${formatExportDate(generatedAt)}`);
    doc.moveDown(0.8);
    doc.strokeColor("#9CA3AF").lineWidth(0.8)
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke();
    doc.moveDown(0.8);

    for (const block of parsed.blocks) renderPdfBlock(doc, block);
    addPdfFooters(doc);
    doc.end();
  });
}

function docxHeading(block: DeepResearchExportBlock): Paragraph {
  const level = block.level ?? 2;
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
    spacing: { before: level === 1 ? 320 : 240, after: 110, line: 280 },
    keepNext: true,
    children: [new TextRun({
      text: block.text,
      bold: true,
      color: level === 1 ? "111827" : "1F3A5F",
      size: level === 1 ? 32 : level === 2 ? 28 : 24,
      font: "Aptos Display",
    })],
  });
}

function docxContentBlock(block: DeepResearchExportBlock): Paragraph {
  const isSource = block.worksCited || block.type === "citation";
  const prefix = block.type === "bullet"
    ? "•  "
    : block.type === "numbered" || block.type === "citation"
      ? `${block.marker || ""}  `
      : "";
  return new Paragraph({
    spacing: { after: isSource ? 100 : 150, line: isSource ? 270 : 320 },
    indent: prefix ? { left: 360, hanging: 240 } : undefined,
    alignment: AlignmentType.LEFT,
    widowControl: true,
    children: [new TextRun({
      text: `${prefix}${block.text}`,
      size: isSource ? 18 : 21,
      color: isSource ? "374151" : "1F2937",
      font: "Aptos",
    })],
  });
}

export async function renderDeepResearchDocx(input: DeepResearchExportInput): Promise<Buffer> {
  const parsed = parseDeepResearchMarkdown(input.title, input.content);
  const generatedAt = input.generatedAt ?? new Date();
  const children: Paragraph[] = [
    new Paragraph({
      spacing: { after: 100, line: 300 },
      children: [new TextRun({ text: parsed.title, bold: true, size: 44, color: "111827", font: "Aptos Display" })],
    }),
    new Paragraph({
      spacing: { after: 70 },
      children: [new TextRun({ text: parsed.subtitle, italics: true, size: 23, color: "4B5563", font: "Aptos" })],
    }),
    new Paragraph({
      spacing: { after: 260 },
      border: { bottom: { color: "9CA3AF", size: 6, style: "single", space: 8 } },
      children: [new TextRun({ text: `Exported ${formatExportDate(generatedAt)}`, size: 18, color: "6B7280", font: "Aptos" })],
    }),
  ];

  for (const block of parsed.blocks) {
    children.push(block.type === "heading" ? docxHeading(block) : docxContentBlock(block));
  }

  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: `Generated by ${PRODUCT_NAME}  •  Page `, size: 16, color: "6B7280", font: "Aptos" }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "6B7280", font: "Aptos" }),
        new TextRun({ text: " of ", size: 16, color: "6B7280", font: "Aptos" }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: "6B7280", font: "Aptos" }),
      ],
    })],
  });

  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.75),
            right: convertInchesToTwip(0.8),
            bottom: convertInchesToTwip(0.8),
            left: convertInchesToTwip(0.8),
            footer: convertInchesToTwip(0.35),
          },
          pageNumbers: { start: 1 },
        },
      },
      footers: { default: footer },
      children,
    }],
  });
  return Packer.toBuffer(document);
}
