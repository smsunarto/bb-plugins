import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BlobRequest } from "../../shared/blob-url.ts";
import { MAX_POINTER_BYTES, parseLfsPointer } from "../../shared/lfs.ts";
import {
  type BlobDescriptor,
  type Comparison,
  type ComparisonSide,
  type FileBlobs,
  type LfsObject,
  lfsObjectSchema,
} from "../../shared/schema.ts";
import { createCache } from "./cache.ts";
import type { GitHub } from "./gh.ts";
import { GITBUTLER_PLUGIN_ID } from "./gitbutler.ts";
import { startDeadline, timedOut, untilAborted } from "./deadline.ts";
import { createLimiter } from "./limiter.ts";

/*
 * Whole files at either side of a comparison, for previews: images, models,
 * Unity assets. A descriptor says what a side holds without reading it, and
 * content streams only on request. Pull requests read Git objects from
 * GitHub, and Git LFS objects from the repository's LFS store; unpublished
 * branches read both on their own machine, through the GitButler plugin.
 */

/** No preview reads a larger file, LFS or not. */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const DESCRIBE_MS = 20_000;
/** How long one read may take to start answering: an LFS object may download to its machine first. */
const CONTENT_MS = 150_000;
const CHUNK_BYTES = 4 * 1024 * 1024;

export class BlobError extends Error {
  readonly status: 400 | 404 | 413 | 415 | 416 | 502 | 503 | 504;
  constructor(status: BlobError["status"], message: string) {
    super(message);
    this.name = "BlobError";
    this.status = status;
  }
}

/** A side's descriptor, with the object id content is read by. Never sent to the app. */
type Described =
  | { kind: "missing" }
  | { kind: "blob"; oid: string; size: number; lfs: LfsObject | null }
  | { kind: "symlink"; target: string }
  | { kind: "submodule" };

/** Inclusive byte offsets, as an HTTP `Range` names them. */
export type ByteRange = { start: number; end: number };

/** The part of a file a request asks for: from an offset, or its last `suffix` bytes. */
export type RangeRequest = { start: number; end: number | null } | { suffix: number };

export type BlobContent = {
  /** The whole file's size: the object's, for an LFS file. */
  size: number;
  lfs: LfsObject | null;
  /** The part the body carries, or null for the whole file. */
  range: ByteRange | null;
  body: ReadableStream<Uint8Array>;
};

export type BlobReader = {
  /** Both sides of one changed file. The base side reads `previousPath` for a rename. */
  describe(
    comparison: Comparison,
    path: string,
    previousPath: string | null,
    signal: AbortSignal,
  ): Promise<FileBlobs>;
  open(
    request: BlobRequest,
    signal: AbortSignal,
    range?: RangeRequest | null,
  ): Promise<BlobContent>;
  /** A side's content as text, for Unity assets. Null when the side has no file. */
  text(request: BlobRequest, maxBytes: number, signal: AbortSignal): Promise<string | null>;
};

/**
 * One request to a file's source, in one of that source's slots and under a
 * deadline until it answers. A body streams on outside both, so a paused
 * video holds neither a slot nor a timer.
 */
type Run = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

type Source = {
  key: string;
  describe(
    sides: { base: string; head: string },
    signal: AbortSignal,
  ): Promise<Record<ComparisonSide, Described>>;
  content(
    side: ComparisonSide,
    blob: Extract<Described, { kind: "blob" }>,
    range: ByteRange,
    run: Run,
  ): Promise<ReadableStream<Uint8Array>>;
};

export function publicDescriptor(described: Described): BlobDescriptor {
  return described.kind === "blob"
    ? { kind: "blob", size: described.size, lfs: described.lfs }
    : described;
}

/** `body`, failing past `max` bytes. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > max) throw new BlobError(413, "That file is too large to preview.");
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        void reader.cancel().catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Bytes `start` through `end` of `body`, for a source that reads only from the start. */
function slice(
  body: ReadableStream<Uint8Array>,
  { start, end }: ByteRange,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const from = Math.max(0, start - at);
        const to = Math.min(value.byteLength, end + 1 - at);
        at += value.byteLength;
        if (to > from) controller.enqueue(value.subarray(from, to));
        if (at > end) {
          controller.close();
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (to > from) return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of body) {
    parts.push(part);
    length += part.byteLength;
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return all;
}

// ── GitHub ────────────────────────────────────────────────────────────────

const OBJECTS_QUERY = `query BlobSides($owner: String!, $name: String!, $base: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    base: object(expression: $base) { __typename ... on Blob { oid byteSize } }
    head: object(expression: $head) { __typename ... on Blob { oid byteSize } }
  }
}`;

const LFS_CONFIG_QUERY = `query LfsConfig($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) { ... on Blob { text } }
  }
}`;

type GqlObject = { __typename: string; oid?: string; byteSize?: number } | null;

const batchSchema = z.object({
  objects: z.array(
    z.object({
      oid: z.string(),
      error: z.object({ code: z.number(), message: z.string() }).optional(),
      actions: z
        .object({
          download: z
            .object({ href: z.url(), header: z.record(z.string(), z.string()).optional() })
            .optional(),
        })
        .optional(),
    }),
  ),
});

/** The LFS server a `.lfsconfig` names, if any. */
export function lfsConfigUrl(text: string): string | null {
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[\s*([^\]\s]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    const url = /^url\s*=\s*"?([^"\s]+)"?/i.exec(line)?.[1];
    if (section === "lfs" && url) return url;
  }
  return null;
}

