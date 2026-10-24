import sharp from "sharp";
import { z } from "zod";
import { HttpError } from "../../httpErrors";
import type { ImageEditInput, ImageEditOperation } from "./types";

export const MAX_EDIT_BYTES = 8 * 1024 * 1024;
export const MAX_EDIT_PIXELS = 16 * 1024 * 1024;
export const ImageEditRequestSchema = z.object({
  sourceImageId: z.union([z.string().uuid(), z.literal("latest")]).transform((id) => id.toLowerCase()),
  conversationId: z.string().uuid().transform((id) => id.toLowerCase()),
  clientRequestId: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(2000),
  operation: z.enum(["edit", "erase_region", "replace_background", "remove_background"]).default("edit"),
  mask: z.string().max(Math.ceil(MAX_EDIT_BYTES * 4 / 3) + 128).optional(),
  size: z.enum(["256x256", "512x512", "1024x1024"]).default("1024x1024"),
  executionMode: z.enum(["fast", "intuitive"]).default("fast"),
}).strict();
export type ImageEditRequest = z.infer<typeof ImageEditRequestSchema>;

/** Bound provider responses before JSON/base64 allocation. Never follow image URLs. */
export async function readEditProviderResponse(response: Response, maxBytes = 12 * 1024 * 1024): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Image editing response exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Image editing provider returned an empty response");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error("Image editing response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function invalid(message: string): never {
  throw new HttpError(422, message, { code: "image_edit_invalid_file" });
}

export function decodeEditMask(value: string): Buffer {
  const match = /^(?:data:image\/png;base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) return invalid("Mask must be base64 PNG data.");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length > MAX_EDIT_BYTES || bytes.toString("base64") !== match[1]) return invalid("Invalid mask data.");
  return bytes;
}

export async function validateEditRaster(bytes: Buffer, mask = false): Promise<sharp.Metadata> {
  if (!bytes.length || bytes.length > MAX_EDIT_BYTES) return invalid("Image exceeds the editing input size limit.");
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_EDIT_PIXELS, failOn: "warning" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || !["png", "jpeg", "webp"].includes(meta.format || "")
        || (meta.pages ?? 1) !== 1 || (mask && meta.format !== "png")) return invalid("Unsupported image format.");
    // metadata alone does not detect truncated pixel data.
    await image.raw().toBuffer();
    return meta;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return invalid("Image could not be decoded safely.");
  }
}

export async function validateEditInput(source: Buffer, operation: ImageEditOperation, mask?: Buffer): Promise<ImageEditInput> {
  const meta = await validateEditRaster(source);
  if ((operation === "erase_region") !== Boolean(mask)) return invalid("Region erasing requires a mask; other operations do not accept masks.");
  if (mask) {
    const maskMeta = await validateEditRaster(mask, true);
    if (maskMeta.width !== meta.width || maskMeta.height !== meta.height || !maskMeta.hasAlpha) {
      return invalid("Mask must have alpha transparency and match the source dimensions.");
    }
    const { data } = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = false;
    let opaque = false;
    for (let i = 3; i < data.length; i += 4) { transparent ||= data[i] === 0; opaque ||= data[i] === 255; }
    if (!transparent || !opaque) return invalid("Mask must contain both transparent edit pixels and opaque protected pixels.");
  }
  return { source, operation, mask };
}
