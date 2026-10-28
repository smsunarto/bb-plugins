// Plain-markdown version of a reply for places that show message text without
// running the UI: the CLI, SDK consumers and other agents. ```ui blocks become
// their static markdown rendering (ChatGPT keeps a `fallbackMarkdown` beside
// every UI for the same reason); ```app blocks become a one-line pointer.
// Image searches and Map places' Wikipedia photos are resolved first, when a
// finder is given, so the markdown shows the photos the UI would.
import {
  collectLoads,
  compile,
  compileStreaming,
  dataKey,
  evaluate,
  formatDiagnostics,
  imageSearches,
  initialState,
  probeInteractions,
  specToMarkdown,
  type DataRequest,
  type LoadedData,
  type SearchedImage,
  wikiPhotos,
} from "./core";
import { checkShader } from "./core/glsl-check";
import { projectRequests, toMarkdownWithProject } from "./core/markdown";
import { projectRequestKey, type ProjectRequest, type ProjectResult } from "./core/project";
import { readScene, sceneAssets } from "./core/scene";
import { shaderInputNames, shaderPasses } from "./core/shader-args";
import type { UiNode, Value } from "./core/types";

/** Fetches one file a spec reads: parsed for Load, raw text for Snippet. */
type Loader = (request: DataRequest) => Promise<LoadedData>;

/** Finds the photos a rendering shows, or null (nothing found, or web lookups off). */
interface ImageFinder {
  /** An image search's photo (ImageSearch, Gallery `{query}`). */
  search(query: string): Promise<SearchedImage | null>;
  /** A Wikipedia article's lead photo (Map places' `wiki`). */
  photo(title: string): Promise<SearchedImage | null>;
}

/** Reads the reply's thread's state from BB for Changes, Commits, PullRequest, Threads and Environments. */
export type ProjectReader = (request: ProjectRequest) => Promise<ProjectResult>;

async function findAll(keys: readonly string[], find: (key: string) => Promise<SearchedImage | null>): Promise<Map<string, SearchedImage | null>> {
  return new Map(await Promise.all(keys.map(async (key) => [key, await find(key)] as const)));
}

/** `roots` as markdown, with image searches, Wikipedia photos and BB reads resolved. */
async function rootsMarkdown(roots: readonly UiNode[], find: ImageFinder | undefined, project: ProjectReader | undefined): Promise<string> {
  const requests = project === undefined ? [] : projectRequests(roots);
  const [images, photos, answers] = await Promise.all([
    find === undefined ? new Map() : findAll(imageSearches(roots), (query) => find.search(query)),
    find === undefined ? new Map() : findAll(wikiPhotos(roots), (title) => find.photo(title)),
    Promise.all(requests.map(async (request) => [projectRequestKey(request), await project!(request)] as const)),
  ]);
  return toMarkdownWithProject(roots, images, new Map(answers), photos);
}

interface Fence {
  /** Line indexes of the opening and closing fence lines. */
  open: number;
  close: number;
  language: string;
  body: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/;

/** Top-level fenced blocks, matching CommonMark's closing rule (same character, at least as long). */
function findFences(lines: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index] ?? "");
    if (open === null) continue;
    const marker = open[1] ?? "```";
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let close = index + 1;
    while (close < lines.length && !closing.test(lines[close] ?? "")) close++;
    fences.push({
      open: index,
      close,
      language: (open[2] ?? "").toLowerCase(),
      body: lines.slice(index + 1, close).join("\n"),
    });
    index = close;
  }
  return fences;
}

function appPointer(html: string): string {
  const title = /<title>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim();
  return `_Interactive app${title ? `: ${title}` : ""}. Open this reply in BB to use it._`;
}

async function uiMarkdown(spec: string, load: Loader, find: ImageFinder | undefined, project: ProjectReader | undefined): Promise<string> {
  const { program } = compileStreaming(spec);
  const requests = program === null ? [] : collectLoads(program);
  const data = new Map(await Promise.all(requests.map(async (request) => [dataKey(request), await load(request)] as const)));
  const compiled = compile(spec);
  // A spec that doesn't compile comes back as its source in a fence.
  if (compiled.program === null) return specToMarkdown(spec, data);
  const { roots } = evaluate(compiled.program, initialState(compiled.program, data), data);
  return rootsMarkdown(roots, find, project);
}

/** The reply with every ```ui and ```app block replaced by readable markdown. */
export async function renderReplyMarkdown(text: string, load: Loader, find?: ImageFinder, project?: ProjectReader): Promise<string> {
  const lines = text.split("\n");
  const fences = findFences(lines).filter((fence) => fence.language === "ui" || fence.language === "app");
  if (fences.length === 0) return text;
  const output: string[] = [];
  let next = 0;
  for (const fence of fences) {
    output.push(...lines.slice(next, fence.open));
    output.push(fence.language === "app" ? appPointer(fence.body) : await uiMarkdown(fence.body, load, find, project));
    next = fence.close + 1;
  }
  output.push(...lines.slice(next));
  return output.join("\n");
}

