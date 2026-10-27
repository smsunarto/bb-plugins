import { isUnityMeta, unityYamlKind } from "@bb-plugins/unity-inspector/model";

/*
 * Which files the Changes tab can show as more than text, by extension. The
 * server reads the same table for the content type it serves a file with.
 * Browser-safe.
 */

/** Images a browser draws itself. */
const NATIVE_IMAGES: Readonly<Record<string, string>> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** Images decoded in the page, since no browser draws them. Common in game art. */
export const DECODED_IMAGES = ["tga", "tif", "tiff", "exr", "hdr", "psd"] as const;
export type DecodedImage = (typeof DECODED_IMAGES)[number];

export const MODEL_FORMATS = ["glb", "gltf", "fbx", "obj", "stl", "ply", "dae", "3mf"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

const AUDIO: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
};

const VIDEO: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

const FONTS: Readonly<Record<string, string>> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

const MODEL_TYPES: Readonly<Record<ModelFormat, string>> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  fbx: "application/octet-stream",
  obj: "model/obj",
  stl: "model/stl",
  ply: "application/octet-stream",
  dae: "model/vnd.collada+xml",
  "3mf": "model/3mf",
};

export type Preview =
  | { kind: "image"; format: string; decoded: DecodedImage | null }
  | { kind: "model"; format: ModelFormat }
  | { kind: "audio"; format: string }
  | { kind: "video"; format: string }
  | { kind: "font"; format: string }
  /** A Unity YAML asset: a scene, prefab, material, … `label` names its type. */
  | { kind: "unity"; label: string }
  | { kind: "unity-meta" };

export function extensionOf(path: string): string {
  return /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
}

/** How a file can be shown beyond its text diff, or null when its text diff is all there is. */
export function previewOf(path: string): Preview | null {
  const format = extensionOf(path);
  if (format in NATIVE_IMAGES) return { kind: "image", format, decoded: null };
  if ((DECODED_IMAGES as readonly string[]).includes(format)) {
    return { kind: "image", format, decoded: format as DecodedImage };
  }
  if ((MODEL_FORMATS as readonly string[]).includes(format)) {
    return { kind: "model", format: format as ModelFormat };
  }
  if (format in AUDIO) return { kind: "audio", format };
  if (format in VIDEO) return { kind: "video", format };
  if (format in FONTS) return { kind: "font", format };
  if (isUnityMeta(path)) return { kind: "unity-meta" };
  const label = unityYamlKind(path);
  if (label) return { kind: "unity", label };
  return null;
}

/** The content type a file is served with. Anything unknown is opaque bytes. */
export function contentTypeOf(path: string): string {
  const format = extensionOf(path);
  return (
    NATIVE_IMAGES[format] ??
    AUDIO[format] ??
    VIDEO[format] ??
    FONTS[format] ??
    MODEL_TYPES[format as ModelFormat] ??
    (previewOf(path)?.kind === "unity" || isUnityMeta(path) ? "text/plain; charset=utf-8" : null) ??
    "application/octet-stream"
  );
}

/** Whether the preview replaces a text diff (Unity assets) or stands where none can be drawn. */
export function isTextPreview(preview: Preview): boolean {
  return preview.kind === "unity" || preview.kind === "unity-meta";
}
