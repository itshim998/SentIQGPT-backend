import sharp from "sharp";

export interface PreprocessImageOptions {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly format?: "jpeg" | "png" | "webp";
  readonly quality?: number;
}

export interface PreprocessedImageResult {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth?: number;
  readonly originalHeight?: number;
  readonly wasDownscaled: boolean;
}

const DEFAULT_MAX_WIDTH = 1536;
const DEFAULT_MAX_HEIGHT = 2048;
const DEFAULT_JPEG_QUALITY = 85;

export async function preprocessImage(
  inputBuffer: Buffer,
  options: PreprocessImageOptions = {},
): Promise<PreprocessedImageResult> {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const format = options.format ?? "jpeg";
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;

  let pipeline = sharp(inputBuffer, { failOnError: false }).rotate(); // Auto-rotate by EXIF
  const metadata = await pipeline.metadata();

  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;

  let wasDownscaled = false;
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth > maxWidth || originalHeight > maxHeight) {
    wasDownscaled = true;
    const widthRatio = maxWidth / originalWidth;
    const heightRatio = maxHeight / originalHeight;
    const scale = Math.min(widthRatio, heightRatio);
    targetWidth = Math.round(originalWidth * scale);
    targetHeight = Math.round(originalHeight * scale);
    pipeline = pipeline.resize(targetWidth, targetHeight, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  let finalBuffer: Buffer;
  let mimeType: string;

  if (format === "png") {
    finalBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
    mimeType = "image/png";
  } else if (format === "webp") {
    finalBuffer = await pipeline.webp({ quality }).toBuffer();
    mimeType = "image/webp";
  } else {
    // Default to JPEG with white background for alpha channel
    finalBuffer = await pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    mimeType = "image/jpeg";
  }

  const finalMeta = await sharp(finalBuffer).metadata();

  return {
    buffer: finalBuffer,
    mimeType,
    width: finalMeta.width || targetWidth,
    height: finalMeta.height || targetHeight,
    originalWidth,
    originalHeight,
    wasDownscaled,
  };
}

export function isHeicOrHeifMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return (
    normalized === "image/heic" ||
    normalized === "image/heif" ||
    normalized === "image/heic-sequence" ||
    normalized === "image/heif-sequence"
  );
}

export function isSupportedVisualMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return (
    normalized === "application/pdf" ||
    normalized === "image/jpeg" ||
    normalized === "image/jpg" ||
    normalized === "image/png" ||
    normalized === "image/webp" ||
    isHeicOrHeifMimeType(normalized)
  );
}
