import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fakeGh } from "../../../test/fake-gh.ts";
import type { Comparison } from "../../shared/schema.ts";
import { BlobError, createBlobReader, lfsConfigUrl } from "./blobs.ts";
import { createGitHub } from "./gh.ts";

const BASE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HEAD = "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38";
const MERGE_BASE = "28c4d3075b5916acdb6974a7e4f5c49d2c274a86";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const MODEL = new TextEncoder().encode("glTF in LFS");
const MODEL_OID = createHash("sha256").update(MODEL).digest("hex");
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${MODEL_OID}\nsize ${MODEL.length}\n`;

const github: Comparison = {
  kind: "github",
  account: "octocat",
  owner: "acme",
  repo: "game",
  headRepository: "fork/game",
  base: BASE,
  head: HEAD,
};

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Fetched = { url: string; init?: RequestInit };

/** GitHub's REST blobs, its LFS batch API, and LFS storage, from tables. */
function fakeFetch(
  blobs: Record<string, Uint8Array | string>,
  lfs: Record<string, Record<string, Uint8Array>> = {},
) {
  const fetched: Fetched[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push({ url, ...(init ? { init } : {}) });
    const blob = /\/git\/blobs\/(\w+)$/.exec(url)?.[1];
    if (blob !== undefined) {
      const body = blobs[blob];
      return body === undefined
        ? new Response("", { status: 404 })
        : new Response(body as BodyInit);
    }
    const batch = /^https:\/\/github\.com\/([^/]+\/[^/]+)\.git\/info\/lfs\/objects\/batch$/.exec(
      url,
    )?.[1];
    if (batch !== undefined) {
      const store = lfs[batch] ?? {};
      const { objects } = JSON.parse(String(init?.body)) as { objects: { oid: string }[] };
      return Response.json({
        objects: objects.map(({ oid }) =>
          store[oid]
            ? {
                oid,
                actions: {
                  download: { href: `https://lfs.example/${batch}/${oid}`, header: { x: "1" } },
                },
              }
            : { oid, error: { code: 404, message: "Object does not exist" } },
        ),
      });
    }
    const stored = /^https:\/\/lfs\.example\/([^/]+\/[^/]+)\/(\w+)$/.exec(url);
    if (stored) return new Response(lfs[stored[1]!]![stored[2]!] as BodyInit);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetcher, fetched };
}

function githubReader(
  objects: Record<string, { oid: string; byteSize: number } | null>,
  fetcher: typeof fetch,
  lfsconfig: string | null = null,
) {
  const fake = fakeGh({
    graphql: {
      BlobSides: (variables) => {
        const object = (expression: unknown) => {
          const found = objects[String(expression)];
          return found ? { __typename: "Blob", ...found } : null;
        };
        return { repository: { base: object(variables["base"]), head: object(variables["head"]) } };
      },
      LfsConfig: () => ({
        repository: { object: lfsconfig === null ? null : { text: lfsconfig } },
      }),
    },
    rest: { [`repos/acme/game/compare/${BASE}...${HEAD}`]: `${MERGE_BASE}\n` },
  });
  return {
    reader: createBlobReader({ bb: {} as BbPluginApi, github: fake.github, fetch: fetcher }),
    fake,
  };
}

test("a pull request's base side is read at the merge base, as GitHub diffs it", async () => {
  const { fetcher } = fakeFetch({ b1: PNG });
  const { reader, fake } = githubReader(
    { [`${MERGE_BASE}:Art/old.png`]: { oid: "b1", byteSize: 4096 }, [`${HEAD}:Art/new.png`]: null },
    fetcher,
  );
  expect(
    await reader.describe(github, "Art/new.png", "Art/old.png", new AbortController().signal),
  ).toEqual({
    base: { kind: "blob", size: 4096, lfs: null },
    head: { kind: "missing" },
  });
  expect(fake.calls[0]).toMatchObject({
    kind: "rest",
    path: `repos/acme/game/compare/${BASE}...${HEAD}`,
  });
});

