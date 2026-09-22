import { z } from "zod";

const imageAnnotationSchema = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    label: z.string().trim().min(1).max(500),
    side: z.enum(["before", "after", "both"]).default("both"),
  })
  .strict();

export type ImageAnnotation = z.infer<typeof imageAnnotationSchema>;

export function parseImageAnnotations(value: string | undefined): ImageAnnotation[] {
  if (value === undefined) return [];
  try {
    return z
      .array(imageAnnotationSchema)
      .max(50)
      .refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length)
      .parse(JSON.parse(value));
  } catch {
    throw new Error(
      "Annotations must be a JSON array of up to 50 unique {x, y, label, side} callouts. Coordinates are percentages from 0 to 100; side is before, after, or both.",
    );
  }
}
