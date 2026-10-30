import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Cache, Duration, Effect, Exit } from "effect";
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
import type { GhError, GitHub } from "./gh.ts";
import { GITBUTLER_PLUGIN_ID } from "./gitbutler.ts";
import { createLimiter } from "./limiter.ts";
import { type Run, type Share, runDetached, shareDetached } from "./run.ts";

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
    signal?: AbortSignal,
  ): Promise<FileBlobs>;
  open(
    request: BlobRequest,
    signal: AbortSignal,
    range?: RangeRequest | null,
  ): Promise<BlobContent>;
  /** A side's content as text, for Unity assets. Null when the side has no file. */
  text(request: BlobRequest, maxBytes: number, signal: AbortSignal): Promise<string | null>;
};

/** Why a read failed, as its source or GitHub CLI said. Anything else is rethrown as it was. */
type ReadError = BlobError | GhError;

/**
 * One request to a file's source, in one of that source's slots and under a
 * deadline until it answers, for the caller that asked. A body streams on
 * outside both, so a paused video holds neither a slot nor a timer.
 */
type Read = <A>(work: Effect.Effect<A, ReadError>) => Promise<A>;

type Source = {
  key: string;
  describe(sides: {
    base: string;
    head: string;
  }): Effect.Effect<Record<ComparisonSide, Described>, ReadError>;
  content(
    side: ComparisonSide,
    blob: Extract<Described, { kind: "blob" }>,
    range: ByteRange,
    read: Read,
  ): Promise<ReadableStream<Uint8Array>>;
};

export function publicDescriptor(described: Described): BlobDescriptor {
  return described.kind === "blob"
    ? { kind: "blob", size: described.size, lfs: described.lfs }
    : described;
}

/**
 * `body`, failing past `max` bytes, or once `signal` aborts: the bytes stream
 * on past the read that started them, until their caller leaves.
 */
function capped(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let seen = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const leave = () => {
        controller.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      if (signal.aborted) leave();
      else signal.addEventListener("abort", leave, { once: true });
    },
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

/** A pull request's merge base, and the account that reads it. */
type MergeBaseKey = { account: string; owner: string; repo: string; base: string; head: string };

/** GitHub diffs a pull request against the merge base, not the base branch's tip. */
function mergeBase(github: GitHub, { account, owner, repo, base, head }: MergeBaseKey) {
  return Effect.flatMap(
    Effect.suspend(() =>
      github.effects
        .as(account)
        .text([
          "api",
          `repos/${owner}/${repo}/compare/${base}...${head}`,
          "--jq",
          ".merge_base_commit.sha",
        ]),
    ),
    (stdout) => {
      const sha = stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha)
        ? Effect.succeed(sha)
        : Effect.fail(new BlobError(502, "GitHub did not name a merge base."));
    },
  );
}