function githubSource(
  comparison: Extract<Comparison, { kind: "github" }>,
  github: GitHub,
  fetcher: typeof fetch,
  mergeBases: ReturnType<typeof createCache<string>>,
): Source {
  const { account, owner, repo } = comparison;
  const gh = () => github.as(account);
  const repository = `${owner}/${repo}`;

  const rev = async (side: ComparisonSide) => {
    if (side === "head") return comparison.head;
    // GitHub diffs a pull request against the merge base, not the base branch's tip.
    return mergeBases.read(`${repository}\0${comparison.base}\0${comparison.head}`, async () => {
      const sha = (
        await gh().text([
          "api",
          `repos/${owner}/${repo}/compare/${comparison.base}...${comparison.head}`,
          "--jq",
          ".merge_base_commit.sha",
        ])
      ).trim();
      if (!/^[0-9a-f]{40}$/.test(sha))
        throw new BlobError(502, "GitHub did not name a merge base.");
      return sha;
    });
  };

  const api = async (path: string, signal: AbortSignal, accept: string) => {
    const response = await fetcher(`https://api.github.com/${path}`, {
      headers: {
        authorization: `Bearer ${await github.token(account)}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "bb-code-review",
      },
      signal,
    });
    if (response.ok && response.body) return response.body;
    if (response.status === 404) throw new BlobError(404, "GitHub has no such file.");
    if (response.status === 403 || response.status === 429) {
      throw new BlobError(503, "GitHub refused the read. Its rate limit may be spent.");
    }
    throw new BlobError(502, `GitHub answered ${response.status}.`);
  };
  const blob = (oid: string, signal: AbortSignal) =>
    api(`repos/${owner}/${repo}/git/blobs/${oid}`, signal, "application/vnd.github.raw+json");

  /** A side's descriptor, reading a small blob's text to tell a Git LFS pointer. */
  const described = async (object: GqlObject, signal: AbortSignal): Promise<Described> => {
    if (object === null) return { kind: "missing" };
    if (object.__typename === "Commit") return { kind: "submodule" };
    if (object.__typename !== "Blob" || !object.oid) return { kind: "missing" };
    const size = object.byteSize ?? 0;
    let lfs: LfsObject | null = null;
    if (size < MAX_POINTER_BYTES) {
      const text = new TextDecoder().decode(await readAll(await blob(object.oid, signal)));
      lfs = parseLfsPointer(text);
    }
    return { kind: "blob", oid: object.oid, size, lfs };
  };

  const lfsServer = async (side: ComparisonSide) => {
    const read = (await gh().graphql(LFS_CONFIG_QUERY, {
      owner,
      name: repo,
      expression: `${await rev(side)}:.lfsconfig`,
    })) as { repository: { object: { text?: string | null } | null } };
    const url = lfsConfigUrl(read.repository.object?.text ?? "");
    if (url && !/^https:\/\/github\.com\//i.test(url)) {
      const host = /^[a-z+]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url;
      throw new BlobError(
        502,
        `This repository keeps Git LFS files on ${host}, which previews cannot read.`,
      );
    }
  };

  /** The Git LFS batch API, asked of each repository that may hold the object. */
  const lfsObject = async (side: ComparisonSide, object: LfsObject, signal: AbortSignal) => {
    await lfsServer(side);
    const token = await github.token(account);
    const authorization = `Basic ${Buffer.from(`${account}:${token}`).toString("base64")}`;
    // A fork's pushes go to the fork's own store.
    const repositories = [
      ...new Set(
        side === "head" && comparison.headRepository
          ? [comparison.headRepository, repository]
          : [repository],
      ),
    ];
    let missing = "GitHub's Git LFS store does not have this file.";
    for (const name of repositories) {
      const response = await fetcher(`https://github.com/${name}.git/info/lfs/objects/batch`, {
        method: "POST",
        headers: {
          accept: "application/vnd.git-lfs+json",
          "content-type": "application/vnd.git-lfs+json",
          authorization,
          "user-agent": "bb-code-review",
        },
        body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: [object] }),
        signal,
      });
      if (response.status === 404) continue;
      if (!response.ok) throw new BlobError(502, `GitHub's Git LFS answered ${response.status}.`);
      const found = batchSchema
        .parse(await response.json())
        .objects.find((each) => each.oid === object.oid);
      const download = found?.actions?.download;
      if (!download) {
        missing = found?.error?.message ?? missing;
        continue;
      }
      const file = await fetcher(download.href, { headers: download.header ?? {}, signal });
      if (!file.ok || !file.body)
        throw new BlobError(502, `Git LFS storage answered ${file.status}.`);
      return file.body;
    }
    throw new BlobError(502, missing);
  };

  return {
    key: `github:${repository.toLowerCase()}`,
    async describe(paths, signal) {
      const [base, head] = await Promise.all([rev("base"), rev("head")]);
      const read = (await gh().graphql(
        OBJECTS_QUERY,
        { owner, name: repo, base: `${base}:${paths.base}`, head: `${head}:${paths.head}` },
        { optionalRoot: () => false },
      )) as { repository: { base: GqlObject; head: GqlObject } };
      const [baseSide, headSide] = await Promise.all([
        described(read.repository.base, signal),
        described(read.repository.head, signal),
      ]);
      return { base: baseSide, head: headSide };
    },
    async content(side, described, range, run) {
      const body = await run((signal) =>
        described.lfs ? lfsObject(side, described.lfs, signal) : blob(described.oid, signal),
      );
      const size = described.lfs?.size ?? described.size;
      return range.start === 0 && range.end === size - 1 ? body : slice(body, range);
    },
  };
}

