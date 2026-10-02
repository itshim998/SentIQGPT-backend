import { bootProfiler } from "../../bootProfiler";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _PDFParseClass: any = null;

bootProfiler.mark("imageInput.pdfRenderer.init.begin");
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("pdf-parse");
  _PDFParseClass = mod.PDFParse ?? null;
  if (_PDFParseClass && typeof _PDFParseClass.setWorker === "function") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const _path = require("path");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const _url = require("url");
    const workerFile = _path.resolve(
      _path.dirname(require.resolve("pdf-parse")),
      "pdf.worker.mjs",
    );
    const workerURL = _url.pathToFileURL(workerFile).href;
    _PDFParseClass.setWorker(workerURL);
  }
} catch {
  console.warn("[PDF Renderer] pdf-parse not available");
} finally {
  bootProfiler.mark("imageInput.pdfRenderer.init.done");
}

export interface RenderedPdfPage {
  readonly pageNumber: number;
  readonly imageBuffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
}

export interface PdfDocumentInfo {
  readonly pageCount: number;
}

export async function getPdfInfo(pdfBuffer: Buffer): Promise<PdfDocumentInfo> {
  if (!_PDFParseClass) {
    throw new Error("pdf-parse library is not loaded");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser: any = new _PDFParseClass({ data: pdfBuffer, verbosity: 0 });
  try {
    const info = await parser.getInfo({ parsePageInfo: false });
    const declaredPageCount = Math.max(0, Math.floor(Number(info?.total) || 0));
    return { pageCount: declaredPageCount };
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Best-effort cleanup
    }
  }
}

export async function renderPdfPage(args: {
  readonly pdfBuffer: Buffer;
  readonly pageNumber: number;
  readonly scale?: number;
}): Promise<RenderedPdfPage> {
  if (!_PDFParseClass) {
    throw new Error("pdf-parse library is not loaded");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser: any = new _PDFParseClass({ data: args.pdfBuffer, verbosity: 0 });
  try {
    const screenshotResult = await parser.getScreenshot({
      partial: [args.pageNumber],
      imageBuffer: true,
      scale: args.scale ?? 1.5,
    });
    if (!screenshotResult?.pages || screenshotResult.pages.length === 0) {
      throw new Error(`Failed to render page ${args.pageNumber} from PDF`);
    }
    const page = screenshotResult.pages[0];
    const imageBuffer = Buffer.from(page.data);
    return {
      pageNumber: args.pageNumber,
      imageBuffer,
      width: Math.round(Number(page.width) || 0),
      height: Math.round(Number(page.height) || 0),
      mimeType: "image/png",
    };
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Best-effort cleanup
    }
  }
}

export async function renderPdfPages(args: {
  readonly pdfBuffer: Buffer;
  readonly pageNumbers: readonly number[];
  readonly scale?: number;
}): Promise<RenderedPdfPage[]> {
  const results: RenderedPdfPage[] = [];
  for (const pageNumber of args.pageNumbers) {
    results.push(await renderPdfPage({
      pdfBuffer: args.pdfBuffer,
      pageNumber,
      scale: args.scale,
    }));
  }
  return results;
}
