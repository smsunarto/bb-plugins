// Loads the files a spec references with Load(path) and Snippet(path), and
// the images Image(path) shows, so the model points at files instead of
// retyping them. Only the thread's own workspace, its thread storage and the
// host's /tmp (where agents and their tools write screenshots and reports)
// are readable: a spec is model output and must not reach arbitrary files on
// the host. Gallery specs (gallery/*.ui in this plugin) read from gallery/ only.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseDataFile, type LoadedData } from "./core";
import { THREAD_STORAGE_PREFIX } from "./core/file-target";

export const MAX_DATA_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** One way to read a requested file: the root BB confines the read to, and the path in it. */
interface Attempt {
  root: Root;
  target: string;
}

/**
 * The host's /tmp, where agents and their tools write screenshots and
 * reports. BB refuses a root that is a symlink, and macOS's /tmp is one (to
 * /private/tmp), so a /tmp path is read through /private/tmp first and as
 * written second (Linux, where /private/tmp doesn't exist).
 */
function tempAttempts(target: string, hostId: string): Attempt[] {
  if (contains("/private/tmp", target)) return [{ root: { path: "/private/tmp", hostId }, target }];
  if (!contains("/tmp", target)) return [];
  return [
    { root: { path: "/private/tmp", hostId }, target: path.join("/private", target) },
    { root: { path: "/tmp", hostId }, target },
  ];
}

/** Image types Image(path) may show, by extension; the MIME type is ours, not the file's claim. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

/** Audio types a Transcript may play, by extension; the MIME type is ours, not the file's claim. */
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  caf: "audio/x-caf",
};

/** A recording is bigger than a picture: about 13 minutes of 16 kHz mono WAV. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Files a Scene loads (models, environments, textures), by extension; the MIME type is ours. */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  hdr: "image/vnd.radiance",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** A model with its textures, or an HDR environment, is bigger than a picture. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export type LoadedImage = { readonly ok: true; readonly dataUrl: string } | { readonly ok: false; readonly error: string };

interface Root {
  path: string;
  hostId: string;
}

type FileContent = { ok: true; content: string; encoding: "utf8" | "base64" } | { ok: false; error: string };

/** Reads one requested path within its allowed roots; failures are values, never throws. */
type FileReader = (requested: string, maxBytes: number) => Promise<FileContent>;