test("a pointer is read through to its Git LFS object, from the fork that pushed it", async () => {
  const { fetcher, fetched } = fakeFetch({ p1: POINTER }, { "fork/game": { [MODEL_OID]: MODEL } });
  const { reader } = githubReader(
    { [`${HEAD}:hero.glb`]: { oid: "p1", byteSize: POINTER.length } },
    fetcher,
  );
  const content = await reader.open(
    { comparison: github, side: "head", path: "hero.glb" },
    new AbortController().signal,
  );
  expect(content.lfs).toEqual({ oid: MODEL_OID, size: MODEL.length });
  expect(content.size).toBe(MODEL.length);
  expect(await bytes(content.body)).toEqual(MODEL);
  const batch = fetched.find((call) => call.url.includes("/info/lfs/objects/batch"));
  expect(batch?.url).toBe("https://github.com/fork/game.git/info/lfs/objects/batch");
  expect(new Headers(batch?.init?.headers).get("authorization")).toBe(
    `Basic ${Buffer.from("octocat:token-octocat").toString("base64")}`,
  );
  // The storage URL gets the headers the batch answer named, not the GitHub token.
  const download = fetched.at(-1)!;
  expect(new Headers(download.init?.headers).get("authorization")).toBeNull();
  expect(new Headers(download.init?.headers).get("x")).toBe("1");
});

