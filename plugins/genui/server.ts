import videoPlayerSource, { VIDEO_PLAYER_ETAG } from "@bb-plugins/video-player";
import { previewThreadVideo, checkThreadVideo } from "./video-source";
// Local fork: tool descriptions are loaded from instructions/tools/.
import { instructionFiles } from "@bb-plugins/instructions";
// bb-plugin-genui backend. Agents write ```ui and ```app blocks straight into
// their replies, so a UI costs no extra model call. The backend:
// - decides which sessions are told about the blocks, in three sections: the
//   language reference (the instructions of the optional check_ui and
//   ui_examples tools, which let an agent verify a block or see working
//   examples first) and the rules with worked examples (configure instructions),
// - loads the files specs reference with Load(path) and Snippet(path), and
//   the images Image(path) shows,
// - renders replies as plain markdown for clients that don't run the UI
//   (`bb genui render`, the `render_markdown` RPC),
// - serves UIs stored by the retired show_ui pilot tool,
// - does the plugin's only web lookups (web/lookups.ts), behind the
//   `webLookups` setting: photo search, geocoding, map tiles, https images,
// - reads the reply's own thread's state from BB (project/source.ts) for
//   Changes, Commits, PullRequest and Threads, and keeps what Changes and
//   Commits first showed per reply block; and its project's environments
//   (project/environments.ts) for Environments,
// - declares the `animations` setting, which only the page reads.
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  listGallery,
  loadGalleryAsset,
  loadGalleryAudio,
  loadGalleryVideo,
  loadGalleryFile,
  loadGalleryImage,
  loadThreadAsset,
  loadThreadAudio,
  loadThreadFile,
  loadThreadImage,
  readGallerySpec,
  sketchFontDataUrl,
} from "./data-source";
import { checkApp, MAX_APP_CHARS } from "./core/appLint";
import { checkSpec, renderReplyMarkdown } from "./fallback";
import type { Value } from "./core/types";
import {
  MAX_PATH_FILTERS,
  MAX_THREAD_IDS,
  parseChangesTarget,
  parsePathFilter,
  type ChangesResult,
  type CommitsResult,
  type PatchesResult,
  type ProjectFailure,
  type PullRequestResult,
  type ThreadsResult,
  type EnvironmentsResult,
} from "./core/project";
import { examplesReport } from "./examples";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_WEB_OFF,
  CODE_WORK_INSTRUCTIONS,
  UI_REFERENCE,
  UI_REFERENCE_MORE,
} from "./instructions";
import { foundImageSchema, wikiPhotoSchema } from "./web/commons";
import { locatedSchema } from "./web/geocode";
import { createWebLookups, MAX_TILE_ZOOM } from "./web/lookups";
import { createProjectSource, projectReader } from "./project/source";
import { createEnvironmentsSource } from "./project/environments";
import type { EnvironmentDetailResult } from "./core/environments";

const instructionText = instructionFiles(import.meta.url);

const UI_ID = /^[a-z0-9]{10}$/;

/** Thread ids kept for the code-work instruction section (see configure). */
const MAX_PERSON_THREADS = 10_000;

/** Declared here so BB lists it; the page reads it (ui/components/motion.ts). */
export const MOTION_SETTINGS = {
  animations: {
    type: "boolean",
    label: "Animations",
    description:
      "Lets inline UI move: text fades in, rows and cards rise into place, charts draw, sections glide open, maps and carousels scroll smoothly, and 3D scenes and shaders play. Off, nothing moves: everything appears at once, transitions are instant, and 3D scenes and shaders hold a still frame. The system's reduced-motion setting is honoured either way. Sandboxed apps keep their own motion.",
    default: true,
  },
} as const;

const storedUiSchema = z.object({ source: z.string() });

// parseDataFile builds the value from JSON/CSV text and rejects anything
// posing as an interpreter value, so it is plain data on the wire.
const loadedData = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.custom<Value>() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const loadedImage = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), dataUrl: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const filePath = z.string().min(1).max(1024);

// Project components: the thread is the one whose reply holds the UI;
// `blockKey` (null in the gallery) keeps what Changes and Commits first showed.
const projectThread = z.string().min(1).max(64);
const blockKey = z.string().min(1).max(512).nullable();

/** A web lookup that didn't happen; `off` when the webLookups setting is off. */
const webFailure = z.object({
  ok: z.literal(false),
  error: z.string(),
  off: z.boolean().optional(),
});
const webImage = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), dataUrl: z.string() }),
  webFailure,
]);