// ── Local branches ───────────────────────────────────────────────────────

const hostDescriptor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({
    kind: z.literal("blob"),
    oid: z.string(),
    size: z.number(),
    lfs: z.object({ oid: z.string(), size: z.number() }).nullable(),
  }),
  z.object({ kind: z.literal("symlink"), target: z.string() }),
  z.object({ kind: z.literal("submodule") }),
]);
const hostDescriptors = z.object({ items: z.array(hostDescriptor) });
const hostChunk = z.object({ size: z.number(), content: z.string() });

function localSource(comparison: Extract<Comparison, { kind: "local" }>, bb: BbPluginApi): Source {
  const call = async <T>(
    method: string,
    input: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ) => {
    try {
      return await bb.sdk.plugins.callRpc({
        pluginId: GITBUTLER_PLUGIN_ID,
        method,
        input: input as never,
        outputSchema: schema,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BlobError(/not connected|offline/i.test(message) ? 503 : 502, message);
    }
  };
  return {
    key: `host:${comparison.hostId}`,
    async describe(paths, signal) {
      const read = await call(
        "branchBlobs",
        {
          hostId: comparison.hostId,
          path: comparison.path,
          items: [
            { rev: comparison.base, path: paths.base },
            { rev: comparison.head, path: paths.head },
          ],
        },
        hostDescriptors,
        signal,
      );
      const [base, head] = read.items.map((item): Described => {
        if (item.kind !== "blob") return item;
        // The host checked the oid too; it becomes a request here, so check again.
        const lfs =
          item.lfs && lfsObjectSchema.safeParse({ oid: item.lfs.oid, size: item.lfs.size });
        return {
          kind: "blob",
          oid: item.oid,
          size: item.size,
          lfs: lfs?.success ? lfs.data : null,
        };
      });
      if (!base || !head)
        throw new BlobError(502, "The GitButler plugin answered without both sides.");
      return { base, head };
    },
    async content(_side, described, range, run) {
      const object = described.lfs
        ? { kind: "lfs", oid: described.lfs.oid, size: described.lfs.size }
        : { kind: "git", oid: described.oid };
      let offset = range.start;
      const stop = range.end + 1;
      // A host call's result is capped, so the file arrives a range at a time.
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (offset >= stop) {
            controller.close();
            return;
          }
          const chunk = await run((signal) =>
            call(
              "branchBlobChunk",
              {
                hostId: comparison.hostId,
                path: comparison.path,
                object,
                offset,
                length: Math.min(CHUNK_BYTES, stop - offset),
              },
              hostChunk,
              signal,
            ),
          );
          const bytes = Buffer.from(chunk.content, "base64").subarray(0, stop - offset);
          if (bytes.byteLength === 0) {
            controller.error(new BlobError(502, "The file ended early."));
            return;
          }
          offset += bytes.byteLength;
          controller.enqueue(new Uint8Array(bytes));
        },
      });
    },
  };
}

