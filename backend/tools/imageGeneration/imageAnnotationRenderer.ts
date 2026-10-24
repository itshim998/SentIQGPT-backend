import sharp from "sharp";
import { ImageAnnotationSchema, type ImageAnnotation } from "./imageAnnotationContract";
import { validateEditRaster, MAX_EDIT_PIXELS } from "./imageEditValidation";
import { HttpError } from "../../httpErrors";

let activeRenders = 0;

/** Only validated numeric paths/hex colors enter SVG. Client SVG, files and URLs
 * are never accepted. Coordinates and brush scaling match the local canvas. */
export async function renderImageAnnotation(source: Buffer, raw: ImageAnnotation): Promise<Buffer> {
  if (activeRenders >= 2) throw new HttpError(429, "Image processing is busy. Retry shortly.", {
    code: "image_annotation_busy", headers: { "Retry-After": "3" },
  });
  activeRenders++;
  try {
    const annotation = ImageAnnotationSchema.parse(raw);
    await validateEditRaster(source);
    const normalized = await sharp(source, { limitInputPixels: MAX_EDIT_PIXELS, failOn: "warning" }).rotate().png().toBuffer();
    const { width, height } = await sharp(normalized).metadata();
    if (!width || !height) throw new Error("Image dimensions unavailable");
    const n = (value: number) => value.toFixed(4);
    const paths = annotation.strokes.map(stroke => {
      const size = stroke.size * Math.max(1, width / 900);
      if (stroke.points.length === 1) {
        const p = stroke.points[0];
        return `<circle cx="${n(p.x * width)}" cy="${n(p.y * height)}" r="${n(size / 2)}" fill="${stroke.color}"/>`;
      }
      const points = stroke.points.map(p => `${n(p.x * width)},${n(p.y * height)}`).join(" ");
      return `<polyline points="${points}" fill="none" stroke="${stroke.color}" stroke-width="${n(size)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join("");
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}</svg>`);
    const result = await sharp(normalized).composite([{ input: overlay }]).png().toBuffer();
    await validateEditRaster(result);
    return result;
  } finally { activeRenders--; }
}