test("an LFS server elsewhere is named, not guessed at", async () => {
  const { fetcher } = fakeFetch({ p1: POINTER });
  const { reader } = githubReader(
    { [`${HEAD}:hero.glb`]: { oid: "p1", byteSize: POINTER.length } },
    fetcher,
    '[lfs]\n\turl = "https://lfs.studio.example/game"\n',
  );
  await expect(
    reader.open(
      { comparison: github, side: "head", path: "hero.glb" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("lfs.studio.example");
});

test("missing files, symlinks, and oversized files say why they cannot be read", async () => {
  const { fetcher } = fakeFetch({});
  const { reader } = githubReader(
    { [`${HEAD}:huge.fbx`]: { oid: "h1", byteSize: 65 * 1024 * 1024 } },
    fetcher,
  );
  const signal = new AbortController().signal;
  const missing = reader.open({ comparison: github, side: "head", path: "gone.png" }, signal);
  await expect(missing).rejects.toBeInstanceOf(BlobError);
  await expect(missing).rejects.toMatchObject({ status: 404 });
  await expect(
    reader.open({ comparison: github, side: "head", path: "huge.fbx" }, signal),
  ).rejects.toMatchObject({ status: 413 });
});

const local: Comparison = {
  kind: "local",
  hostId: "laptop",
  path: "/Users/me/game",
  base: BASE,
  head: HEAD,
};

function localReader(answer: (method: string, input: Record<string, unknown>) => unknown) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const bb = {
    sdk: {
      plugins: {
        callRpc: async ({ method, input }: { method: string; input: Record<string, unknown> }) => {
          calls.push({ method, input });
          return answer(method, input);
        },
      },
    },
  } as unknown as BbPluginApi;
  return { reader: createBlobReader({ bb, github: fakeGh().github }), calls };
}

test("a local branch reads its file on its own machine, a range at a time", async () => {
  const big = new Uint8Array(9 * 1024 * 1024).map((_, index) => index % 256);
  const { reader, calls } = localReader((method, input) => {
    if (method === "branchBlobs") {
      return {
        items: [
          { kind: "missing" },
          { kind: "blob", oid: "a".repeat(40), size: big.length, lfs: null },
        ],
      };
    }
    const offset = input["offset"] as number;
    const length = input["length"] as number;
    const part = big.subarray(offset, offset + length);
    return { size: big.length, content: Buffer.from(part).toString("base64") };
  });
  const content = await reader.open(
    { comparison: local, side: "head", path: "Art/big.psd" },
    new AbortController().signal,
  );
  expect(await bytes(content.body)).toEqual(big);
  expect(calls.map((call) => call.method)).toEqual([
    "branchBlobs",
    "branchBlobChunk",
    "branchBlobChunk",
    "branchBlobChunk",
  ]);
  expect(calls[0]!.input).toEqual({
    hostId: "laptop",
    path: "/Users/me/game",
    items: [
      { rev: BASE, path: "Art/big.psd" },
      { rev: HEAD, path: "Art/big.psd" },
    ],
  });
});

test("a host's LFS answer with an oid that is not sha256 hex is no pointer at all", async () => {
  const { reader } = localReader(() => ({
    items: [
      {
        kind: "blob",
        oid: "b".repeat(40),
        size: 120,
        lfs: { oid: "../../../etc/passwd", size: 3 },
      },
      { kind: "blob", oid: "c".repeat(40), size: 120, lfs: { oid: MODEL_OID, size: MODEL.length } },
    ],
  }));
  expect(await reader.describe(local, "hero.glb", null, new AbortController().signal)).toEqual({
    base: { kind: "blob", size: 120, lfs: null },
    head: { kind: "blob", size: 120, lfs: { oid: MODEL_OID, size: MODEL.length } },
  });
});

test("a machine that is offline fails as unavailable, so the card can offer a retry", async () => {
  const { reader } = localReader(() => {
    throw new Error("Local Mac is not connected.");
  });
  await expect(
    reader.describe(local, "hero.png", null, new AbortController().signal),
  ).rejects.toMatchObject({ status: 503 });
});

test("a .lfsconfig names its LFS server only under [lfs]", () => {
  expect(lfsConfigUrl('[lfs]\n  url = "https://x.example/repo"')).toBe("https://x.example/repo");
  expect(lfsConfigUrl('[remote "origin"]\n  url = https://elsewhere\n')).toBeNull();
});

test("a range reads only its part, on the branch's machine from its offset", async () => {
  const big = new Uint8Array(9 * 1024 * 1024).map((_, index) => index % 256);
  const { reader, calls } = localReader((method, input) => {
    if (method === "branchBlobs") {
      return {
        items: [
          { kind: "missing" },
          { kind: "blob", oid: "a".repeat(40), size: big.length, lfs: null },
        ],
      };
    }
    const offset = input["offset"] as number;
    const length = input["length"] as number;
    return {
      size: big.length,
      content: Buffer.from(big.subarray(offset, offset + length)).toString("base64"),
    };
  });
  const start = 5 * 1024 * 1024;
  const content = await reader.open(
    { comparison: local, side: "head", path: "Audio/theme.ogg" },
    new AbortController().signal,
    { start, end: null },
  );
  expect(content.range).toEqual({ start, end: big.length - 1 });
  expect(await bytes(content.body)).toEqual(big.subarray(start));
  expect(calls.find((call) => call.method === "branchBlobChunk")!.input["offset"]).toBe(start);
  await expect(
    reader.open(
      { comparison: local, side: "head", path: "Audio/theme.ogg" },
      new AbortController().signal,
      { start: big.length, end: null },
    ),
  ).rejects.toMatchObject({ status: 416 });
});

test("a pull request's range is cut from the file GitHub sends whole", async () => {
  const { fetcher } = fakeFetch({ b1: PNG });
  const { reader } = githubReader(
    { [`${HEAD}:Art/new.png`]: { oid: "b1", byteSize: PNG.length } },
    fetcher,
  );
  const content = await reader.open(
    { comparison: github, side: "head", path: "Art/new.png" },
    new AbortController().signal,
    { suffix: 3 },
  );
  expect(content.range).toEqual({ start: PNG.length - 3, end: PNG.length - 1 });
  expect(await bytes(content.body)).toEqual(PNG.subarray(PNG.length - 3));
});

test("a file left half read, as a paused video leaves it, holds no slot from the next", async () => {
  const { reader } = localReader((method, input) => {
    if (method === "branchBlobs") {
      return {
        items: [
          { kind: "missing" },
          { kind: "blob", oid: "a".repeat(40), size: 8 * 1024 * 1024, lfs: null },
        ],
      };
    }
    return {
      size: 8 * 1024 * 1024,
      content: Buffer.alloc(input["length"] as number).toString("base64"),
    };
  });
  const signal = new AbortController().signal;
  const paused = [];
  for (const name of ["a", "b", "c", "d"]) {
    const content = await reader.open(
      { comparison: local, side: "head", path: `${name}.ogg` },
      signal,
    );
    await content.body.getReader().read();
    paused.push(content);
  }
  // Each source has three slots; a fifth file still opens.
  const next = await reader.open({ comparison: local, side: "head", path: "e.ogg" }, signal);
  expect((await next.body.getReader().read()).done).toBe(false);
});

/** Runs `work` with every timer of a second or more firing at once: deadlines without the wait. */
async function withoutWaiting<T>(work: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) =>
    real(handler, (ms ?? 0) >= 1000 ? 0 : ms)) as typeof setTimeout;
  try {
    return await work();
  } finally {
    globalThis.setTimeout = real;
  }
}

