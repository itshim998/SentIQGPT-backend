import { z } from "zod";

export const MAX_ANNOTATION_STROKES = 128;
export const MAX_ANNOTATION_POINTS = 4096;
const point = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict();
export const ImageAnnotationSchema = z.object({
  version: z.literal(1),
  strokes: z.array(z.object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i).transform(value => value.toLowerCase()),
    size: z.number().int().min(2).max(25),
    points: z.array(point).min(1).max(MAX_ANNOTATION_POINTS),
  }).strict()).min(1).max(MAX_ANNOTATION_STROKES),
}).strict().refine(value => value.strokes.reduce((count, stroke) => count + stroke.points.length, 0) <= MAX_ANNOTATION_POINTS,
  "Too many drawing points.");
export type ImageAnnotation = z.infer<typeof ImageAnnotationSchema>;

export const SaveImageAnnotationSchema = z.object({
  sourceImageId: z.string().uuid().transform(value => value.toLowerCase()),
  conversationId: z.string().uuid().transform(value => value.toLowerCase()),
  clientRequestId: z.string().trim().min(1).max(120),
  annotation: ImageAnnotationSchema,
}).strict();