function githubSource(
  comparison: Extract<Comparison, { kind: "github" }>,
  github: GitHub,
  fetcher: typeof fetch,
  mergeBaseOf: (key: MergeBaseKey) => Effect.Effect<string, ReadError>,
): Source {
  const { account, owner, repo } = comparison;
  const gh = () => github.effects.as(account);
  const repository = `${owner}/${repo}`;

  const rev = (side: ComparisonSide) =>
    side === "head"
      ? Effect.succeed(comparison.head)
      : mergeBaseOf({
          account,
          owner,
          repo,
          base: comparison.base,
          head: comparison.head,
        });

  /**
   * A GitHub answer's body, as `read` takes it. `read` runs under the
   * request's signal, so a read that is stopped, at its deadline or for its
   * caller, stops a body still arriving before its slot goes to the next.
   */
  const api = Effect.fnUntraced(function* <A>(
    path: string,
    accept: string,
    read: (body: ReadableStream<Uint8Array>) => Promise<A>,
  ) {
    const token = yield* github.effects.token(account);
    const answer: { read: A } | { status: number } = yield* Effect.promise(async (signal) => {
      const response = await fetcher(`https://api.github.com/${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "bb-code-review",
        },
        signal,
      });
      return response.ok && response.body
        ? { read: await read(response.body) }
        : { status: response.status };
    });
    if ("read" in answer) return answer.read;
    if (answer.status === 404)
      return yield* Effect.fail(new BlobError(404, "GitHub has no such file."));
    if (answer.status === 403 || answer.status === 429) {
      return yield* Effect.fail(
        new BlobError(503, "GitHub refused the read. Its rate limit may be spent."),
      );
    }
    return yield* Effect.fail(new BlobError(502, `GitHub answered ${answer.status}.`));
  });
  const blob = <A>(oid: string, read: (body: ReadableStream<Uint8Array>) => Promise<A>) =>
    api(`repos/${owner}/${repo}/git/blobs/${oid}`, "application/vnd.github.raw+json", read);

  /** A side's descriptor, reading a small blob's text to tell a Git LFS pointer. */
  const described = Effect.fnUntraced(function* (
    object: GqlObject,
  ): Effect.fn.Return<Described, ReadError> {
    if (object === null) return { kind: "missing" };
    if (object.__typename === "Commit") return { kind: "submodule" };
    if (object.__typename !== "Blob" || !object.oid) return { kind: "missing" };
    const size = object.byteSize ?? 0;
    let lfs: LfsObject | null = null;
    if (size < MAX_POINTER_BYTES) {
      lfs = parseLfsPointer(new TextDecoder().decode(yield* blob(object.oid, readAll)));
    }
    return { kind: "blob", oid: object.oid, size, lfs };
  });

  const lfsServer = Effect.fnUntraced(function* (side: ComparisonSide) {
    const read = (yield* gh().graphql(LFS_CONFIG_QUERY, {
      owner,
      name: repo,
      expression: `${yield* rev(side)}:.lfsconfig`,
    })) as { repository: { object: { text?: string | null } | null } };
    const url = lfsConfigUrl(read.repository.object?.text ?? "");
    if (url && !/^https:\/\/github\.com\//i.test(url)) {
      const host = /^[a-z+]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url;
      return yield* Effect.fail(
        new BlobError(
          502,
          `This repository keeps Git LFS files on ${host}, which previews cannot read.`,
        ),
      );
    }
  });

  /** The Git LFS batch API, asked of each repository that may hold the object. */
  const lfsObject = Effect.fnUntraced(function* (side: ComparisonSide, object: LfsObject) {
    yield* lfsServer(side);
    const token = yield* github.effects.token(account);
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
      // The answer is read under the request's signal too, so stopping the lookup stops it.
      const batch = yield* Effect.promise(async (signal) => {
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
        return {
          ok: response.ok,
          status: response.status,
          json: response.ok ? ((await response.json()) as unknown) : null,
        };
      });
      if (batch.status === 404) continue;
      if (!batch.ok) {
        return yield* Effect.fail(new BlobError(502, `GitHub's Git LFS answered ${batch.status}.`));
      }
      const found = batchSchema.parse(batch.json).objects.find((each) => each.oid === object.oid);
      const download = found?.actions?.download;
      if (!download) {
        missing = found?.error?.message ?? missing;
        continue;
      }
      const file = yield* Effect.promise(async (signal) =>
        fetcher(download.href, { headers: download.header ?? {}, signal }),
      );
      if (!file.ok || !file.body) {
        return yield* Effect.fail(new BlobError(502, `Git LFS storage answered ${file.status}.`));
      }
      return file.body;
    }
    return yield* Effect.fail(new BlobError(502, missing));
  });

  return {
    key: `github:${repository.toLowerCase()}`,
    describe: Effect.fnUntraced(function* (paths) {
      const [base, head] = yield* Effect.all([rev("base"), rev("head")], {
        concurrency: "unbounded",
      });
      const read = (yield* gh().graphql(
        OBJECTS_QUERY,
        { owner, name: repo, base: `${base}:${paths.base}`, head: `${head}:${paths.head}` },
        { optionalRoot: () => false },
      )) as { repository: { base: GqlObject; head: GqlObject } };
      const [baseSide, headSide] = yield* Effect.all(
        [described(read.repository.base), described(read.repository.head)],
        { concurrency: "unbounded" },
      );
      return { base: baseSide, head: headSide };
    }),
    async content(side, described, range, read) {
      // A preview's body streams on past its read; `capped` stops it for its caller.
      const body = await read(
        described.lfs
          ? lfsObject(side, described.lfs)
          : blob(described.oid, async (stream) => stream),
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
  const call = <T>(method: string, input: unknown, schema: z.ZodType<T>) =>
    Effect.tryPromise({
      try: async (signal) =>
        bb.sdk.plugins.callRpc({
          pluginId: GITBUTLER_PLUGIN_ID,
          method,
          input: input as never,
          outputSchema: schema,
          signal,
        }),
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return new BlobError(/not connected|offline/i.test(message) ? 503 : 502, message);
      },
    });
  return {
    key: `host:${comparison.hostId}`,
    describe: Effect.fnUntraced(function* (paths) {
      const read = yield* call(
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
      if (!base || !head) {
        return yield* Effect.fail(
          new BlobError(502, "The GitButler plugin answered without both sides."),
        );
      }
      return { base, head };
    }),
    async content(_side, described, range, read) {
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
          const chunk = await read(
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
  run = runDetached,
  share = shareDetached,
}: {
  bb: BbPluginApi;
  github: GitHub;
  fetch?: typeof fetch;
  run?: Run;
  share?: Share;
}): BlobReader {
  const limiter = createLimiter({ perKey: 3, total: 8 });
  // Pinned to commits, so an answer never goes stale. A failure is not kept, so asking again reads again.
  const timeToLive = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isSuccess(exit) ? Duration.infinity : Duration.zero;
  const mergeBases = Effect.runSync(
    Cache.makeWith((key: MergeBaseKey) => mergeBase(github, key), { capacity: 256, timeToLive }),
  );
  // A describe that stops waiting, at its deadline or for a caller that left,
  // leaves the merge base to finish and be kept, so the next one reads it here.
  const mergeBaseOf = (key: MergeBaseKey) => share(Cache.get(mergeBases, key));

  const source = (comparison: Comparison): Source =>
    comparison.kind === "github"
      ? githubSource(comparison, github, fetcher, mergeBaseOf)
      : localSource(comparison, bb);

  /** `work` in one of `key`'s slots, failing as a 504 once it has taken `ms` to answer. */
  const slot = <A>(key: string, ms: number, work: Effect.Effect<A, ReadError>) =>
    limiter.run(key, work).pipe(
      Effect.timeoutOrElse({
        duration: ms,
        orElse: () => Effect.fail(new BlobError(504, "Reading the file took too long.")),
      }),
    );

  const descriptors = Effect.runSync(
    Cache.makeWith(
      ({
        comparison,
        paths,
      }: {
        comparison: Comparison;
        paths: { base: string; head: string };
      }) => {
        const from = source(comparison);
        // Every caller asking meanwhile shares this read, so it answers to its
        // own deadline, not to whichever caller asked first.
        return slot(from.key, DESCRIBE_MS, from.describe(paths));
      },
      { capacity: 512, timeToLive },
    ),
  );

  const describeSides = (
    comparison: Comparison,
    paths: { base: string; head: string },
    signal?: AbortSignal,
  ) => run(Cache.get(descriptors, { comparison, paths }), signal);

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
      (work) => run(slot(from.key, CONTENT_MS, work), signal),
    );
    return {
      size,
      lfs: described.lfs,
      range,
      body: capped(body, MAX_PREVIEW_BYTES, signal),
    };
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