/** A promise that never settles, as a host that went to sleep answers. */
const asleep = () => new Promise<never>(() => {});

test("a machine that never answers fails at the read's deadline, as a 504", async () => {
  const { reader } = localReader(asleep);
  await withoutWaiting(async () => {
    await expect(
      reader.describe(local, "hero.png", null, new AbortController().signal),
    ).rejects.toMatchObject({ status: 504, message: "Reading the file took too long." });
  });
});

test("a file whose bytes stop coming fails at the read's deadline, as a 504", async () => {
  const { reader } = localReader((method) =>
    method === "branchBlobs"
      ? { items: [{ kind: "missing" }, { kind: "blob", oid: "a".repeat(40), size: 9, lfs: null }] }
      : asleep(),
  );
  await withoutWaiting(async () => {
    const content = await reader.open(
      { comparison: local, side: "head", path: "Audio/theme.ogg" },
      new AbortController().signal,
    );
    await expect(content.body.getReader().read()).rejects.toMatchObject({
      status: 504,
      message: "Reading the file took too long.",
    });
  });
});

/**
 * A fetch that answers what `served` knows. Any other request sends its
 * headers at once, and then its body stalls until the request's signal
 * aborts, which ends a real fetch's body too. The log names each request by
 * its URL's last part, when it started and when it was stopped.
 */