// ── The reader ───────────────────────────────────────────────────────────

/** The bytes `asked` names in a file of `size`, or a 416 when it names none. */
function byteRange(asked: RangeRequest, size: number): ByteRange {
  const range =
    "suffix" in asked
      ? { start: Math.max(0, size - asked.suffix), end: size - 1 }
      : { start: asked.start, end: Math.min(asked.end ?? size - 1, size - 1) };
  if (
    size === 0 ||
    range.start >= size ||
    range.end < range.start ||
    ("suffix" in asked && asked.suffix === 0)
  ) {
    throw new BlobError(416, "That range is not in the file.");
  }
  return range;
}

export function createBlobReader({
  bb,
  github,
  fetch: fetcher = globalThis.fetch,
}: {
  bb: BbPluginApi;
  github: GitHub;
  fetch?: typeof fetch;
}): BlobReader {
  const limiter = createLimiter({ perKey: 3, total: 8 });
  const mergeBases = createCache<string>(256);
  // Pinned to commits, so a descriptor never goes stale.
  const descriptors = createCache<Record<ComparisonSide, Described>>(512);

  const source = (comparison: Comparison): Source =>
    comparison.kind === "github"
      ? githubSource(comparison, github, fetcher, mergeBases)
      : localSource(comparison, bb);

  const describeSides = (
    comparison: Comparison,
    paths: { base: string; head: string },
    signal: AbortSignal,
  ) => {
    const from = source(comparison);
    const shared = descriptors.read(JSON.stringify([comparison, paths]), async () => {
      // Every caller asking meanwhile shares this read, so it answers to its
      // own deadline, not to whichever caller asked first.
      const deadline = startDeadline(DESCRIBE_MS);
      let release: (() => void) | undefined;
      try {
        release = await limiter.acquire(from.key, deadline.signal);
        return await untilAborted(from.describe(paths, deadline.signal), deadline.signal);
      } catch (error) {
        if (timedOut(deadline.signal)) throw new BlobError(504, "Reading the file took too long.");
        throw error;
      } finally {
        release?.();
        deadline.lift();
      }
    });
    return untilAborted(shared, signal);
  };

  const runner =
    (key: string, signal: AbortSignal): Run =>
    async (work) => {
      const deadline = startDeadline(CONTENT_MS, signal);
      let release: (() => void) | undefined;
      try {
        release = await limiter.acquire(key, deadline.signal);
        return await untilAborted(work(deadline.signal), deadline.signal);
      } catch (error) {
        if (timedOut(deadline.signal)) throw new BlobError(504, "Reading the file took too long.");
        throw error;
      } finally {
        release?.();
        deadline.lift();
      }
    };

  /** The base side of a renamed file reads its old path; the app names that path itself. */
  const sideOf = async ({ comparison, side, path }: BlobRequest, signal: AbortSignal) => {
    const sides = await describeSides(comparison, { base: path, head: path }, signal);
    return sides[side];
  };

  const open = async (
    request: BlobRequest,
    signal: AbortSignal,
    asked: RangeRequest | null = null,
  ): Promise<BlobContent> => {
    const described = await sideOf(request, signal);
    if (described.kind === "missing") throw new BlobError(404, "The file is not in that commit.");
    if (described.kind !== "blob") {
      throw new BlobError(
        415,
        described.kind === "symlink" ? "The file is a symbolic link." : "The path is a submodule.",
      );
    }
    const size = described.lfs?.size ?? described.size;
    if (size > MAX_PREVIEW_BYTES) throw new BlobError(413, "That file is too large to preview.");
    const range = asked ? byteRange(asked, size) : null;
    const from = source(request.comparison);
    const body = await from.content(
      request.side,
      described,
      range ?? { start: 0, end: size - 1 },
      runner(from.key, signal),
    );
    return { size, lfs: described.lfs, range, body: capped(body, MAX_PREVIEW_BYTES) };
  };

  return {
    async describe(comparison, path, previousPath, signal) {
      const sides = await describeSides(
        comparison,
        { base: previousPath ?? path, head: path },
        signal,
      );
      return { base: publicDescriptor(sides.base), head: publicDescriptor(sides.head) };
    },
    open,
    async text(request, maxBytes, signal) {
      const described = await sideOf(request, signal);
      if (described.kind === "missing") return null;
      if (described.kind === "blob" && (described.lfs?.size ?? described.size) > maxBytes) {
        throw new BlobError(413, "That file is too large to compare as objects.");
      }
      const content = await open(request, signal);
      return new TextDecoder().decode(await readAll(content.body));
    },
  };
}