function contains(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function threadRoots(bb: BbPluginApi, threadId: string): Promise<{ workspace: Root | null; storage: Root | null }> {
  const [thread, storage] = await Promise.all([
    bb.sdk.threads.get({ threadId, include: "environment" }),
    bb.sdk.threads.storageLocation({ threadId }).catch(() => null),
  ]);
  const environment = "environment" in thread ? thread.environment : null;
  return {
    workspace:
      typeof environment?.path === "string" && typeof environment.hostId === "string"
        ? { path: environment.path, hostId: environment.hostId }
        : null,
    storage: storage === null ? null : { path: storage.storageRootPath, hostId: storage.hostId },
  };
}

/** Reads one file of the thread's workspace, thread storage or /tmp; failures are values, never throws. */
async function readThreadFile(bb: BbPluginApi, threadId: string, requested: string, maxBytes: number): Promise<FileContent> {
  let roots: { workspace: Root | null; storage: Root | null };
  try {
    roots = await threadRoots(bb, threadId);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  // "$BB_THREAD_STORAGE/…" is the thread storage the agent writes artifacts
  // to; other relative paths are workspace paths; absolute paths must sit
  // inside one of the two or in /tmp on the environment's host.
  const inside = (root: Root | null, target: string): Attempt[] =>
    root !== null && contains(root.path, target) ? [{ root, target }] : [];
  let attempts: Attempt[];
  if (requested.startsWith(THREAD_STORAGE_PREFIX)) {
    const root = roots.storage;
    attempts = root === null ? [] : inside(root, path.resolve(root.path, requested.slice(THREAD_STORAGE_PREFIX.length)));
  } else if (path.isAbsolute(requested)) {
    const target = path.resolve(requested);
    const hostId = roots.workspace?.hostId ?? roots.storage?.hostId;
    attempts = [...inside(roots.storage, target), ...inside(roots.workspace, target)].slice(0, 1);
    if (attempts.length === 0 && hostId !== undefined) attempts = tempAttempts(target, hostId);
  } else {
    const root = roots.workspace;
    attempts = root === null ? [] : inside(root, path.resolve(root.path, requested));
  }
  if (attempts.length === 0) {
    return { ok: false, error: "only files in this thread's workspace, its thread storage or /tmp can be loaded" };
  }
  let first: FileContent | undefined;
  for (const attempt of attempts) {
    const file = await readInRoot(bb, attempt, maxBytes);
    if (file.ok) return file;
    first ??= file;
  }
  return first!;
}

async function readInRoot(bb: BbPluginApi, { root, target }: Attempt, maxBytes: number): Promise<FileContent> {
  try {
    const result = await bb.sdk.files.read({ path: target, rootPath: root.path, hostId: root.hostId });
    if (!("content" in result)) return { ok: false, error: "the file could not be read" };
    if (result.sizeBytes > maxBytes) {
      return { ok: false, error: `${result.sizeBytes} bytes is over the ${maxBytes}-byte limit` };
    }
    return { ok: true, content: result.content, encoding: result.contentEncoding };
  } catch (cause) {
    const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : null;
    return { ok: false, error: status === 404 ? "file not found" : cause instanceof Error ? cause.message : String(cause) };
  }
}

async function loadWith(read: FileReader, requested: string, raw: boolean): Promise<LoadedData> {
  const file = await read(requested, MAX_DATA_BYTES);
  if (!file.ok) return file;
  if (file.encoding !== "utf8") return { ok: false, error: "not a text file" };
  if (!raw) return parseDataFile(requested, file.content);
  return { ok: true, value: file.content.startsWith("\uFEFF") ? file.content.slice(1) : file.content };
}

/**
 * Reads an image or audio file as a data URL. Only `types` (by extension) are
 * read, typed by us rather than by the file's claim, up to `maxBytes`.
 */
async function loadMediaWith(
  read: FileReader,
  requested: string,
  types: Readonly<Record<string, string>>,
  maxBytes: number,
  noun: string,
): Promise<LoadedImage> {
  const extension = /\.([^./\\]+)$/.exec(requested)?.[1].toLowerCase();
  if (extension === undefined || !Object.hasOwn(types, extension)) {
    return { ok: false, error: `only ${Object.keys(types).join(", ")} ${noun} can be shown` };
  }
  const file = await read(requested, maxBytes);
  if (!file.ok) return file;
  // Binary files arrive base64-encoded; text formats such as SVG may arrive as UTF-8.
  const base64 = file.encoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64");
  return { ok: true, dataUrl: `data:${types[extension]};base64,${base64}` };
}

/**
 * Reads one Load(path) target for a thread, parsed by extension, or with
 * `raw` (Snippet) as its text unparsed. Failures are values, never throws.
 */
export function loadThreadFile(
  bb: BbPluginApi,
  threadId: string,
  requested: string,
  { raw = false }: { raw?: boolean } = {},
): Promise<LoadedData> {
  return loadWith((target, maxBytes) => readThreadFile(bb, threadId, target, maxBytes), requested, raw);
}

/** Reads one Image(path) file for a thread as a data URL. Failures are values, never throws. */
export function loadThreadImage(bb: BbPluginApi, threadId: string, requested: string): Promise<LoadedImage> {
  const read: FileReader = (target, maxBytes) => readThreadFile(bb, threadId, target, maxBytes);
  return loadMediaWith(read, requested, IMAGE_TYPES, MAX_IMAGE_BYTES, "images");
}

/** Reads one audio file for a thread (a Transcript's recording) as a data URL. Failures are values. */
export function loadThreadAudio(bb: BbPluginApi, threadId: string, requested: string): Promise<LoadedImage> {
  const read: FileReader = (target, maxBytes) => readThreadFile(bb, threadId, target, maxBytes);
  return loadMediaWith(read, requested, AUDIO_TYPES, MAX_AUDIO_BYTES, "recordings");
}

/** Reads one file a Scene names (a model, environment or texture) for a thread as a data URL. Failures are values. */
export function loadThreadAsset(bb: BbPluginApi, threadId: string, requested: string): Promise<LoadedImage> {
  const read: FileReader = (target, maxBytes) => readThreadFile(bb, threadId, target, maxBytes);
  return loadMediaWith(read, requested, ASSET_TYPES, MAX_ASSET_BYTES, "files");
}

/** A path in this plugin's package: the bundle runs from dist/, tests from the root. */
export function packagePath(...parts: string[]): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(path.basename(here) === "dist" ? path.dirname(here) : here, ...parts);
}

function galleryDir(): string {
  return packagePath("gallery");
}

let sketchFont: Promise<string> | null = null;

/** Excalifont (Latin) as a data URL, for Excalidraw-style diagrams; read once. */
export function sketchFontDataUrl(): Promise<string> {
  sketchFont ??= readFile(packagePath("assets", "fonts", "Excalifont-Regular-latin.woff2")).then(
    (bytes) => `data:font/woff2;base64,${bytes.toString("base64")}`,
  );
  return sketchFont;
}

const GALLERY_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ui$/;

/** The gallery's example specs, by file name. */
export async function listGallery(): Promise<string[]> {
  const entries = await readdir(galleryDir(), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && GALLERY_SPEC.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function readGallerySpec(name: string): Promise<string> {
  if (!GALLERY_SPEC.test(name)) throw new Error(`not a gallery spec: ${name}`);
  return readFile(path.join(galleryDir(), name), "utf8");
}

/** Gallery specs Load and show files relative to gallery/, and nothing outside it. */
async function readGalleryFile(requested: string, maxBytes: number): Promise<FileContent> {
  const root = galleryDir();
  const target = path.resolve(root, requested);
  if (path.isAbsolute(requested) || !contains(root, target)) {
    return { ok: false, error: "gallery specs can only load files in gallery/" };
  }
  try {
    const { size } = await stat(target);
    if (size > maxBytes) return { ok: false, error: `${size} bytes is over the ${maxBytes}-byte limit` };
    const extension = /\.([^./\\]+)$/.exec(requested)?.[1].toLowerCase() ?? "";
    // Text formats (svg, an embedded .gltf) stay UTF-8; everything else is bytes, which UTF-8 would mangle.
    const binary =
      (Object.hasOwn(IMAGE_TYPES, extension) && extension !== "svg") ||
      Object.hasOwn(AUDIO_TYPES, extension) ||
      (Object.hasOwn(ASSET_TYPES, extension) && extension !== "gltf");
    const content = await readFile(target);
    return binary
      ? { ok: true, content: content.toString("base64"), encoding: "base64" }
      : { ok: true, content: content.toString("utf8"), encoding: "utf8" };
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
    return { ok: false, error: code === "ENOENT" ? "file not found" : cause instanceof Error ? cause.message : String(cause) };
  }
}

export function loadGalleryFile(requested: string, { raw = false }: { raw?: boolean } = {}): Promise<LoadedData> {
  return loadWith(readGalleryFile, requested, raw);
}

export function loadGalleryImage(requested: string): Promise<LoadedImage> {
  return loadMediaWith(readGalleryFile, requested, IMAGE_TYPES, MAX_IMAGE_BYTES, "images");
}

export function loadGalleryAudio(requested: string): Promise<LoadedImage> {
  return loadMediaWith(readGalleryFile, requested, AUDIO_TYPES, MAX_AUDIO_BYTES, "recordings");
}

export function loadGalleryAsset(requested: string): Promise<LoadedImage> {
  return loadMediaWith(readGalleryFile, requested, ASSET_TYPES, MAX_ASSET_BYTES, "files");
}