function stallingBodies(served: (url: string) => Response | undefined = () => undefined) {
  const log: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const answer = served(url);
    if (answer) return answer;
    const name = url.split("/").at(-1);
    log.push(`start ${name}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => {
            log.push(`stopped ${name}`);
            controller.error(init.signal?.reason);
          },
          { once: true },
        );
      },
    });
    return new Response(body);
  }) as typeof fetch;
  return { fetcher, log };
}

test("a read stopped while a body is still arriving stops its request before its slot goes to the next read", async () => {
  const { fetcher, log } = stallingBodies();
  // Each file is small enough to be a Git LFS pointer, so describing it reads its body.
  const { reader } = githubReader(
    Object.fromEntries(
      ["a", "b", "c", "d"].map((name) => [`${HEAD}:${name}.png`, { oid: name, byteSize: 100 }]),
    ),
    fetcher,
  );
  const describe = (name: string) => {
    const controller = new AbortController();
    const read = reader.describe(github, `${name}.png`, null, controller.signal);
    read.catch(() => undefined);
    return { controller, read };
  };
  const reads = ["a", "b", "c"].map(describe);
  try {
    // The three reads hold the repository's three slots, each waiting on its body.
    await until(() => log.length === 3);
    reads.push(describe("d"));
    await Bun.sleep(50);
    expect(log).not.toContain("start d");

    reads[0]!.controller.abort();
    await expect(reads[0]!.read).rejects.toBeDefined();
    await until(() => log.includes("start d"));
    expect(log).toContain("stopped a");
    expect(log.indexOf("stopped a")).toBeLessThan(log.indexOf("start d"));
  } finally {
    for (const { controller } of reads) controller.abort();
    await Promise.allSettled(reads.map(({ read }) => read));
  }
});

test("an LFS lookup stopped while GitHub's answer is still arriving stops that request", async () => {
  const { fetcher, log } = stallingBodies((url) =>
    url.includes("/git/blobs/") ? new Response(POINTER) : undefined,
  );
  const { reader } = githubReader(
    { [`${HEAD}:hero.glb`]: { oid: "p1", byteSize: POINTER.length } },
    fetcher,
  );
  const controller = new AbortController();
  const read = reader.open(
    { comparison: github, side: "head", path: "hero.glb" },
    controller.signal,
  );
  await until(() => log.includes("start batch"));
  controller.abort();
  await expect(read).rejects.toBeDefined();
  expect(log).toEqual(["start batch", "stopped batch"]);
});

test("a busy machine's reads wait for its slots while another machine's reads go ahead", async () => {
  const started: string[] = [];
  const answers: (() => void)[] = [];
  const { reader } = localReader((_method, input) => {
    started.push(
      `${String(input["hostId"])}:${String((input["items"] as { path: string }[])[1]!.path)}`,
    );
    return new Promise((resolve) => {
      answers.push(() => resolve({ items: [{ kind: "missing" }, { kind: "missing" }] }));
    });
  });
  const signal = new AbortController().signal;
  const reads = ["a", "b", "c", "d"].map((name) =>
    reader.describe(local, `${name}.png`, null, signal),
  );
  const other = reader.describe({ ...local, hostId: "desktop" }, "e.png", null, signal);
  await Bun.sleep(10);
  // Three slots per source: the fourth waits, and the other machine's read does not.
  expect(started).toEqual(["laptop:a.png", "laptop:b.png", "laptop:c.png", "desktop:e.png"]);
  answers[0]!();
  await reads[0];
  await Bun.sleep(10);
  expect(started.at(-1)).toBe("laptop:d.png");
  for (const answer of answers.slice(1)) answer();
  await Promise.all([...reads, other]);
});

test("files of one pull request share the read of its merge base", async () => {
  const { fetcher } = fakeFetch({});
  const { reader, fake } = githubReader({}, fetcher);
  const signal = new AbortController().signal;
  await Promise.all([
    reader.describe(github, "a.png", null, signal),
    reader.describe(github, "b.png", null, signal),
  ]);
  await reader.describe(github, "c.png", null, signal);
  expect(fake.calls.filter((call) => call.kind === "rest")).toHaveLength(1);
});

/**
 * Holds every timer of a second or more until `pass()`, so a deadline passes
 * exactly when the test says. Shorter timers run as usual.
 */
function heldDeadlines() {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const held = new Map<object, () => void>();
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    if ((ms ?? 0) < 1000) return real.set(handler, ms);
    const handle = {};
    held.set(handle, handler);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: object) => {
    if (!held.delete(handle)) real.clear(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return {
    pass() {
      const due = [...held.values()];
      held.clear();
      for (const handler of due) handler();
    },
    restore() {
      globalThis.setTimeout = real.set;
      globalThis.clearTimeout = real.clear;
    },
  };
}

/** A pull request whose first merge-base read waits for `answer()`; later reads answer at once. */
function slowMergeBase() {
  let compares = 0;
  let answer = () => {};
  const fake = fakeGh({
    graphql: { BlobSides: () => ({ repository: { base: null, head: null } }) },
    rest: {
      [`repos/acme/game/compare/${BASE}...${HEAD}`]: () =>
        compares++ === 0
          ? new Promise((resolve) => {
              answer = () => resolve(`${MERGE_BASE}\n`);
            })
          : `${MERGE_BASE}\n`,
    },
  });
  return {
    reader: createBlobReader({ bb: {} as BbPluginApi, github: fake.github }),
    compares: () => compares,
    answer: () => answer(),
  };
}

const NOTHING = { base: { kind: "missing" }, head: { kind: "missing" } } as const;

test("a describe past its deadline leaves its merge base to finish, and the next describe uses it", async () => {
  const { reader, compares, answer } = slowMergeBase();
  const signal = new AbortController().signal;
  const deadlines = heldDeadlines();
  try {
    const first = reader.describe(github, "a.png", null, signal);
    await until(() => compares() === 1);
    deadlines.pass();
    await expect(first).rejects.toMatchObject({ status: 504 });
  } finally {
    deadlines.restore();
  }
  answer();
  expect(await reader.describe(github, "a.png", null, signal)).toEqual(NOTHING);
  expect(compares()).toBe(1);
});

test("a describe its only caller leaves still lets its merge base finish for the next", async () => {
  const { reader, compares, answer } = slowMergeBase();
  const leaving = new AbortController();
  const first = reader.describe(github, "a.png", null, leaving.signal);
  await until(() => compares() === 1);
  leaving.abort();
  await expect(first).rejects.toBeDefined();
  answer();
  expect(await reader.describe(github, "a.png", null, new AbortController().signal)).toEqual(
    NOTHING,
  );
  expect(compares()).toBe(1);
});

test("callers asking while a read runs share it: one leaves, another joins, and it reads once", async () => {
  let answer: (value: unknown) => void = () => {};
  let reads = 0;
  const { reader } = localReader(() => {
    reads++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const leaving = new AbortController();
  const first = reader.describe(local, "hero.png", null, leaving.signal);
  const second = reader.describe(local, "hero.png", null, new AbortController().signal);
  await Bun.sleep(0);
  leaving.abort();
  await expect(first).rejects.toBeDefined();
  const third = reader.describe(local, "hero.png", null, new AbortController().signal);
  answer({
    items: [{ kind: "missing" }, { kind: "blob", oid: "c".repeat(40), size: 9, lfs: null }],
  });
  expect((await second).head).toEqual({ kind: "blob", size: 9, lfs: null });
  expect((await third).head).toEqual({ kind: "blob", size: 9, lfs: null });
  expect(reads).toBe(1);
});

test("a caller that leaves does not fail the others sharing its read", async () => {
  let answer: (value: unknown) => void = () => {};
  const { reader } = localReader(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const leaving = new AbortController();
  const first = reader.describe(local, "hero.png", null, leaving.signal);
  const second = reader.describe(local, "hero.png", null, new AbortController().signal);
  leaving.abort();
  await expect(first).rejects.toBeDefined();
  answer({
    items: [{ kind: "missing" }, { kind: "blob", oid: "c".repeat(40), size: 9, lfs: null }],
  });
  expect((await second).head).toEqual({ kind: "blob", size: 9, lfs: null });
});

/**
 * A `gh` first on PATH that answers a pull request's file reads and stalls
 * on its Git LFS config, logging when each `gh` starts and when one stopped
 * by a signal ends. A stopped `gh` takes a moment to exit, as a real one may.
 */
function stallingGh(dir: string) {
  const log = join(dir, "log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "auth status") echo "  Logged in to github.com account octocat (keyring)"; exit 0;;
  "auth token") echo token-octocat; exit 0;;
esac
case "$2" in
  repos/*/compare/*) echo ${MERGE_BASE}; exit 0;;
esac
body=$(cat)
case "$body" in
  *BlobSides*)
    echo "start $$ BlobSides" >> ${log}
    printf '{"data":{"repository":{"base":null,"head":{"__typename":"Blob","oid":"p1","byteSize":${POINTER.length}}}}}'
    exit 0;;
  *LfsConfig*)
    trap 'kill $child 2>/dev/null; sleep 0.3; echo "end $$" >> ${log}; exit 143' TERM
    echo "start $$ LfsConfig" >> ${log}
    sleep 30 & child=$!
    wait $child
    exit 0;;
esac
exit 1
`,
    { mode: 0o755 },
  );
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ready(); i++) await Bun.sleep(10);
  expect(ready()).toBe(true);
}