/** A Scene is read again at this time, so a scene that breaks once it moves is caught too (t = 0 is the evaluation's). */
const SCENE_CHECK_TIME = 1.5;

/** The largest 3D asset the renderer loads (load_asset). */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** Every Scene and Shader node in `roots`, children included. */
function gpuNodes(value: Value | readonly UiNode[], out: UiNode[] = []): UiNode[] {
  if (Array.isArray(value)) {
    for (const item of value) gpuNodes(item, out);
  } else if (typeof value === "object" && value !== null && "kind" in value && value.kind === "node") {
    const node = value as UiNode;
    if (node.type === "Scene" || node.type === "Shader") out.push(node);
    for (const prop of Object.values(node.props)) gpuNodes(prop, out);
  }
  return out;
}

/**
 * What a raw read says about a 3D asset: a binary file comes back "not a
 * text file" and a big one over the data limit, yet both exist and the
 * renderer's own loader reads them. Anything else is the reason it can't.
 */
function assetProblem(result: LoadedData): string | null {
  if (result.ok || result.error === "not a text file") return null;
  const bytes = /^(\d+) bytes is over the/.exec(result.error)?.[1];
  if (bytes === undefined) return result.error;
  return Number(bytes) > MAX_ASSET_BYTES ? `${bytes} bytes is over the ${MAX_ASSET_BYTES}-byte limit` : null;
}

/** GLSL errors, a Scene that fails once it moves, and asset files Scene and Shader can't read: `line:column error: …`, as diagnostics read. */
async function gpuProblems(roots: readonly UiNode[], load: Loader): Promise<string[]> {
  const problems = new Set<string>();
  const assets = new Map<string, string>();
  for (const node of gpuNodes(roots)) {
    const at = /^\d+:\d+/.exec(node.key)?.[0] ?? "1:1";
    if (node.type === "Scene") {
      const later = readScene(node.props.objects ?? null, SCENE_CHECK_TIME);
      for (const error of later.errors) problems.add(`${at} error: Scene at t=${SCENE_CHECK_TIME}: ${error}`);
      const paths = [...sceneAssets(readScene(node.props.objects ?? null, 0).objects), ...sceneAssets(later.objects)];
      for (const path of paths) if (!assets.has(path)) assets.set(path, at);
    } else {
      const textures = Array.isArray(node.props.textures) ? node.props.textures : [];
      for (const error of checkShader(shaderPasses(node.props), shaderInputNames(node.props), textures.length)) {
        problems.add(`${at} error: Shader: ${error}`);
      }
      for (const path of textures) if (typeof path === "string" && !assets.has(path)) assets.set(path, at);
    }
  }
  const read = await Promise.all([...assets].map(async ([path, at]) => [path, at, assetProblem(await load({ path, raw: true }))] as const));
  for (const [path, at, problem] of read) if (problem !== null) problems.add(`${at} error: ${path}: ${problem}`);
  return [...problems];
}

/**
 * What the check_ui tool tells the agent about one ```ui block: why it fails
 * to compile, which files Load and Snippet can't read, evaluation errors, the
 * errors its inputs cause once used (each slider end, toggle, option...),
 * shader GLSL errors, a Scene that fails once it moves, unreadable 3D asset
 * files, and otherwise the text version of what the user will see.
 */
export async function checkSpec(
  spec: string,
  load: Loader,
  find?: ImageFinder,
  project?: ProjectReader,
): Promise<{ readonly ok: boolean; readonly report: string }> {
  const compiled = compile(spec);
  if (compiled.program === null) {
    return { ok: false, report: `The block does not compile:\n${formatDiagnostics(compiled.diagnostics)}` };
  }
  const requests = collectLoads(compiled.program);
  const loaded = await Promise.all(requests.map(async (request) => [request, await load(request)] as const));
  const data = new Map(loaded.map(([request, result]) => [dataKey(request), result] as const));
  const state = initialState(compiled.program, data);
  const initial = evaluate(compiled.program, state, data);
  const { roots, diagnostics } = initial;
  const probed = probeInteractions(compiled.program, state, initial, data);
  const problems = [
    ...loaded.flatMap(([request, result]) => (result.ok ? [] : [`${request.path}: ${result.error}`])),
    ...(diagnostics.length > 0 ? [formatDiagnostics(diagnostics)] : []),
    ...(await gpuProblems(roots, load)),
    ...probed.failures.map(({ probe, diagnostics }) => `After ${probe.describe}:\n${formatDiagnostics(diagnostics)}`),
  ];
  const tried = probed.tried === 0 ? "" : ` Tried ${probed.tried} interaction${probed.tried === 1 ? "" : "s"}.`;
  const preview = `Text version of what the user will see:\n\n${await rootsMarkdown(roots, find, project)}`;
  return problems.length === 0
    ? { ok: true, report: `No errors.${tried} ${preview}` }
    : { ok: false, report: `Fix before replying:\n${problems.join("\n")}\n\n${preview}` };
}