export const rpcContract = defineRpcContract({
  get_ui: {
    input: z.object({ id: z.string().regex(UI_ID) }),
    output: z.object({ source: z.string() }),
  },
  load_data: {
    // `raw` (Snippet) returns the file's text unparsed.
    input: z.object({ threadId: z.string().min(1), path: filePath, raw: z.boolean().optional() }),
    output: loadedData,
  },
  load_image: {
    input: z.object({ threadId: z.string().min(1), path: filePath }),
    output: loadedImage,
  },
  // Same-origin SDK preview leases stream thread videos with range requests.
  load_video: {
    input: z.object({ threadId: z.string().min(1), path: filePath, renew: z.boolean().optional() }),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        url: z.string(),
        expiresAtMs: z.number(),
        owned: z.literal(false),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  // A recording a Transcript plays (25 MB cap), as a data URL.
  load_audio: {
    input: z.object({ threadId: z.string().min(1), path: filePath }),
    output: loadedImage,
  },
  // A file a Scene loads (glb, gltf, hdr, png, jpg, webp; 10 MB cap), as a data URL the client decodes to bytes.
  load_asset: {
    input: z.object({ threadId: z.string().min(1), path: filePath }),
    output: loadedImage,
  },
  render_markdown: {
    input: z.object({ threadId: z.string().min(1), text: z.string() }),
    output: z.object({ markdown: z.string() }),
  },
  // The UI gallery page: example specs in gallery/, which load files from gallery/.
  gallery_list: {
    input: z.object({}),
    output: z.object({ names: z.array(z.string()) }),
  },
  gallery_get: {
    input: z.object({ name: z.string().min(1).max(200) }),
    output: z.object({ source: z.string() }),
  },
  gallery_data: {
    input: z.object({ path: filePath, raw: z.boolean().optional() }),
    output: loadedData,
  },
  gallery_image: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  gallery_video: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  gallery_audio: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  gallery_asset: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  // Excalifont for Excalidraw-style diagrams (Diagram), as a data URL.
  sketch_font: {
    input: z.object({}),
    output: z.object({ dataUrl: z.string() }),
  },
  // Web lookups (web/lookups.ts); each answers with a failure value when webLookups is off.
  web_image: {
    input: z.object({ url: z.string().min(1).max(2048) }),
    output: webImage,
  },
  web_search: {
    input: z.object({ query: z.string().min(1).max(200) }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), image: foundImageSchema }),
      webFailure,
    ]),
  },
  web_photo: {
    input: z.object({ title: z.string().min(1).max(200) }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), photo: wikiPhotoSchema }),
      webFailure,
    ]),
  },
  web_geocode: {
    input: z.object({ name: z.string().min(1).max(200), near: locatedSchema.nullable() }),
    output: z.discriminatedUnion("ok", [locatedSchema.extend({ ok: z.literal(true) }), webFailure]),
  },
  web_tile: {
    input: z.object({
      z: z.number().int().min(0).max(MAX_TILE_ZOOM),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
    }),
    output: webImage,
  },
  project_changes: {
    input: z.object({
      threadId: projectThread,
      target: z.string().max(64).nullable(),
      paths: z.array(z.string().max(1024)).max(MAX_PATH_FILTERS).nullable(),
      blockKey,
      refresh: z.boolean(),
    }),
    output: z.custom<ChangesResult>(),
  },
  project_patches: {
    input: z.object({
      threadId: projectThread,
      target: z.string().max(64).nullable(),
      paths: z.array(filePath).min(1).max(25),
    }),
    output: z.custom<PatchesResult>(),
  },
  project_commits: {
    input: z.object({ threadId: projectThread, blockKey, refresh: z.boolean() }),
    output: z.custom<CommitsResult>(),
  },
  project_pull_request: {
    input: z.object({ threadId: projectThread }),
    output: z.custom<PullRequestResult>(),
  },
  project_threads: {
    input: z.object({
      threadId: projectThread,
      ids: z.array(z.string().max(64)).max(MAX_THREAD_IDS).nullable(),
    }),
    output: z.custom<ThreadsResult>(),
  },
  // Environments: the list with threads first; each environment's git status and pull request on request.
  project_environments: {
    input: z.object({ threadId: projectThread }),
    output: z.custom<EnvironmentsResult>(),
  },
  project_environment: {
    input: z.object({ threadId: projectThread, environmentId: z.string().min(1).max(64) }),
    output: z.custom<EnvironmentDetailResult>(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const web = createWebLookups(bb);
  bb.settings.define(MOTION_SETTINGS);
  /** Image searches and Wikipedia photos (Map places) for markdown renderings: the photo found, or null (none, or lookups off). */
  const findImage = {
    search: async (query: string) => {
      const found = await web.search(query);
      return found.ok ? found.image : null;
    },
    photo: async (title: string) => {
      const found = await web.photo(title);
      return found.ok ? found.photo : null;
    },
  };
  const project = createProjectSource(bb);
  const environments = createEnvironmentsSource(bb.sdk);

  bb.agents.registerTool({
    name: "check_ui",
    description: instructionText.read("tools/check_ui"),
    instructions: UI_REFERENCE,
    parameters: z.object({
      // A ```ui spec has its own, smaller cap, which compile reports.
      spec: z
        .string()
        .min(1)
        .max(MAX_APP_CHARS)
        .describe("The block's content, without the ``` fence lines"),
      language: z
        .enum(["ui", "app"])
        .optional()
        .describe(
          'The fence\'s language; default "app" when the content starts with "<", else "ui"',
        ),
    }),
    presentation: { label: { pending: "Checking UI", completed: "Checked UI" }, suppress: true },
    async execute({ spec, language }, ctx) {
      const { ok, report } =
        (language ?? (spec.trimStart().startsWith("<") ? "app" : "ui")) === "app"
          ? checkApp(spec)
          : await checkSpec(
              spec,
              (request) => loadThreadFile(bb, ctx.threadId, request.path, request),
              findImage,
              projectReader(project, environments, ctx.threadId),
              (path) => loadThreadImage(bb, ctx.threadId, path),
              (path) => checkThreadVideo(bb, ctx.threadId, path),
            );
      return { content: [{ type: "text", text: report }], isError: !ok };
    },
  });

  bb.agents.registerTool({
    name: "ui_examples",
    description: instructionText.read("tools/ui_examples"),
    instructions: UI_REFERENCE_MORE,
    parameters: z.object({
      components: z
        .array(z.string().min(1).max(40))
        .min(1)
        .max(6)
        .describe('Component names, e.g. ["Map", "Chart"]'),
    }),
    presentation: {
      label: { pending: "Reading UI examples", completed: "Read UI examples" },
      suppress: true,
    },
    async execute({ components }) {
      const { ok, text } = await examplesReport(components);
      return { content: [{ type: "text", text }], isError: !ok };
    },
  });

  // Threads configure last found to have a person reading their replies. BB
  // resolves configure before it asks instruction contributors, within the
  // same session resolution, so the code-work section below reaches exactly
  // the sessions that get the other three. Bounded; oldest forgotten first.
  const personThreads = new Set<string>();
  bb.agents.configure((context) => {
    // Only sessions whose replies a person reads in chat: not threads another
    // agent spawned (their reply goes back to that agent) and not threads a
    // plugin runs (workflows, automations), except the user's side chats and
    // the subthreads `bb genui ask` opens to try a prompt.
    const forPerson =
      context.pluginMetadata.audience === "person" ||
      (context.thread.parentThreadId === null &&
        (context.origin.pluginId === null || context.origin.pluginId === "side-chat"));
    personThreads.delete(context.thread.id);
    if (!forPerson) return { tools: [], skills: [] };
    personThreads.add(context.thread.id);
    if (personThreads.size > MAX_PERSON_THREADS)
      personThreads.delete(personThreads.values().next().value!);
    const instructions = web.isOn() ? AGENT_INSTRUCTIONS : AGENT_INSTRUCTIONS_WEB_OFF;
    return { tools: ["check_ui", "ui_examples"], skills: [], instructions };
  });
  bb.agents.contributeInstructions(({ threadId }) =>
    personThreads.has(threadId) ? CODE_WORK_INSTRUCTIONS : null,
  );

  bb.http.route("GET", "/video-player.js", (context) => {
    const headers = { etag: VIDEO_PLAYER_ETAG, "cache-control": "no-cache" };
    if (context.req.header("if-none-match") === VIDEO_PLAYER_ETAG)
      return new Response(null, { status: 304, headers });
    return new Response(videoPlayerSource, {
      headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
    });
  });

  bb.rpc.register(rpcContract, {
    async get_ui({ id }) {
      const parsed = storedUiSchema.safeParse(await bb.storage.kv.get(`ui:${id}`));
      if (!parsed.success) throw new Error(`UI ${id} not found`);
      return { source: parsed.data.source };
    },
    load_data: ({ threadId, path, raw }) => loadThreadFile(bb, threadId, path, { raw }),
    load_image: ({ threadId, path }) => loadThreadImage(bb, threadId, path),
    load_video: ({ threadId, path, renew }) => previewThreadVideo(bb, threadId, path, renew),
    load_audio: ({ threadId, path }) => loadThreadAudio(bb, threadId, path),
    load_asset: ({ threadId, path }) => loadThreadAsset(bb, threadId, path),
    async render_markdown({ threadId, text }) {
      const markdown = await renderReplyMarkdown(
        text,
        (request) => loadThreadFile(bb, threadId, request.path, request),
        findImage,
        projectReader(project, environments, threadId),
      );
      return { markdown };
    },
    gallery_list: async () => ({ names: await listGallery() }),
    gallery_get: async ({ name }) => ({ source: await readGallerySpec(name) }),
    gallery_data: ({ path, raw }) => loadGalleryFile(path, { raw }),
    gallery_image: ({ path }) => loadGalleryImage(path),
    gallery_video: ({ path }) => loadGalleryVideo(path),
    gallery_audio: ({ path }) => loadGalleryAudio(path),
    gallery_asset: ({ path }) => loadGalleryAsset(path),
    sketch_font: async () => ({ dataUrl: await sketchFontDataUrl() }),
    web_image: ({ url }) => web.image(url),
    web_search: ({ query }) => web.search(query),
    web_photo: ({ title }) => web.photo(title),
    web_geocode: ({ name, near }) => web.geocode(name, near),
    web_tile: ({ z: zoom, x, y }) => web.tile(zoom, x, y),
    async project_changes({ threadId, target, paths, blockKey: block, refresh }) {
      const parsedTarget = parseChangesTarget(target);
      if (!parsedTarget.ok) return invalid(parsedTarget.error);
      const parsedPaths = parsePathFilter(paths);
      if (!parsedPaths.ok) return invalid(parsedPaths.error);
      return project.changes(
        threadId,
        parsedTarget.value,
        parsedPaths.value,
        block === null ? null : { blockKey: block, refresh },
      );
    },
    async project_patches({ threadId, target, paths }) {
      const parsedTarget = parseChangesTarget(target);
      if (!parsedTarget.ok) return invalid(parsedTarget.error);
      return project.patches(threadId, parsedTarget.value, paths);
    },
    project_commits: ({ threadId, blockKey: block, refresh }) =>
      project.commits(threadId, block === null ? null : { blockKey: block, refresh }),
    project_pull_request: ({ threadId }) => project.pullRequest(threadId),
    project_threads: ({ threadId, ids }) => project.threads(threadId, ids),
    project_environments: ({ threadId }) => environments.environments(threadId, false),
    project_environment: ({ threadId, environmentId }) =>
      environments.environment(threadId, environmentId),
  });

  bb.cli.register(
    defineCli({
      name: "genui",
      summary: "Read replies that contain inline UI as plain markdown",
      commands: {
        ask: cliCommand({
          summary:
            "Try a prompt in a subthread of this thread whose agent gets the inline UI instructions",
          description:
            "The subthread is deleted with this thread. Wait for it with `bb thread wait <id>` and read it with `bb genui render <id>` or in BB.",
          options: {
            model: { type: "string", description: "Model ID; omitted, the project's default" },
            provider: {
              type: "string",
              description: "Provider ID; omitted, the project's remembered provider",
            },
            title: { type: "string", description: "Subthread title" },
          },
          positionals: [{ name: "prompt", description: "The message to send", required: true }],
          async run(input, ctx) {
            const parentId = ctx.threadId;
            if (parentId === undefined) {
              throw new PluginCliError("ask runs inside a thread", {
                code: "thread_required",
                hint: "Run it from an agent's shell in BB, where BB_THREAD_ID is set",
              });
            }
            const parent = await bb.sdk.threads.get({ threadId: parentId });
            const thread = await bb.sdk.threads.spawn({
              projectId: parent.projectId,
              environment:
                parent.environmentId === null
                  ? { type: "project-default" }
                  : { type: "reuse", environmentId: parent.environmentId },
              parentThreadId: parentId,
              lifecycleOwnerThreadId: parentId,
              prompt: input.positionals.prompt,
              title: input.options.title,
              providerId: input.options.provider,
              model: input.options.model,
              pluginMetadata: { audience: "person" },
            });
            return { exitCode: 0, stdout: `${thread.id}\n` };
          },
        }),
        render: cliCommand({
          summary: "Print a thread's last reply with its ui and app blocks rendered as markdown",
          positionals: [
            {
              name: "thread",
              description: "Thread ID; defaults to the thread running the command",
            },
          ],
          async run(input, ctx) {
            const threadId = input.positionals.thread ?? ctx.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("no thread to render", {
                code: "thread_required",
                hint: "Pass a thread ID: bb genui render thr_…",
              });
            }
            const { output } = await bb.sdk.threads.output({ threadId });
            if (output === null) {
              throw new PluginCliError(`thread ${threadId} has no completed reply yet`, {
                code: "no_output",
              });
            }
            const markdown = await renderReplyMarkdown(
              output,
              (request) => loadThreadFile(bb, threadId, request.path, request),
              findImage,
              projectReader(project, environments, threadId),
            );
            return { exitCode: 0, stdout: `${markdown}\n` };
          },
        }),
      },
    }),
  );
}

function invalid(message: string): ProjectFailure {
  return { ok: false, reason: "invalid", message };
}