test("a read that is stopped ends its gh before its slot goes to the next read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-review-gh-"));
  const lines = stallingGh(dir);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  const { fetcher } = fakeFetch({ p1: POINTER });
  const reader = createBlobReader({
    bb: {} as BbPluginApi,
    github: createGitHub(),
    fetch: fetcher,
  });
  const open = (name: string) => {
    const controller = new AbortController();
    const read = reader.open({ comparison: github, side: "head", path: name }, controller.signal);
    read.catch(() => undefined);
    return { controller, read };
  };
  const started = (operation: string) => lines().filter((line) => line.endsWith(operation));
  const reads = [open("a.glb"), open("b.glb"), open("c.glb")];
  try {
    // Each read holds one of the repository's three slots while gh reads its LFS config.
    await until(() => started("LfsConfig").length === 3);
    reads.push(open("d.glb"));
    await Bun.sleep(100);
    expect(started("BlobSides")).toHaveLength(3);

    reads[0]!.controller.abort();
    await expect(reads[0]!.read).rejects.toBeDefined();
    await until(() => started("BlobSides").length === 4);
    const log = lines();
    const ended = log.findIndex((line) => line.startsWith("end "));
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(ended).toBeLessThan(log.indexOf(started("BlobSides")[3]!));
  } finally {
    for (const { controller } of reads) controller.abort();
    await Promise.allSettled(reads.map(({ read }) => read));
    for (const line of lines()) {
      const pid = Number(line.split(" ")[1]);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
