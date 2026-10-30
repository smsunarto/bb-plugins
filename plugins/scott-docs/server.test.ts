import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import simpleNotes, { docsRpcContract } from "./server";

const temporaryDirectories: string[] = [];

type FakeHostOptions = NonNullable<Parameters<typeof createFakePluginHost>[0]>;
type FileStat = { modifiedAtMs: number; sizeBytes: number };

// Real fixtures report their size; a fixed time keeps tied note order stable.
async function statFixture(filePath: string): Promise<FileStat> {
  const stats = await stat(filePath).catch(() => null);
  return { modifiedAtMs: 1, sizeBytes: stats?.size ?? 0 };
}

// Docs lists vaults through its own host entry. Route that call to the fake
// SDK file listing so fixtures, stubs, and recorded calls stay in one place.
function createDocsHost(
  options: FakeHostOptions & {
    statFile?: (filePath: string) => Promise<FileStat>;
    watchFile?: (input: {
      path: string;
      hostId: string;
      signal?: AbortSignal;
    }) => Promise<{ sha256: string | null }>;
    // Answers a vault arming before the host records the watch.
    watchVault?: (input: {
      vaultId: string;
      hostId: string;
      signal?: AbortSignal;
    }) => Promise<void>;
  },
) {
  const { statFile = statFixture, watchFile, watchVault, ...hostOptions } = options;
  // Vault watches each host holds. Clearing a host's set is a daemon restart.
  const hostWatches = new Map<string, Set<string>>();
  const watchesOn = (hostId: string) => {
    if (!hostWatches.has(hostId)) hostWatches.set(hostId, new Set());
    return hostWatches.get(hostId)!;
  };
  const host: ReturnType<typeof createFakePluginHost> = createFakePluginHost({
    ...hostOptions,
    experimental_callHostRpc: async ({ method, input, hostId, signal }) => {
      const { vaultId, vaultIds } = input as { vaultId?: string; vaultIds?: string[] };
      if (method === "watchVault") {
        await watchVault?.({ vaultId: vaultId!, hostId, signal });
        watchesOn(hostId).add(vaultId!);
        return { ok: true };
      }
      if (method === "unwatchVault") {
        watchesOn(hostId).delete(vaultId!);
        return { ok: true };
      }
      if (method === "watchAlive") {
        return { live: vaultIds!.filter((id) => watchesOn(hostId).has(id)) };
      }
      if (method === "statFile") {
        const stats = await stat((input as { path: string }).path).catch(() => null);
        return { file: stats ? { modifiedAtMs: 1, sizeBytes: stats.size } : null };
      }
      if (method === "watchFile") {
        if (watchFile) return watchFile({ path: (input as { path: string }).path, hostId, signal });
        const content = await readFile((input as { path: string }).path).catch(() => null);
        return { sha256: content && createHash("sha256").update(content).digest("hex") };
      }
      if (method !== "listPaths") throw new Error(`Unexpected host RPC: ${method}`);
      const {
        path: root,
        includeFiles,
        includeDirectories,
        limit,
      } = input as {
        path: string;
        includeFiles: boolean;
        includeDirectories: boolean;
        limit: number;
      };
      const result = await host.bb.sdk.files.listPaths({
        hostId,
        path: root,
        includeFiles,
        includeDirectories,
        limit,
      });
      return {
        paths: await Promise.all(
          result.paths.map(async ({ kind, path: listedPath }) =>
            kind === "directory"
              ? { kind, path: listedPath }
              : { kind, path: listedPath, ...(await statFile(path.posix.join(root, listedPath))) },
          ),
        ),
        truncated: result.truncated,
      };
    },
    sdk: {
      ...hostOptions.sdk,
      system: {
        config: async () => ({ primaryHostId: "host_primary" }),
        ...hostOptions.sdk?.system,
      },
    },
  });
  return Object.assign(host, { hostWatches });
}

const serverHost = makeHostResponse({ id: "host_primary", name: "Server" });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function insertPersonalVault(bb: ReturnType<typeof createDocsHost>["bb"], rootPath: string) {
  bb.storage
    .database()
    .prepare(
      "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES ('personal', 'Personal', 'host_primary', ?, ?)",
    )
    .run(rootPath, Date.now());
}

async function loadNotebook(
  notes: Record<string, string>,
  controls: Pick<Parameters<typeof createDocsHost>[0], "watchFile" | "watchVault"> = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-simple-notes-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(notes).map(([name, content]) => writeFile(path.join(directory, name), content)),
  );
  const host = createDocsHost({
    ...controls,
    pluginId: "simple-notes",
    sdk: {
      files: {
        listPaths: async () => ({
          paths: Object.keys(notes).map((name) => ({
            kind: "file" as const,
            path: name,
            name,
            score: 0,
            positions: [],
          })),
          truncated: false,
        }),
        read: async ({ path: filePath }) => {
          const content = await readFile(filePath, "utf8");
          return {
            path: filePath,
            content,
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: Buffer.byteLength(content),
            modifiedAtMs: 1,
            sha256: "test-sha",
          };
        },
        write: async () => ({
          outcome: "written" as const,
          sha256: "written-sha",
          sizeBytes: 1,
        }),
        mkdir: async () => ({ ok: true as const }),
        move: async () => ({ ok: true as const }),
        remove: async () => ({ ok: true as const }),
        createPreview: async () => ({
          baseUrl: "/api/v1/file-previews/test",
          expiresAtMs: Date.now() + 60_000,
        }),
      },
      hosts: { list: async () => [serverHost] },
    },
  });
  await simpleNotes(host.bb);
  insertPersonalVault(host.bb, directory);
  host.harness.sdk.calls.length = 0;
  return host;
}

interface VirtualFile {
  content: string;
  contentEncoding: "base64" | "utf8";
  modifiedAtMs: number;
}

function virtualSha(file: VirtualFile): string {
  return createHash("sha256").update(Buffer.from(file.content, file.contentEncoding)).digest("hex");
}

async function loadVirtualSyncVault(initial: Record<string, VirtualFile>) {
  const files = new Map<string, VirtualFile>(Object.entries(initial));
  const directories = new Set<string>(["/vault", "/work"]);
  let concurrentWrite: { path: string; content: string } | null = null;
  const addParents = (filePath: string) => {
    let current = path.posix.dirname(filePath);
    while (current !== "/" && !directories.has(current)) {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  };
  for (const filePath of files.keys()) addParents(filePath);
  const setUtf8 = (filePath: string, content: string) => {
    addParents(filePath);
    files.set(filePath, {
      content,
      contentEncoding: "utf8",
      modifiedAtMs: Date.now(),
    });
  };
  const host = createDocsHost({
    pluginId: "simple-notes-sync",
    sdk: {
      files: {
        async listPaths(args) {
          const prefix = args.path.endsWith("/") ? args.path : `${args.path}/`;
          const paths = [
            ...(args.includeDirectories
              ? [...directories]
                  .filter((entry) => entry.startsWith(prefix))
                  .map((entry) => ({
                    kind: "directory" as const,
                    path: entry.slice(prefix.length),
                    name: path.posix.basename(entry),
                    score: 0,
                    positions: [],
                  }))
              : []),
            ...(args.includeFiles
              ? [...files.keys()]
                  .filter((entry) => entry.startsWith(prefix))
                  .map((entry) => ({
                    kind: "file" as const,
                    path: entry.slice(prefix.length),
                    name: path.posix.basename(entry),
                    score: 0,
                    positions: [],
                  }))
              : []),
          ];
          return { paths, truncated: false };
        },
        async read(args) {
          const file = files.get(args.path);
          if (!file) throw new Error(`ENOENT: Path does not exist: ${args.path}`);
          return {
            path: args.path,
            content: file.content,
            contentEncoding: file.contentEncoding,
            mimeType: file.contentEncoding === "utf8" ? "text/plain" : null,
            sizeBytes: Buffer.from(file.content, file.contentEncoding).length,
            modifiedAtMs: file.modifiedAtMs,
            sha256: virtualSha(file),
          };
        },
        async write(args) {
          const pending = concurrentWrite;
          if (pending && pending.path === args.path) {
            concurrentWrite = null;
            setUtf8(pending.path, pending.content);
            const current = files.get(pending.path);
            if (!current) throw new Error("Concurrent test write was not stored");
            return {
              outcome: "conflict" as const,
              currentSha256: virtualSha(current),
            };
          }
          const current = files.get(args.path);
          const currentSha = current ? virtualSha(current) : null;
          if (args.expectedSha256 !== undefined && args.expectedSha256 !== currentSha) {
            return { outcome: "conflict" as const, currentSha256: currentSha };
          }
          const next = {
            content: args.content,
            contentEncoding: args.contentEncoding ?? "utf8",
            modifiedAtMs: Date.now(),
          } satisfies VirtualFile;
          addParents(args.path);
          files.set(args.path, next);
          return {
            outcome: "written" as const,
            sha256: virtualSha(next),
            sizeBytes: Buffer.from(next.content, next.contentEncoding).length,
          };
        },
        async mkdir(args) {
          directories.add(args.path);
          addParents(args.path);
          return { ok: true as const };
        },
        async remove(args) {
          if (files.delete(args.path)) return { ok: true as const };
          if (!directories.has(args.path))
            throw new Error(`ENOENT: Path does not exist: ${args.path}`);
          const prefix = `${args.path}/`;
          if (
            !args.recursive &&
            ([...files.keys()].some((entry) => entry.startsWith(prefix)) ||
              [...directories].some((entry) => entry.startsWith(prefix)))
          )
            throw new Error("Directory is not empty");
          directories.delete(args.path);
          for (const entry of files.keys()) if (entry.startsWith(prefix)) files.delete(entry);
          for (const entry of directories) if (entry.startsWith(prefix)) directories.delete(entry);
          return { ok: true as const };
        },
        async move(args) {
          const from = args.sourcePath;
          const to = args.destinationPath;
          if (!files.has(from) && !directories.has(from)) throw new Error("ENOENT");
          if (files.has(to) || directories.has(to)) throw new Error("EEXIST");
          for (const [entry, file] of Array.from(files)) {
            if (entry === from || entry.startsWith(`${from}/`)) {
              files.delete(entry);
              files.set(to + entry.slice(from.length), file);
            }
          }
          for (const entry of Array.from(directories)) {
            if (entry === from || entry.startsWith(`${from}/`)) {
              directories.delete(entry);
              directories.add(to + entry.slice(from.length));
            }
          }
          addParents(to);
          return { ok: true as const };
        },
        async createPreview() {
          return { baseUrl: "/preview", expiresAtMs: Date.now() + 60_000 };
        },
        async list() {
          return { paths: [], truncated: false };
        },
      },
      hosts: {
        list: async () => [serverHost],
        pathsExist: async ({ paths }) => ({
          existence: Object.fromEntries(
            paths.map((entry) => [entry, files.has(entry) || directories.has(entry)]),
          ),
        }),
      },
    },
    statFile: async (filePath) => {
      const file = files.get(filePath);
      return {
        modifiedAtMs: file?.modifiedAtMs ?? 0,
        sizeBytes: file ? Buffer.from(file.content, file.contentEncoding).length : 0,
      };
    },
  });
  await simpleNotes(host.bb);
  insertPersonalVault(host.bb, "/vault");
  host.harness.sdk.calls.length = 0;
  return {
    ...host,
    files,
    directories,
    setUtf8,
    conflictNextWrite(path: string, content: string) {
      concurrentWrite = { path, content };
    },
  };
}

describe("Docs RPC contract", () => {
  it("returns HTTP 400 envelopes for invalid JSON and request input", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });

    const invalidJson = await harness.fetchHttp("POST", "/read", {
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });

    const invalidInput = await harness.fetchHttp("POST", "/read", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../outside.md" }),
    });
    expect(invalidInput.status).toBe(400);
    await expect(invalidInput.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        issues: [{ path: ["path"] }],
      },
    });

    const invalidContent = await harness.fetchHttp("POST", "/write", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "plan.md", content: 42 }),
    });
    expect(invalidContent.status).toBe(400);
    await expect(invalidContent.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        issues: [{ path: ["content"] }],
      },
    });
  });
});

async function waitForSignal(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for signal");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Effect runs fibers on setImmediate, so faking it would stall the server.
function useFakeTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

describe("Docs mention provider", () => {
  it("shares note reads across overlapping searches and subsequent keystrokes", async () => {
    const { harness } = await loadNotebook({
      "roadmap.md": "# Product Roadmap\n\nQuarterly priorities",
      "meeting.md": "# Standup\n\nLaunch checklist",
    });
    const provider = harness.registrations.mentionProviders[0]!;
    const search = (query: string) =>
      provider.search({ trigger: "@", query, projectId: null, threadId: null });

    const [roadmap, meeting] = await Promise.all([search("roadmap"), search("launch")]);
    expect(roadmap.map((item) => item.title)).toEqual(["Product Roadmap"]);
    expect(meeting.map((item) => item.title)).toEqual(["Standup"]);
    expect(await search("quarterly")).toEqual(roadmap);
    expect(harness.sdk.callsTo("files.listPaths")).toHaveLength(1);
    expect(harness.sdk.callsTo("files.read")).toHaveLength(2);
  });

  it("refreshes cached mentions after saves, moves, deletions, and external edits", async () => {
    const { harness, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "# Original",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    const provider = harness.registrations.mentionProviders[0]!;
    const search = () =>
      provider.search({
        trigger: "@",
        query: "",
        projectId: null,
        threadId: null,
      });
    expect(await search()).toMatchObject([{ title: "Original" }]);
    await harness.callRpc("saveNote", { path: "plan.md", content: "# Saved" });
    expect(await search()).toMatchObject([{ title: "Saved" }]);
    await harness.callRpc("saveOpenedFile", {
      source: {
        kind: "host",
        threadId: null,
        projectId: null,
        environmentId: null,
        experimental_hostId: "host_primary",
      },
      path: "/vault/plan.md",
      content: "# Edited in file opener",
    });
    expect(await search()).toMatchObject([{ title: "Edited in file opener" }]);
    await harness.callRpc("movePath", { from: "plan.md", to: "renamed.md" });
    expect(await search()).toMatchObject([{ id: "personal:renamed.md" }]);

    setUtf8("/vault/renamed.md", "# External edit");
    expect(await provider.resolve("personal:renamed.md")).toMatchObject({
      context: expect.stringContaining("# External edit"),
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_001);
    try {
      expect(await search()).toMatchObject([{ title: "External edit" }]);
    } finally {
      clock.mockRestore();
    }
    await harness.callRpc("deletePath", { path: "renamed.md" });
    expect(await search()).toEqual([]);
  });

  it("skips a failed vault scan and retries it on the next search", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const listPaths = vi
      .fn()
      .mockRejectedValueOnce(new Error("Host offline"))
      .mockResolvedValue({
        paths: [
          {
            kind: "file",
            path: "plan.md",
            name: "plan.md",
            score: 0,
            positions: [],
          },
        ],
        truncated: false,
      });
    harness.sdk.stub("files.listPaths", listPaths);
    const provider = harness.registrations.mentionProviders[0]!;
    const context = {
      trigger: "@" as const,
      query: "plan",
      projectId: null,
      threadId: null,
    };
    await expect(provider.search(context)).resolves.toEqual([]);
    expect(await provider.search(context)).toMatchObject([{ title: "Plan" }]);
    expect(listPaths).toHaveBeenCalledTimes(2);
  });

  it("bounds parallel summary reads while preserving tied result order", async () => {
    const { harness } = await loadNotebook(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`plan-${i}.md`, "# Plan"])),
    );
    let active = 0;
    let peak = 0;
    harness.sdk.stub("files.read", async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return {
        path: "/plan.md",
        content: "# Plan",
        contentEncoding: "utf8",
        sizeBytes: 6,
        modifiedAtMs: 1,
        sha256: "test-sha",
      };
    });
    const rows = await harness.registrations.mentionProviders[0]!.search({
      trigger: "@",
      query: "plan",
      projectId: null,
      threadId: null,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(rows.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `personal:plan-${i}.md`),
    );
  });

  it("lets a later search join a scan an earlier search stopped waiting for", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    let finishListing!: () => void;
    const listing = new Promise<void>((resolve) => {
      finishListing = resolve;
    });
    harness.sdk.stub("files.listPaths", async () => {
      await listing;
      return {
        paths: [{ kind: "file", path: "plan.md", name: "plan.md", score: 0, positions: [] }],
        truncated: false,
      };
    });
    const provider = harness.registrations.mentionProviders[0]!;
    const search = () =>
      provider.search({ trigger: "@", query: "plan", projectId: null, threadId: null });
    useFakeTimers();
    try {
      const first = search();
      await vi.waitFor(() => expect(harness.sdk.callsTo("files.listPaths")).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(first).resolves.toEqual([]);

      const second = search();
      finishListing();
      await expect(second).resolves.toMatchObject([{ id: "personal:plan.md", title: "Plan" }]);
      expect(harness.sdk.callsTo("files.listPaths")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an unfinished mention scan when the plugin unloads", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    let readSignal: AbortSignal | undefined;
    harness.sdk.stub("files.read", async ({ signal }: { signal?: AbortSignal }) => {
      readSignal = signal;
      return new Promise(() => {});
    });
    const provider = harness.registrations.mentionProviders[0]!;
    const search = provider.search({ trigger: "@", query: "", projectId: null, threadId: null });
    await waitForSignal(() => readSignal !== undefined);
    expect(readSignal!.aborted).toBe(false);
    await harness.lifecycle.dispose();
    expect(readSignal!.aborted).toBe(true);
    await Promise.allSettled([search]);
  });

  it("keeps the notes it can read and logs one it cannot", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan", "locked.md": "# Locked" });
    harness.sdk.stub("files.read", async ({ path: filePath }: { path: string }) => {
      if (filePath.endsWith("locked.md")) throw new Error("EACCES: permission denied");
      const content = await readFile(filePath, "utf8");
      return {
        path: filePath,
        content,
        contentEncoding: "utf8" as const,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(content),
        modifiedAtMs: 1,
        sha256: "test-sha",
      };
    });
    await expect(harness.callRpc("listNotes", { vaultId: "personal" })).resolves.toMatchObject({
      notes: [{ path: "plan.md", title: "Plan" }],
      error: null,
    });
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringMatching(/locked\.md.*EACCES: permission denied/),
    });
  });

  it("warns once about a note it still cannot read, and again after it was readable", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan", "locked.md": "# Locked" });
    let locked = true;
    harness.sdk.stub("files.read", async ({ path: filePath }: { path: string }) => {
      if (locked && filePath.endsWith("locked.md")) throw new Error("EACCES: permission denied");
      const content = await readFile(filePath, "utf8");
      return {
        path: filePath,
        content,
        contentEncoding: "utf8" as const,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(content),
        modifiedAtMs: 1,
        sha256: "test-sha",
      };
    });
    const warnings = () =>
      harness.logEntries.filter(
        (entry) => entry.level === "warn" && entry.message.includes("locked.md"),
      );
    const listedPaths = async () =>
      (
        (await harness.callRpc("listNotes", { vaultId: "personal" })) as {
          notes: { path: string }[];
        }
      ).notes.map((note) => note.path);
    const provider = harness.registrations.mentionProviders[0]!;
    const context = { trigger: "@" as const, query: "", projectId: null, threadId: null };

    // Every listing and mention scan retries the note, but reports it once.
    for (let pass = 0; pass < 3; pass += 1) expect(await listedPaths()).toEqual(["plan.md"]);
    expect(await provider.search(context)).toMatchObject([{ title: "Plan" }]);
    expect(warnings()).toHaveLength(1);

    locked = false;
    expect(await listedPaths()).toContain("locked.md");

    // A later version it cannot read is reported again.
    locked = true;
    await writeFile(path.join(temporaryDirectories[0]!, "locked.md"), "# Locked again");
    for (let pass = 0; pass < 2; pass += 1) expect(await listedPaths()).toEqual(["plan.md"]);
    expect(warnings()).toHaveLength(2);
  });

  it("searches note titles, previews, and filenames", async () => {
    const { harness } = await loadNotebook({
      "roadmap.md": "# Product Roadmap\n\nQuarterly priorities",
      "meeting-notes.md": "# Standup\n\nLaunch checklist",
    });
    const provider = harness.registrations.mentionProviders[0]!;

    expect(provider).toMatchObject({
      id: "note",
      label: "Docs",
      triggers: ["@"],
    });
    await expect(
      provider.search({
        trigger: "@",
        query: "launch",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:meeting-notes.md",
        title: "Standup",
        subtitle: "Personal · Launch checklist",
        icon: "FileText",
      },
    ]);
  });

  it("ignores YAML frontmatter when deriving note titles and previews", async () => {
    const { harness } = await loadNotebook({
      "defensibility.md": [
        "---",
        "type: knowledge",
        "summary: Product strategy metadata",
        "---",
        "# AI application-layer defensibility",
        "",
        "Durable product strategy.",
      ].join("\n"),
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "defensibility",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:defensibility.md",
        title: "AI application-layer defensibility",
        subtitle: "Personal · Durable product strategy.",
        icon: "FileText",
      },
    ]);
  });

  it("uses a YAML frontmatter title when the body has no document heading", async () => {
    const { harness } = await loadNotebook({
      "california-report.md": [
        "---",
        'title: "6th Annual Report: Evaluation of California\'s Caregiver Services"',
        "type: knowledge",
        "---",
        "## Key findings used in wiki",
        "",
        "CareNav assessments identify unmet caregiver needs.",
      ].join("\n"),
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "california",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:california-report.md",
        title: "6th Annual Report: Evaluation of California's Caregiver Services",
        subtitle:
          "Personal · Key findings used in wiki CareNav assessments identify unmet caregiver needs.",
        icon: "FileText",
      },
    ]);
  });

  it("drops only a heading that repeats the frontmatter title", async () => {
    const { harness } = await loadNotebook({
      "echoed-title.md": [
        "---",
        "title: Caregiver services",
        "---",
        "# Caregiver services",
        "",
        "CareNav assessments identify unmet caregiver needs.",
      ].join("\n"),
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "echoed",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:echoed-title.md",
        title: "Caregiver services",
        subtitle: "Personal · CareNav assessments identify unmet caregiver needs.",
        icon: "FileText",
      },
    ]);
  });

  it("keeps a section opened by a thematic break in the preview", async () => {
    const { harness } = await loadNotebook({
      "thematic-break.md": "---\n\nSome intro text.\n\n---\n\nMore text.\n",
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "thematic",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toMatchObject([{ subtitle: "Personal · Some intro text. More text." }]);
  });

  it("resolves the note's current content at send time", async () => {
    const { harness } = await loadNotebook({
      "ideas.md": "# Fresh Ideas\n\nBuild the mention flow.",
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(provider.resolve("personal:ideas.md")).resolves.toEqual({
      context:
        "Docs document (personal/ideas.md):\nSHA-256: test-sha\n\n# Fresh Ideas\n\nBuild the mention flow.\n\nProposal version: none. Use bb docs propose to suggest changes for approval.",
    });
    expect(harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host_primary",
          path: path.join(temporaryDirectories[0]!, "ideas.md"),
          rootPath: temporaryDirectories[0],
        },
      ],
    ]);
  });
});

describe("Docs vault operations", () => {
  it.each([false, true])(
    "lists vaults with current host records when file listing fails: %s",
    async (listingFails) => {
      const { harness } = await loadNotebook({ "draft.md": "# Draft" });
      const host = makeHostResponse();
      harness.sdk.stub("hosts.list", async () => [host]);
      if (listingFails) {
        harness.sdk.stub("files.listPaths", async () => {
          throw new Error("Host unavailable");
        });
      }

      await expect(
        harness.behavior.callRpc("listNotes", { vaultId: "personal" }),
      ).resolves.toMatchObject({
        vaults: [expect.objectContaining({ id: "personal" })],
        hosts: [
          expect.objectContaining({
            id: host.id,
            name: host.name,
            status: host.status,
          }),
        ],
        notes: listingFails ? [] : [expect.objectContaining({ path: "draft.md" })],
        error: listingFails ? "Host unavailable" : null,
      });
    },
  );

  it.each(["watch-vaults", "listNotes"] as const)(
    "creates the initial Personal vault on the server's host after a cold start, from %s",
    async (trigger) => {
      const host = createDocsHost({
        pluginId: "simple-notes",
        sdk: {
          files: {
            mkdir: async () => ({ ok: true as const }),
            listPaths: async () => ({ paths: [], truncated: false }),
          },
          hosts: { list: async () => [serverHost] },
        },
      });
      // On a cold start bb binds bb.sdk only after the factory has run.
      let sdkBound = false;
      const coldBb = new Proxy(host.bb, {
        get(target, key, receiver) {
          if (key === "sdk" && !sdkBound) throw new Error("bb.sdk is not bound yet");
          return Reflect.get(target, key, receiver);
        },
      });
      const vaults = async () =>
        JSON.parse((await host.harness.runCli(["vaults", "--json"])).stdout) as unknown;
      const notes = path.join(os.homedir(), "Notes");

      await simpleNotes(coldBb);
      expect(await vaults()).toEqual([]);

      sdkBound = true;
      if (trigger === "listNotes") {
        await expect(host.harness.callRpc("listNotes", {})).resolves.toMatchObject({
          vault: { id: "personal", hostId: "host_primary", rootPath: notes },
          error: null,
        });
      }
      // The service creates the vault, or finds it and creates nothing more.
      const service = host.harness.runService("watch-vaults");
      try {
        await waitForSignal(() =>
          host.harness.experimental_hostRpcCalls.some((call) => call.method === "watchVault"),
        );
      } finally {
        service.controller.abort();
        await service.done;
      }

      expect(await vaults()).toEqual([
        { id: "personal", name: "Personal", hostId: "host_primary", rootPath: notes },
      ]);
      expect(host.harness.sdk.callsTo("files.mkdir")).toEqual([
        [{ hostId: "host_primary", path: notes, recursive: true }],
      ]);
      expect(host.harness.realtimeSignals).toContainEqual(
        expect.objectContaining({ channel: "vault-changed", payload: { vaultId: "personal" } }),
      );
      await expect(host.harness.setSettings({ directory: "/Elsewhere" })).rejects.toThrow(
        'unknown setting "directory"',
      );
    },
  );

  it("keeps a frontmatter-managed document at its existing path", async () => {
    const { harness } = await loadNotebook({
      "stable-wiki-slug.md": [
        "---",
        "title: A different display title",
        "type: knowledge",
        "---",
        "# A different display title",
      ].join("\n"),
    });

    await expect(
      harness.callRpc("renameToTitle", {
        vaultId: "personal",
        path: "stable-wiki-slug.md",
      }),
    ).resolves.toEqual({ path: "stable-wiki-slug.md" });
    expect(harness.sdk.callsTo("files.move")).toEqual([]);
  });

  it("still follows the H1 when frontmatter has no title", async () => {
    const { harness } = await loadNotebook({
      "old-slug.md": ["---", "tags: [a]", "---", "# Brand new title"].join("\n"),
    });

    await expect(
      harness.callRpc("renameToTitle", {
        vaultId: "personal",
        path: "old-slug.md",
      }),
    ).resolves.toEqual({ path: "brand-new-title.md" });
    expect(harness.sdk.callsTo("files.move")).toHaveLength(1);
  });

  it("registers the agent-discoverable Docs CLI", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    expect(harness.registrations.cli).toMatchObject({
      name: "docs",
      summary: "Discover and safely sync Docs vaults",
    });
  });

  it("round-trips a folder edit through pull and push without changing binary assets", async () => {
    const { harness, files, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plans/plan.md": {
        content: "# Plan\n\nOriginal\n",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
      "/vault/plans/image.bin": {
        content: "AP+AQA==",
        contentEncoding: "base64",
        modifiedAtMs: 1,
      },
    });

    const pulled = await harness.runCli(["pull", "plans", "--folder", "--into", "sync", "--json"], {
      cwd: "/work",
    });
    expect(pulled).toMatchObject({ exitCode: 0 });
    expect(files.get("/work/sync/plans/image.bin")).toMatchObject({
      content: "AP+AQA==",
      contentEncoding: "base64",
    });
    expect(files.has("/work/sync/.bb-docs-state.json")).toBe(true);

    setUtf8("/work/sync/plans/plan.md", "# Plan\n\nEdited locally\n");
    const status = await harness.runCli(["status", "sync", "--diff", "--json"], { cwd: "/work" });
    expect(status.exitCode).toBe(4);
    expect(JSON.parse(status.stdout ?? "{}")).toMatchObject({
      outcome: "planned",
      writes: ["plans/plan.md"],
    });

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(pushed.exitCode).toBe(0);
    expect(files.get("/vault/plans/plan.md")?.content).toBe("# Plan\n\nEdited locally\n");
    expect(files.get("/vault/plans/image.bin")?.content).toBe("AP+AQA==");
  });

  it("pushes newly created local files with create-only semantics", async () => {
    const { harness, files, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plans/existing.md": {
        content: "existing",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await harness.runCli(["pull", "plans", "--folder", "--into", "sync", "--json"], {
      cwd: "/work",
    });
    setUtf8("/work/sync/plans/new.md", "created locally");

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });

    expect(pushed.exitCode).toBe(0);
    expect(JSON.parse(pushed.stdout ?? "{}")).toMatchObject({
      outcome: "pushed",
      writes: ["plans/new.md"],
    });
    expect(files.get("/vault/plans/new.md")?.content).toBe("created locally");
  });

  it("reconciles remotely and locally deleted empty directories safely", async () => {
    const { harness, files, directories } = await loadVirtualSyncVault({
      "/vault/folder/keep.md": {
        content: "keep",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    directories.add("/vault/folder/remote-gone");
    directories.add("/vault/folder/local-gone");
    await harness.runCli(["pull", "folder", "--folder", "--into", "sync", "--json"], {
      cwd: "/work",
    });

    directories.delete("/vault/folder/remote-gone");
    const refreshed = await harness.runCli(
      ["pull", "folder", "--folder", "--into", "sync", "--json"],
      { cwd: "/work" },
    );
    expect(refreshed.exitCode).toBe(0);
    expect(JSON.parse(refreshed.stdout ?? "{}")).toMatchObject({
      deletedDirectories: ["folder/remote-gone"],
    });
    expect(directories.has("/work/sync/folder/remote-gone")).toBe(false);

    directories.delete("/work/sync/folder/local-gone");
    const safePush = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(safePush.exitCode).toBe(0);
    expect(directories.has("/vault/folder/local-gone")).toBe(true);
    expect(JSON.parse(safePush.stdout ?? "{}")).toMatchObject({
      warnings: [{ path: "folder/local-gone" }],
    });

    const deletingPush = await harness.runCli(["push", "sync", "--delete", "--json"], {
      cwd: "/work",
    });
    expect(deletingPush.exitCode).toBe(0);
    expect(directories.has("/vault/folder/local-gone")).toBe(false);
    expect(files.has("/vault/folder/keep.md")).toBe(true);
  });

  it("preflights concurrent edits and leaves the vault copy untouched", async () => {
    const { harness, files, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    const pulled = await harness.runCli(["pull", "plan.md", "--dir", "sync", "--json"], {
      cwd: "/work",
    });
    expect(pulled.exitCode).toBe(0);
    setUtf8("/work/sync/plan.md", "local edit");
    setUtf8("/vault/plan.md", "remote edit");

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(pushed.exitCode).toBe(3);
    expect(JSON.parse(pushed.stdout ?? "{}")).toMatchObject({
      outcome: "conflict",
      conflicts: [{ path: "plan.md", reason: "both local and vault copies changed" }],
    });
    expect(files.get("/vault/plan.md")?.content).toBe("remote edit");
  });

  it("reports a post-preflight CAS race as a conflict when nothing applied", async () => {
    const { harness, files, setUtf8, conflictNextWrite } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await harness.runCli(["pull", "plan.md", "--into", "sync"], {
      cwd: "/work",
    });
    setUtf8("/work/sync/plan.md", "local edit");
    conflictNextWrite("/vault/plan.md", "raced remote edit");

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });

    expect(pushed.exitCode).toBe(3);
    expect(JSON.parse(pushed.stdout ?? "{}")).toMatchObject({
      outcome: "conflict",
      applied: {
        outcome: "conflict",
        written: [],
        conflicts: [{ path: "plan.md" }],
      },
    });
    expect(files.get("/vault/plan.md")?.content).toBe("raced remote edit");
  });

  it("rejects apply-level path collisions and reports only newly created directories", async () => {
    const { harness, directories } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    directories.add("/vault/existing");
    const emptyApply = {
      vaultId: "personal",
      writes: [],
      deletes: [],
      deleteDirectories: [],
      dryRun: false,
    };

    await expect(
      harness.callRpc("syncApply", {
        ...emptyApply,
        directories: ["New", "new"],
      }),
    ).rejects.toThrow(/collide/);
    await expect(
      harness.callRpc("syncApply", {
        ...emptyApply,
        directories: [],
        writes: [
          {
            path: "PLAN.md",
            content: "collision",
            contentEncoding: "utf8",
            expectedSha256: null,
          },
        ],
      }),
    ).rejects.toThrow(/collide/);

    const applied = await harness.callRpc("syncApply", {
      ...emptyApply,
      directories: ["existing", "created"],
    });
    expect(applied).toMatchObject({
      outcome: "applied",
      createdDirectories: ["created"],
      deletedDirectories: [],
    });
  });

  it("ignores local deletions by default and applies them only with --delete", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/archive/old.md": {
        content: "old",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await harness.runCli(["pull", "archive", "--folder", "--into", "sync"], {
      cwd: "/work",
    });
    files.delete("/work/sync/archive/old.md");

    const safePush = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(safePush.exitCode).toBe(0);
    expect(files.has("/vault/archive/old.md")).toBe(true);
    expect(JSON.parse(safePush.stdout ?? "{}")).toMatchObject({
      warnings: [{ path: "archive/old.md" }],
    });

    const deletingPush = await harness.runCli(["push", "sync", "--delete", "--json"], {
      cwd: "/work",
    });
    expect(deletingPush.exitCode).toBe(0);
    expect(files.has("/vault/archive/old.md")).toBe(false);
  });

  it("fails closed on malformed sync state with machine-readable output", async () => {
    const { harness, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    setUtf8("/work/sync/.bb-docs-state.json", "{not-json");

    const result = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
      ok: false,
      error: {
        code: "operation_failed",
        message: expect.stringContaining(".bb-docs-state.json is malformed"),
      },
    });
    expect(result.stderr).toContain(".bb-docs-state.json is malformed");
  });

  it("supports whole-vault and single-file scopes and deprecates direct writes", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/a.md": {
        content: "A",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
      "/vault/nested/b.md": {
        content: "B",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await expect(
      harness.runCli(["pull", "a.md", "--into", "one"], { cwd: "/work" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(files.has("/work/one/a.md")).toBe(true);
    expect(files.has("/work/one/nested/b.md")).toBe(false);
    await expect(
      harness.runCli(["pull", "nested/b.md", "--into", "nested-one"], {
        cwd: "/work",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(harness.runCli(["status", "nested-one"], { cwd: "/work" })).resolves.toMatchObject(
      { exitCode: 0 },
    );
    await expect(
      harness.runCli(["pull", "--all", "--into", "all"], { cwd: "/work" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(files.has("/work/all/nested/b.md")).toBe(true);

    const direct = await harness.runCli(["write", "legacy.md", "--content", "legacy"]);
    expect(direct).toMatchObject({ exitCode: 0 });
    expect(direct.stderr).toContain("Deprecated");
  });

  it("renders top-level help successfully and rejects inapplicable flags before mutation", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });

    const help = await harness.runCli(["--help"]);
    expect(help).toMatchObject({ exitCode: 0 });
    expect(help.stdout).toContain("bb docs pull");
    expect(help.stdout).toContain("bb docs status");
    expect(help.stdout).toContain("bb docs push");

    const statusHelp = await harness.runCli(["status", "--help"]);
    expect(statusHelp).toMatchObject({ exitCode: 0 });
    expect(statusHelp.stdout).toContain("Exit 4: changes present");
    expect(statusHelp.stdout).toContain("run bb docs push separately");
    expect(statusHelp.stdout).toContain("[<workspace-dir>]");

    const unsafePull = await harness.runCli(
      ["pull", "plan.md", "--into", "sync", "--dry-run", "--json"],
      { cwd: "/work" },
    );
    expect(unsafePull.exitCode).toBe(2);
    expect(JSON.parse(unsafePull.stdout ?? "{}")).toMatchObject({
      ok: false,
      error: {
        code: "unknown_option",
        message: "unknown option '--dry-run'",
      },
    });
    expect(unsafePull.stderr).toContain("unknown option '--dry-run'");
    expect(files.has("/work/sync/plan.md")).toBe(false);

    const unsafeRemove = await harness.runCli(["remove", "plan.md", "--dry-run", "--json"]);
    expect(unsafeRemove.exitCode).toBe(2);
    expect(files.has("/vault/plan.md")).toBe(true);

    const noCommand = await harness.runCli([]);
    expect(noCommand.exitCode).toBe(2);
    expect(noCommand.stdout).toContain("bb docs <command> [options]");

    const unknownCommand = await harness.runCli(["pul", "plan.md"]);
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("unknown command 'pul' (Did you mean pull?)");

    const strayArgument = await harness.runCli(["vaults", "personal"]);
    expect(strayArgument.exitCode).toBe(2);
    expect(strayArgument.stderr).toContain("unexpected argument 'personal'");

    const missingOptions = await harness.runCli(["write", "plan.md"]);
    expect(missingOptions.exitCode).toBe(2);
    expect(missingOptions.stderr).toContain("missing required options: --content");

    const missingArguments = await harness.runCli(["move"]);
    expect(missingArguments.exitCode).toBe(2);
    expect(missingArguments.stderr).toContain("missing required arguments: <from>, <to>");

    const combined = await harness.runCli(["pull", "--all", "--folder", "--into", "sync"], {
      cwd: "/work",
    });
    expect(combined.exitCode).toBe(2);
    expect(combined.stderr).toContain("--all and --folder cannot be combined");
    expect(files.has("/work/sync/plan.md")).toBe(false);

    for (const argv of [["push", "--help"], ["remove", "-h"], ["help"]]) {
      const commandHelp = await harness.runCli(argv);
      expect(commandHelp.exitCode).toBe(0);
      expect(commandHelp.stderr).toBe("");
      expect(commandHelp.stdout).toContain("Usage:");
    }
  });

  it("keeps CLI removal non-recursive unless --recursive is passed", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const rootPath = temporaryDirectories[0]!;

    await expect(harness.runCli(["remove", "empty"])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(harness.runCli(["remove", "archive", "--recursive"])).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(harness.sdk.callsTo("files.remove")).toEqual([
      [
        {
          hostId: "host_primary",
          path: path.join(rootPath, "empty"),
          rootPath,
          recursive: false,
        },
      ],
      [
        {
          hostId: "host_primary",
          path: path.join(rootPath, "archive"),
          rootPath,
          recursive: true,
        },
      ],
    ]);
  });

  it("persists a manual file order per vault folder", async () => {
    const { harness } = await loadNotebook({
      "first.md": "# First",
      "second.md": "# Second",
    });

    await expect(
      harness.callRpc("reorderFiles", {
        vaultId: "personal",
        parent: "",
        paths: ["second.md", "first.md"],
      }),
    ).resolves.toEqual({ paths: ["second.md", "first.md"] });

    await expect(harness.callRpc("listNotes", { vaultId: "personal" })).resolves.toMatchObject({
      entryOrder: ["second.md", "first.md"],
    });
  });

  it("keeps nested mutations confined to the selected vault root", async () => {
    const { harness } = await loadNotebook({ "draft.md": "# Draft" });
    const rootPath = temporaryDirectories[0]!;

    await expect(
      harness.callRpc("createFolder", {
        vaultId: "personal",
        path: "projects",
      }),
    ).resolves.toEqual({ path: "projects" });
    await expect(
      harness.callRpc("movePath", {
        vaultId: "personal",
        from: "draft.md",
        to: "projects/plan.md",
      }),
    ).resolves.toEqual({ path: "projects/plan.md" });

    expect(harness.sdk.callsTo("files.mkdir")).toEqual([
      [
        {
          hostId: "host_primary",
          path: path.join(rootPath, "projects"),
          rootPath,
          recursive: false,
        },
      ],
    ]);
    expect(harness.sdk.callsTo("files.move")).toEqual([
      [
        {
          hostId: "host_primary",
          sourcePath: path.join(rootPath, "draft.md"),
          destinationPath: path.join(rootPath, "projects", "plan.md"),
          rootPath,
        },
      ],
    ]);
  });

  it("opens and saves a thread's absolute host file on the thread's machine", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
      if (environmentId !== "env_mac") throw new Error(`Unknown environment: ${environmentId}`);
      return { id: "env_mac", hostId: "host_mac" };
    });
    const rootPath = temporaryDirectories[0]!;
    const filePath = path.join(rootPath, "plan.md");
    // bb's shape for a thread's host file: its environment, no host id.
    const source = {
      kind: "host",
      threadId: "thread_1",
      environmentId: "env_mac",
      projectId: null,
    };

    await expect(harness.callRpc("openFile", { source, path: filePath })).resolves.toMatchObject({
      file: { content: "# Plan", sha256: "test-sha" },
      previewPath: "plan.md",
      hostId: "host_mac",
    });
    await expect(
      harness.callRpc("saveOpenedFile", {
        source,
        path: filePath,
        content: "# Updated",
        expectedSha256: "test-sha",
      }),
    ).resolves.toMatchObject({ outcome: "written", sha256: "written-sha" });
    expect(harness.sdk.callsTo("files.read")).toEqual([
      [{ hostId: "host_mac", path: filePath, rootPath }],
    ]);
    expect(harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_mac", rootPath }],
    ]);
    expect(harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_mac",
          path: filePath,
          rootPath,
          content: "# Updated",
          expectedSha256: "test-sha",
        },
      ],
    ]);
  });

  it("resolves a thread's host file through the thread when bb omits the environment", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    harness.sdk.stub("threads.get", async () => ({ id: "thread_1", environmentId: "env_mac" }));
    harness.sdk.stub("environments.get", async () => ({ id: "env_mac", hostId: "host_mac" }));
    const filePath = path.join(temporaryDirectories[0]!, "plan.md");
    const source = { kind: "host", threadId: "thread_1", environmentId: null, projectId: null };

    // The opened file is watched on its host, which answers only its hash.
    await expect(
      harness.callRpc("watchOpenedFile", { source, path: filePath }),
    ).resolves.toMatchObject({
      sha256: createHash("sha256").update("# Plan").digest("hex"),
      renewWithinMs: 60_000,
    });
    expect(
      harness.experimental_hostRpcCalls
        .filter((call) => call.method === "watchFile")
        .map(({ hostId, input }) => ({ hostId, path: (input as { path: string }).path })),
    ).toEqual([{ hostId: "host_mac", path: filePath }]);
    expect(harness.sdk.callsTo("files.read")).toEqual([]);

    await expect(
      harness.callRpc("watchOpenedFile", {
        source: { kind: "host", threadId: null, environmentId: null, projectId: null },
        path: filePath,
      }),
    ).rejects.toThrow("Cannot resolve the machine that holds this file");
  });

  it("relays an opened file's change from its host to the page watching it", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    harness.sdk.stub("threads.get", async () => ({ id: "thread_1", environmentId: "env_mac" }));
    harness.sdk.stub("environments.get", async () => ({ id: "env_mac", hostId: "host_mac" }));
    const filePath = path.join(temporaryDirectories[0]!, "plan.md");
    const source = { kind: "host", threadId: "thread_1", environmentId: null, projectId: null };
    const { watchId } = (await harness.callRpc("watchOpenedFile", { source, path: filePath })) as {
      watchId: string;
    };
    const stopRead = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: filePath },
    });
    await waitForSignal(
      () =>
        harness.experimental_hostRpcCalls.filter((call) => call.method === "watchFile").length ===
        2,
    );
    const sha256 = "a".repeat(64);
    const published = harness.realtimeSignals.length;

    await harness.behavior.experimental_emitHostSignal("host_other", "fileChanged", {
      watchId,
      sha256,
    });
    await harness.behavior.experimental_emitHostSignal("host_mac", "fileChanged", {
      watchId,
      sha256,
    });
    // A restarted worker lost the watch; the page re-arms and compares.
    await harness.behavior.experimental_emitHostWorkerExit("host_mac");
    expect(harness.realtimeSignals.slice(published)).toEqual([
      expect.objectContaining({ channel: "opened-file-changed", payload: { watchId, sha256 } }),
      expect.objectContaining({ channel: "opened-file-changed", payload: { watchId } }),
    ]);
    await waitForSignal(
      () =>
        harness.experimental_hostRpcCalls.filter((call) => call.method === "watchFile").length ===
        3,
    );
    expect(harness.inspection.experimental_rpcInvalidations.flat()).toEqual(
      expect.arrayContaining([expect.stringContaining("opened:")]),
    );
    stopRead();
    await harness.lifecycle.dispose();
  });

  it("checks that a previewed note exists on its host without reading it", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    await expect(
      harness.callRpc("preparePreview", { vaultId: "personal", path: "plan.md" }),
    ).resolves.toMatchObject({ baseUrl: "/api/v1/file-previews/test" });
    await expect(
      harness.callRpc("preparePreview", { vaultId: "personal", path: "missing.md" }),
    ).rejects.toThrow("File not found: missing.md");
    expect(harness.sdk.callsTo("files.read")).toEqual([]);
    expect(
      harness.experimental_hostRpcCalls.filter((call) => call.method === "statFile"),
    ).toHaveLength(2);
  });

  it("routes explicit host opener reads, previews, and saves to that host", async () => {
    const rootPath = "/shared";
    const filePath = "/shared/plan.md";
    const host = createDocsHost({
      pluginId: "simple-notes",
      sdk: {
        files: {
          mkdir: async () => ({ ok: true as const }),
          read: async ({ hostId, path: openedPath }) => ({
            path: openedPath,
            content: hostId === "host_remote" ? "# Remote plan" : "# Primary plan",
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: 13,
            modifiedAtMs: 1,
            sha256: hostId === "host_remote" ? "remote-sha" : "primary-sha",
          }),
          write: async ({ hostId }) => ({
            outcome: "written" as const,
            sha256: hostId === "host_remote" ? "remote-written-sha" : "primary-written-sha",
            sizeBytes: 21,
          }),
          createPreview: async ({ hostId }) => ({
            baseUrl: hostId === "host_remote" ? "/remote-preview" : "/primary-preview",
            expiresAtMs: Date.now() + 60_000,
          }),
        },
      },
    });
    await simpleNotes(host.bb);
    host.harness.sdk.calls.length = 0;
    const source = {
      kind: "host",
      threadId: "thread_1",
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    };

    await expect(host.harness.callRpc("openFile", { source, path: filePath })).resolves.toEqual({
      file: {
        path: filePath,
        content: "# Remote plan",
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: 13,
        modifiedAtMs: 1,
        sha256: "remote-sha",
      },
      preview: expect.objectContaining({ baseUrl: "/remote-preview" }),
      previewPath: "plan.md",
      hostId: "host_remote",
    });
    await expect(
      host.harness.callRpc("saveOpenedFile", {
        source,
        path: filePath,
        content: "# Updated remote plan",
        expectedSha256: "remote-sha",
      }),
    ).resolves.toEqual({
      outcome: "written",
      sha256: "remote-written-sha",
      sizeBytes: 21,
    });

    expect(host.harness.sdk.callsTo("files.read")).toEqual([
      [{ hostId: "host_remote", path: filePath, rootPath }],
    ]);
    expect(host.harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_remote", rootPath }],
    ]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_remote",
          path: filePath,
          rootPath,
          content: "# Updated remote plan",
          expectedSha256: "remote-sha",
        },
      ],
    ]);
  });

  it("routes project-backed workspace files through the selected or primary source", async () => {
    const host = createDocsHost({
      pluginId: "simple-notes",
      sdk: {
        files: {
          mkdir: async () => ({ ok: true as const }),
          read: async ({ path: openedPath }) => ({
            path: openedPath,
            content: "# Project plan",
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: 14,
            modifiedAtMs: 1,
            sha256: "project-sha",
          }),
          write: async () => ({
            outcome: "written" as const,
            sha256: "project-written-sha",
            sizeBytes: 22,
          }),
          createPreview: async () => ({
            baseUrl: "/project-preview",
            expiresAtMs: Date.now() + 60_000,
          }),
        },
        projects: {
          get: async () => ({
            sources: [
              {
                hostId: "host_remote",
                path: "/remote/project",
                isDefault: true,
                type: "local_path",
              },
              {
                hostId: "host_primary",
                path: "/primary/project",
                isDefault: false,
                type: "local_path",
              },
            ],
          }),
        },
        system: {
          config: async () => ({ primaryHostId: "host_primary" }),
        },
      },
    });
    await simpleNotes(host.bb);
    host.harness.sdk.calls.length = 0;
    const selectedSource = {
      kind: "workspace",
      threadId: null,
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    };

    await expect(
      host.harness.callRpc("openFile", {
        source: selectedSource,
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({ previewPath: "docs/plan.md" });
    await expect(
      host.harness.callRpc("saveOpenedFile", {
        source: selectedSource,
        path: "docs/plan.md",
        content: "# Updated project plan",
        expectedSha256: "project-sha",
      }),
    ).resolves.toMatchObject({ outcome: "written" });
    await expect(
      host.harness.callRpc("openFile", {
        source: {
          kind: "workspace",
          threadId: null,
          environmentId: null,
          projectId: "project_1",
        },
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({
      previewPath: "docs/plan.md",
    });
    await expect(
      host.harness.callRpc("openFile", {
        source: { ...selectedSource, experimental_hostId: "host_missing" },
        path: "docs/plan.md",
      }),
    ).rejects.toThrow("This project has no workspace on the selected host");

    expect(host.harness.sdk.callsTo("projects.get")).toEqual([
      [{ projectId: "project_1" }],
      [{ projectId: "project_1" }],
      [{ projectId: "project_1" }],
      [{ projectId: "project_1" }],
    ]);
    expect(host.harness.sdk.callsTo("system.config")).toEqual([[]]);
    expect(host.harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host_remote",
          path: "/remote/project/docs/plan.md",
          rootPath: "/remote/project",
        },
      ],
      [
        {
          hostId: "host_primary",
          path: "/primary/project/docs/plan.md",
          rootPath: "/primary/project",
        },
      ],
    ]);
    expect(host.harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_remote", rootPath: "/remote/project" }],
      [{ hostId: "host_primary", rootPath: "/primary/project" }],
    ]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_remote",
          path: "/remote/project/docs/plan.md",
          rootPath: "/remote/project",
          content: "# Updated project plan",
          expectedSha256: "project-sha",
        },
      ],
    ]);
  });

  it("opens and saves thread-storage Markdown files on the thread's host", async () => {
    const storageRootPath = String.raw`C:\bb\thread-storage\thread_1`;
    const openedPath = String.raw`C:\bb\thread-storage\thread_1\reports\plan.md`;
    const host = createDocsHost({
      pluginId: "simple-notes",
      sdk: {
        files: {
          mkdir: async () => ({ ok: true as const }),
          read: async ({ path: filePath }) => ({
            path: filePath,
            content: "# Thread plan",
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: 13,
            modifiedAtMs: 1,
            sha256: "thread-sha",
          }),
          write: async () => ({
            outcome: "written" as const,
            sha256: "updated-thread-sha",
            sizeBytes: 17,
          }),
          createPreview: async () => ({
            baseUrl: "/api/v1/file-previews/thread-storage",
            expiresAtMs: Date.now() + 60_000,
          }),
        },
        threads: {
          storageLocation: async () => ({
            hostId: "host_remote",
            storageRootPath,
          }),
        },
      },
    });
    await simpleNotes(host.bb);
    host.harness.sdk.calls.length = 0;
    const source = {
      kind: "thread-storage",
      threadId: "thread_1",
      environmentId: "stale_environment",
      projectId: "project_1",
    };

    await expect(
      host.harness.callRpc("openFile", {
        source,
        path: "reports/plan.md",
      }),
    ).resolves.toMatchObject({
      file: { content: "# Thread plan", sha256: "thread-sha" },
      previewPath: "reports/plan.md",
    });
    await expect(
      host.harness.callRpc("saveOpenedFile", {
        source,
        path: "reports/plan.md",
        content: "# Updated thread",
        expectedSha256: "thread-sha",
      }),
    ).resolves.toMatchObject({
      outcome: "written",
      sha256: "updated-thread-sha",
    });

    expect(host.harness.sdk.callsTo("threads.storageLocation")).toEqual([
      [{ threadId: "thread_1" }],
      [{ threadId: "thread_1" }],
    ]);
    expect(host.harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host_remote",
          path: openedPath,
          rootPath: storageRootPath,
        },
      ],
    ]);
    expect(host.harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_remote", rootPath: storageRootPath }],
    ]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_remote",
          path: openedPath,
          rootPath: storageRootPath,
          content: "# Updated thread",
          expectedSha256: "thread-sha",
        },
      ],
    ]);
  });

  it("rejects thread-storage paths that escape the confined root", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });

    await expect(
      harness.callRpc("openFile", {
        source: {
          kind: "thread-storage",
          threadId: "thread_1",
          environmentId: "environment_1",
          projectId: "project_1",
        },
        path: "../outside.md",
      }),
    ).rejects.toThrow("Invalid thread-storage path");
    expect(harness.sdk.callsTo("threads.storageLocation")).toEqual([]);
  });

  it("watches each vault on its own host and publishes its changes without rereading", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const rootPath = temporaryDirectories[0]!;
    const provider = harness.registrations.mentionProviders[0]!;
    const context = { trigger: "@" as const, query: "", projectId: null, threadId: null };
    expect(await provider.search(context)).toMatchObject([{ title: "Plan" }]);
    const service = harness.runService("watch-vaults");
    try {
      // Arming publishes once: changes made before the watch started are unknown.
      await waitForSignal(() =>
        harness.realtimeSignals.some((signal) => signal.channel === "vault-changed"),
      );
      expect(
        harness.experimental_hostRpcCalls
          .filter((call) => call.method === "watchVault")
          .map(({ hostId, input }) => ({ hostId, input })),
      ).toEqual([{ hostId: "host_primary", input: { vaultId: "personal", rootPath } }]);
      const published = harness.realtimeSignals.length;
      const reads = harness.sdk.callsTo("files.read").length;

      await harness.behavior.experimental_emitHostSignal("host_other", "vaultChanged", {
        vaultId: "personal",
        kind: "changed",
      });
      expect(harness.realtimeSignals.slice(published)).toEqual([]);

      await harness.behavior.experimental_emitHostSignal("host_primary", "vaultChanged", {
        vaultId: "personal",
        kind: "changed",
      });
      expect(harness.realtimeSignals.slice(published)).toEqual([
        expect.objectContaining({ channel: "vault-changed", payload: { vaultId: "personal" } }),
      ]);
      expect(harness.sdk.callsTo("files.read")).toHaveLength(reads);

      await writeFile(path.join(rootPath, "plan.md"), "# Updated");
      expect(await provider.search(context)).toMatchObject([{ title: "Updated" }]);

      // The watcher's report of this server's own save is its echo: the save
      // already announced it, with the hash the saving document holds.
      const savedSha = "b".repeat(64);
      harness.sdk.stub("files.write", async () => ({
        outcome: "written",
        sha256: savedSha,
        sizeBytes: 7,
      }));
      await harness.callRpc("saveNote", {
        vaultId: "personal",
        path: "plan.md",
        content: "# Saved",
      });
      const afterSave = harness.realtimeSignals.length;
      expect(harness.realtimeSignals.at(-1)).toMatchObject({
        channel: "vault-changed",
        payload: { vaultId: "personal", path: "plan.md", sha256: savedSha },
      });
      await harness.behavior.experimental_emitHostSignal("host_primary", "vaultChanged", {
        vaultId: "personal",
        kind: "changed",
        changes: [{ path: "plan.md", sha256: savedSha }],
      });
      expect(harness.realtimeSignals.slice(afterSave)).toEqual([]);
      await harness.behavior.experimental_emitHostSignal("host_primary", "vaultChanged", {
        vaultId: "personal",
        kind: "changed",
        changes: [
          { path: "plan.md", sha256: savedSha },
          { path: "agent.md", sha256: "c".repeat(64) },
        ],
      });
      expect(harness.realtimeSignals.slice(afterSave)).toEqual([
        expect.objectContaining({
          channel: "vault-changed",
          payload: { vaultId: "personal", paths: ["agent.md"] },
        }),
      ]);

      // Someone changes the note, then restores what was saved: that is theirs, not an echo.
      const beforeRevert = harness.realtimeSignals.length;
      for (const sha256 of ["d".repeat(64), savedSha]) {
        await harness.behavior.experimental_emitHostSignal("host_primary", "vaultChanged", {
          vaultId: "personal",
          kind: "changed",
          changes: [{ path: "plan.md", sha256 }],
        });
      }
      expect(harness.realtimeSignals.slice(beforeRevert)).toEqual([
        expect.objectContaining({ payload: { vaultId: "personal", paths: ["plan.md"] } }),
        expect.objectContaining({ payload: { vaultId: "personal", paths: ["plan.md"] } }),
      ]);
    } finally {
      service.controller.abort();
      await service.done;
    }
    expect(
      harness.experimental_hostRpcCalls
        .filter((call) => call.method === "unwatchVault")
        .map(({ hostId, input }) => ({ hostId, input })),
    ).toEqual([{ hostId: "host_primary", input: { vaultId: "personal" } }]);
  });

  it("re-arms a vault watch after its host worker restarts", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const watchCalls = () =>
      harness.experimental_hostRpcCalls.filter((call) => call.method === "watchVault").length;
    const service = harness.runService("watch-vaults");
    try {
      await waitForSignal(() => watchCalls() === 1);
      await harness.behavior.experimental_emitHostWorkerExit("host_primary");
      await waitForSignal(() => watchCalls() === 2);
    } finally {
      service.controller.abort();
      await service.done;
    }
  });

  // The service checks its watches every 10 s; fake timers run those polls.
  async function advanceUntil(predicate: () => boolean): Promise<void> {
    for (let elapsed = 0; !predicate(); elapsed += 1_000) {
      if (elapsed > 60_000) throw new Error("Timed out waiting for signal");
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }

  it("re-arms a vault watch its host lost without a worker exit", async () => {
    const { harness, hostWatches } = await loadNotebook({ "plan.md": "# Plan" });
    const rootPath = temporaryDirectories[0]!;
    const watchCalls = () =>
      harness.experimental_hostRpcCalls
        .filter((call) => call.method === "watchVault")
        .map(({ hostId, input }) => ({ hostId, input }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = harness.runService("watch-vaults");
    try {
      await advanceUntil(() => watchCalls().length === 1);
      // The daemon restarted and reconnected between two polls: no worker
      // exit, no disconnect seen, and the new daemon holds no watches.
      hostWatches.get("host_primary")!.clear();
      const published = harness.realtimeSignals.length;
      await advanceUntil(() => watchCalls().length === 2);
      expect(watchCalls()).toEqual([
        { hostId: "host_primary", input: { vaultId: "personal", rootPath } },
        { hostId: "host_primary", input: { vaultId: "personal", rootPath } },
      ]);
      expect(harness.realtimeSignals.slice(published)).toContainEqual(
        expect.objectContaining({ channel: "vault-changed", payload: { vaultId: "personal" } }),
      );
    } finally {
      service.controller.abort();
      await service.done;
      vi.useRealTimers();
    }
  });

  it("re-arms a vault watch when its host comes back", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const watchCalls = () =>
      harness.experimental_hostRpcCalls.filter((call) => call.method === "watchVault").length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = harness.runService("watch-vaults");
    try {
      await advanceUntil(() => watchCalls() === 1);
      harness.sdk.stub("hosts.list", async () => [{ ...serverHost, status: "disconnected" }]);
      const polls = harness.sdk.callsTo("hosts.list").length;
      await advanceUntil(() => harness.sdk.callsTo("hosts.list").length > polls);
      expect(watchCalls()).toBe(1);

      harness.sdk.stub("hosts.list", async () => [serverHost]);
      await advanceUntil(() => watchCalls() === 2);
    } finally {
      service.controller.abort();
      await service.done;
      vi.useRealTimers();
    }
  });

  it("arms the other vaults while one host is slow, then waits for it instead of asking again", async () => {
    const stalled: AbortSignal[] = [];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { bb, harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      {
        // This machine subscribes a large tree. Like the host entry, it
        // ignores cancellation and answers once its watch is set up.
        watchVault: async ({ hostId, signal }) => {
          if (hostId !== "host_mac") return;
          stalled.push(signal!);
          await answered;
        },
      },
    );
    const insert = bb.storage
      .database()
      .prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
      );
    // Listed first, so arming one vault at a time would wait on it.
    insert.run("obsidian", "Obsidian", "host_mac", "/Users/me/obsidian-vault", 1);
    insert.run("dotfiles", "Dotfiles", "host_dev", "/Users/me/dotfiles", Date.now() + 1);
    harness.sdk.stub("hosts.list", async () => [
      makeHostResponse({ id: "host_mac", name: "Asleep Mac" }),
      makeHostResponse({ id: "host_dev", name: "Build Mac" }),
      serverHost,
    ]);
    const published = (vaultId: string) =>
      harness.realtimeSignals.some(
        (signal) =>
          signal.channel === "vault-changed" &&
          (signal.payload as { vaultId?: string }).vaultId === vaultId,
      );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = harness.runService("watch-vaults");
    try {
      await advanceUntil(() => published("personal") && published("dotfiles"));
      // Armed while the slow call was still waiting, not after it gave up.
      expect(stalled).toHaveLength(1);
      expect(stalled[0]!.aborted).toBe(false);
      // Later polls neither cancel the slow call nor replace it with another.
      const polls = harness.sdk.callsTo("hosts.list").length;
      await advanceUntil(() => harness.sdk.callsTo("hosts.list").length >= polls + 3);
      expect(stalled).toHaveLength(1);
      expect(stalled[0]!.aborted).toBe(false);
      expect(published("obsidian")).toBe(false);

      // Once the host answers, its vault is watched.
      answer();
      await advanceUntil(() => published("obsidian"));
      const before = harness.realtimeSignals.length;
      await harness.behavior.experimental_emitHostSignal("host_mac", "vaultChanged", {
        vaultId: "obsidian",
        kind: "changed",
      });
      expect(harness.realtimeSignals.slice(before)).toEqual([
        expect.objectContaining({ channel: "vault-changed", payload: { vaultId: "obsidian" } }),
      ]);
      const armedPolls = harness.sdk.callsTo("hosts.list").length;
      await advanceUntil(() => harness.sdk.callsTo("hosts.list").length >= armedPolls + 2);
      expect(stalled).toHaveLength(1);
    } finally {
      service.controller.abort();
      await service.done;
      vi.useRealTimers();
    }
  });

  it("unwatches a vault removed while its host was still arming it", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { bb, harness, hostWatches } = await loadNotebook(
      { "plan.md": "# Plan" },
      {
        watchVault: async ({ vaultId }) => {
          if (vaultId === "work") await answered;
        },
      },
    );
    bb.storage
      .database()
      .prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES ('work', 'Work', 'host_primary', '/srv/work', ?)",
      )
      .run(Date.now() + 1);
    const calls = (method: string) =>
      harness.experimental_hostRpcCalls.filter(
        (call) => call.method === method && (call.input as { vaultId?: string }).vaultId === "work",
      );
    const polls = () => harness.sdk.callsTo("hosts.list").length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = harness.runService("watch-vaults");
    try {
      await advanceUntil(() => calls("watchVault").length === 1);
      // The host is still subscribing after the poll stops waiting for it.
      await vi.advanceTimersByTimeAsync(15_000);
      await harness.callRpc("removeVault", { vaultId: "work" });
      const removedAt = polls();
      await advanceUntil(() => polls() > removedAt);
      // The host finishes the watch the removed vault no longer needs.
      answer();
      await advanceUntil(() => calls("unwatchVault").length > 0);
      expect(hostWatches.get("host_primary")!.has("work")).toBe(false);
      expect(calls("watchVault")).toHaveLength(1);
      expect(
        harness.realtimeSignals.some(
          (signal) =>
            signal.channel === "vault-changed" &&
            (signal.payload as { vaultId?: string }).vaultId === "work",
        ),
      ).toBe(false);
    } finally {
      service.controller.abort();
      await service.done;
      vi.useRealTimers();
    }
  });

  it("runs one edit at a time per vault without holding up other vaults", async () => {
    const { bb, harness } = await loadNotebook({ "plan.md": "# Plan" });
    bb.storage
      .database()
      .prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES ('work', 'Work', 'host_primary', '/srv/work', ?)",
      )
      .run(Date.now() + 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    harness.sdk.stub("files.write", async ({ path: filePath }: { path: string }) => {
      written.push(path.basename(filePath));
      if (filePath.endsWith("first.md")) await held;
      return { outcome: "written" as const, sha256: "written-sha", sizeBytes: 1 };
    });
    const save = (vaultId: string, notePath: string) =>
      harness.callRpc("saveNote", { vaultId, path: notePath, content: "# Note" });

    const first = save("personal", "first.md");
    await waitForSignal(() => written.length === 1);
    const second = save("personal", "second.md");
    await expect(save("work", "other.md")).resolves.toMatchObject({ outcome: "written" });
    expect(written).toEqual(["first.md", "other.md"]);

    release();
    await Promise.all([first, second]);
    expect(written).toEqual(["first.md", "other.md", "second.md"]);
  });
});

describe("Docs proposals", () => {
  async function setupProposal() {
    const host = await loadVirtualSyncVault({
      "/vault/letter.md": {
        content: "A simple place.",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    const file = host.files.get("/vault/letter.md")!;
    const proposal = await host.harness.behavior.callRpc("proposeNote", {
      path: "letter.md",
      content: "A calmer space.",
      expectedSha256: virtualSha(file),
      expectedVersion: null,
    });
    return { ...host, proposal };
  }

  it("moves proposals with files and folders and clears removed paths", async () => {
    const { harness, setUtf8 } = await setupProposal();
    await harness.behavior.callRpc("movePath", {
      from: "letter.md",
      to: "drafts/letter.md",
    });
    expect(await harness.behavior.callRpc("readProposal", { path: "letter.md" })).toBeNull();
    expect(
      await harness.behavior.callRpc("readProposal", {
        path: "drafts/letter.md",
      }),
    ).toMatchObject({ path: "drafts/letter.md", content: "A calmer space." });
    await harness.behavior.callRpc("movePath", {
      from: "drafts",
      to: "renamed",
    });
    expect(
      await harness.behavior.callRpc("readProposal", {
        path: "renamed/letter.md",
      }),
    ).toMatchObject({ path: "renamed/letter.md" });
    await harness.behavior.callRpc("resolveProposal", {
      path: "renamed/letter.md",
      action: "accept",
      expectedVersion: 1,
    });
    await harness.behavior.callRpc("deletePath", {
      path: "renamed",
      recursive: true,
    });
    setUtf8("/vault/renamed/letter.md", "Unrelated document");
    expect(
      await harness.behavior.callRpc("readProposal", {
        path: "renamed/letter.md",
      }),
    ).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("cleans file proposals after queued edits and preserves them on failed moves", async () => {
    const { harness, setUtf8 } = await setupProposal();
    setUtf8("/vault/existing.md", "Another document");
    await expect(
      harness.behavior.callRpc("movePath", {
        from: "letter.md",
        to: "existing.md",
      }),
    ).rejects.toThrow("EEXIST");
    await Promise.all([
      harness.behavior.callRpc("updateProposal", {
        path: "letter.md",
        expectedVersion: 1,
        content: "Updated",
      }),
      harness.behavior.callRpc("deletePath", { path: "letter.md" }),
    ]);
    setUtf8("/vault/letter.md", "Replacement");
    expect(await harness.behavior.callRpc("readProposal", { path: "letter.md" })).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("does not expose proposals when a removed vault ID is reused", async () => {
    const { harness } = await setupProposal();
    await harness.behavior.callRpc("createVault", {
      name: "Other",
      rootPath: "/other",
    });
    await harness.behavior.callRpc("removeVault", { vaultId: "personal" });
    await harness.behavior.callRpc("createVault", {
      name: "Personal",
      rootPath: "/replacement",
    });
    expect(
      await harness.behavior.callRpc("readProposal", {
        vaultId: "personal",
        path: "letter.md",
      }),
    ).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("keeps candidates separate and restores diff after accept, undo, redo", async () => {
    const { harness, files } = await setupProposal();
    expect(files.get("/vault/letter.md")?.content).toBe("A simple place.");
    await harness.behavior.callRpc("resolveProposal", {
      path: "letter.md",
      expectedVersion: 1,
      action: "accept",
    });
    expect(files.get("/vault/letter.md")?.content).toBe("A calmer space.");
    await harness.behavior.callRpc("resolveProposal", {
      path: "letter.md",
      expectedVersion: 2,
      action: "undo",
    });
    expect(files.get("/vault/letter.md")?.content).toBe("A simple place.");
    expect(
      await harness.behavior.callRpc("resolveProposal", {
        path: "letter.md",
        expectedVersion: 3,
        action: "redo",
      }),
    ).toMatchObject({ status: "pending", version: 4 });
    expect(files.get("/vault/letter.md")?.content).toBe("A simple place.");
    const reloaded = await harness.lifecycle.reload(simpleNotes);
    expect(
      await reloaded.harness.behavior.callRpc("readProposal", {
        path: "letter.md",
      }),
    ).toMatchObject({ status: "pending", version: 4 });
    await reloaded.harness.lifecycle.dispose();
  });

  it("rejects late replacements and restores rejected proposals with undo", async () => {
    const { harness, files } = await setupProposal();
    await harness.behavior.callRpc("resolveProposal", {
      path: "letter.md",
      expectedVersion: 1,
      action: "reject",
    });
    await expect(
      harness.behavior.callRpc("proposeNote", {
        path: "letter.md",
        expectedVersion: 1,
        expectedSha256: virtualSha(files.get("/vault/letter.md")!),
        content: "Late response",
      }),
    ).rejects.toThrow("proposal changed");
    expect(
      await harness.behavior.callRpc("resolveProposal", {
        path: "letter.md",
        expectedVersion: 2,
        action: "undo",
      }),
    ).toMatchObject({ status: "pending", version: 3 });
    expect(files.get("/vault/letter.md")?.content).toBe("A simple place.");
    await harness.lifecycle.dispose();
  });

  it("preserves external edits on acceptance and undo conflicts", async () => {
    const { harness, setUtf8, files } = await setupProposal();
    setUtf8("/vault/letter.md", "User's edit");
    await expect(
      harness.behavior.callRpc("resolveProposal", {
        path: "letter.md",
        expectedVersion: 1,
        action: "accept",
      }),
    ).rejects.toThrow("document changed");
    setUtf8("/vault/letter.md", "A simple place.");
    await harness.behavior.callRpc("resolveProposal", {
      path: "letter.md",
      expectedVersion: 1,
      action: "accept",
    });
    setUtf8("/vault/letter.md", "Newer edit");
    await expect(
      harness.behavior.callRpc("resolveProposal", {
        path: "letter.md",
        expectedVersion: 2,
        action: "undo",
      }),
    ).rejects.toThrow("overwrite newer edits");
    expect(files.get("/vault/letter.md")?.content).toBe("Newer edit");
    await harness.lifecycle.dispose();
  });

  it("reads CLI candidates from workspace files without writing the document", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/letter.md": {
        content: "Original",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
      "/work/candidate.md": {
        content: "Proposed",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    const result = await harness.behavior.runCli([
      "propose",
      "letter.md",
      "--file",
      "/work/candidate.md",
      "--expected-sha256",
      virtualSha(files.get("/vault/letter.md")!),
      "--version",
      "none",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      content: "Proposed",
      status: "pending",
      version: 1,
    });
    expect(files.get("/vault/letter.md")?.content).toBe("Original");
    await harness.lifecycle.dispose();
  });

  it("serializes concurrent resolutions and candidate edits", async () => {
    const { harness } = await setupProposal();
    const results = await Promise.allSettled([
      harness.behavior.callRpc("updateProposal", {
        path: "letter.md",
        expectedVersion: 1,
        content: "Edited candidate",
      }),
      harness.behavior.callRpc("resolveProposal", {
        path: "letter.md",
        expectedVersion: 1,
        action: "accept",
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await harness.behavior.callRpc("readProposal", { path: "letter.md" })).toMatchObject({
      content: "Edited candidate",
      status: "pending",
      version: 2,
    });
    await harness.lifecycle.dispose();
  });
});

describe("Docs fork divergences", () => {
  it("publishes every RPC method as discoverable with a description", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const published = harness.registrations.experimental_publishedRpcMethods;
    expect(published.map((entry) => entry.method).sort()).toEqual(
      Object.keys(docsRpcContract).sort(),
    );
    for (const entry of published) {
      expect(entry.registrationDescription).toContain("Docs vaults");
      expect(entry.methodDescription).toMatch(/\S/);
    }
  });

  it("lists MDX beside Markdown notes and leaves MDX to bb's file opener", async () => {
    const { harness } = await loadNotebook({
      "guide.md": "# Guide",
      "long-form.markdown": "# Long Form",
      "component.mdx": "# Component",
      "report.canvas.mdx": '<Stat label="Runs" value={42} />',
    });
    const result = (await harness.callRpc("listNotes", { vaultId: "personal" })) as {
      entries: unknown[];
      notes: Array<{ path: string }>;
    };
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { kind: "file", path: "guide.md" },
        { kind: "file", path: "long-form.markdown" },
        { kind: "file", path: "component.mdx" },
        { kind: "file", path: "report.canvas.mdx" },
      ]),
    );
    expect(result.notes.map((note) => note.path).sort()).toEqual([
      "guide.md",
      "long-form.markdown",
    ]);
    await expect(
      harness.callRpc("renameToTitle", { vaultId: "personal", path: "long-form.markdown" }),
    ).resolves.toEqual({ path: "long-form.markdown" });
    await expect(
      harness.callRpc("renameToTitle", { vaultId: "personal", path: "component.mdx" }),
    ).rejects.toThrow("Path must end with .md or .markdown: component.mdx");
  });

  it("lists and reads Markdown documents beneath hidden folders", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/.dotfiles/.agents/instructions/shared.md": {
        content: "# Shared agent instructions\n\nKeep the response concise.",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });

    await expect(harness.callRpc("listNotes", { vaultId: "personal" })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        { kind: "directory", path: ".dotfiles" },
        { kind: "directory", path: ".dotfiles/.agents" },
        { kind: "file", path: ".dotfiles/.agents/instructions/shared.md" },
      ]),
      notes: [
        expect.objectContaining({
          path: ".dotfiles/.agents/instructions/shared.md",
          title: "Shared agent instructions",
        }),
      ],
    });

    await expect(
      harness.callRpc("readNote", {
        vaultId: "personal",
        path: ".dotfiles/.agents/instructions/shared.md",
      }),
    ).resolves.toMatchObject({
      content: "# Shared agent instructions\n\nKeep the response concise.",
    });

    await expect(
      harness.runCli(["pull", ".dotfiles", "--folder", "--into", "sync", "--json"], {
        cwd: "/work",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(files.has("/work/sync/.dotfiles/.agents/instructions/shared.md")).toBe(true);
  });

  it("rejects generated and dependency directories while accepting authored hidden trees", async () => {
    const { harness } = await loadVirtualSyncVault({});

    for (const acceptedPath of [
      ".agents/instructions.md",
      ".claude/CLAUDE.md",
      ".codex/AGENTS.md",
      ".cursor/rules/project.md",
      ".dotfiles/config.md",
    ]) {
      await expect(
        harness.callRpc("saveNote", {
          vaultId: "personal",
          path: acceptedPath,
          content: "# Human-authored",
        }),
      ).resolves.toMatchObject({ outcome: "written" });
    }

    for (const rejectedPath of [
      ".claude/worktrees/checkout/AGENTS.md",
      ".git/README.md",
      ".node_modules/package/README.md",
      ".ruff_cache/README.md",
      ".scratch/notes.md",
      "dist/README.md",
      "node_modules/package/README.md",
    ]) {
      await expect(
        harness.callRpc("saveNote", {
          vaultId: "personal",
          path: rejectedPath,
          content: "# Generated",
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        issues: expect.arrayContaining([
          expect.objectContaining({ message: `Invalid vault path: ${rejectedPath}` }),
        ]),
      });
    }
  });

  it.each([
    { enabled: true, disables: 1 },
    { enabled: false, disables: 0 },
  ])(
    "disables bb's built-in Docs on install when it is enabled: $enabled",
    async ({ enabled, disables }) => {
      const { harness } = await loadNotebook({});
      harness.sdk.stub("plugins.list", async () => ({
        plugins: [{ id: "simple-notes", enabled }],
      }));
      harness.sdk.stub("plugins.disable", async () => ({ id: "simple-notes", enabled: false }));

      await harness.lifecycle.install();

      expect(harness.sdk.callsTo("plugins.disable")).toEqual(
        Array.from({ length: disables }, () => [{ pluginId: "simple-notes" }]),
      );
    },
  );

  it("drops the vaults of a removed machine and keeps a vault available", async () => {
    const { bb, harness } = await loadNotebook({});
    const db = bb.storage.database();
    const insert = db.prepare(
      "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("remote", "Remote", "host_remote", "/remote/notes", Date.now());
    insert.run("other", "Other", "host_other", "/other/notes", Date.now());

    await harness.behavior.emitThreadEvent("experimental_host.deleted", {
      host: makeHostResponse({ id: "host_remote" }),
    });
    const vaultIds = () =>
      db
        .prepare("SELECT id FROM vaults ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id);
    expect(vaultIds()).toEqual(["other", "personal"]);

    db.prepare("DELETE FROM vaults WHERE id = 'personal'").run();
    await harness.behavior.emitThreadEvent("experimental_host.deleted", {
      host: makeHostResponse({ id: "host_other" }),
    });
    expect(vaultIds()).toEqual(["personal"]);
  });
});

describe("Docs across machines", () => {
  const personalMac = makeHostResponse({ id: "host_mac", name: "Local Mac" });
  const devMac = makeHostResponse({ id: "host_dev", name: "Build Mac" });

  it("stores the server's host for a vault added without one", async () => {
    const { harness } = await loadNotebook({});

    await expect(
      harness.callRpc("createVault", { name: "Work", rootPath: "/srv/work" }),
    ).resolves.toEqual({ id: "work", name: "Work", hostId: "host_primary", rootPath: "/srv/work" });
    expect(harness.sdk.callsTo("files.mkdir")).toEqual([
      [{ hostId: "host_primary", path: "/srv/work", recursive: true }],
    ]);
  });

  it("binds a vault saved without a host only to the one machine that holds it", async () => {
    const { bb, harness } = await loadNotebook({});
    const insert = bb.storage
      .database()
      .prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, NULL, ?, ?)",
      );
    insert.run("obsidian", "Obsidian", "/Users/me/obsidian-vault", 1_000);
    insert.run("dotfiles", "Dotfiles", "/Users/me/dotfiles", 2_000);
    insert.run("scratch", "Scratch", "/shared/scratch", 3_000);
    insert.run("asleep", "Asleep", "/Users/me/asleep", 4_000);
    insert.run("server-notes", "Server notes", "/srv/notes", 6_000);
    const holdings: Record<string, string[]> = {
      host_mac: ["/Users/me/obsidian-vault", "/Users/me/dotfiles"],
      host_dev: ["/Users/me/dotfiles", "/shared/scratch", "/Users/me/asleep"],
      host_primary: ["/shared/scratch", "/srv/notes"],
    };
    let devMacStatus: "connected" | "disconnected" = "disconnected";
    harness.sdk.stub("hosts.list", async () => [
      personalMac,
      { ...devMac, status: devMacStatus },
      serverHost,
    ]);
    harness.sdk.stub(
      "hosts.pathsExist",
      async ({ hostId, paths }: { hostId: string; paths: string[] }) => {
        if (hostId === "host_mac" && paths.includes("/Users/me/asleep")) {
          throw new Error("Host is not connected");
        }
        return {
          existence: Object.fromEntries(
            paths.map((entry) => [entry, holdings[hostId]?.includes(entry) ?? false]),
          ),
        };
      },
    );
    // The server moved Local Mac -> Build Mac -> here. bb remembers only the
    // last move, so it cannot tell which Mac saved these vaults.
    harness.sdk.stub("experimental_server.moveStatus", async () => ({
      move: null,
      lastMove: {
        moveId: "move_2",
        fromHostId: "host_dev",
        fromHostName: "Build Mac",
        toHostId: "host_primary",
        toHostName: "Server",
        completedAt: 5_000,
        oldCopyDeletedAt: null,
      },
    }));
    const watchCount = () =>
      harness.experimental_hostRpcCalls.filter((call) => call.method === "watchVault").length;
    const bindingPass = async () => {
      const watched = watchCount();
      const service = harness.runService("watch-vaults");
      try {
        // Watches are armed after binding, so a new one ends the pass.
        await waitForSignal(() => watchCount() > watched);
      } finally {
        service.controller.abort();
        await service.done;
      }
      return Object.fromEntries(
        JSON.parse((await harness.runCli(["vaults", "--json"])).stdout).map(
          (vault: { id: string; hostId: string | null }) => [vault.id, vault.hostId],
        ),
      );
    };

    // Build Mac is away, so any of these folders may also be there.
    await expect(bindingPass()).resolves.toEqual({
      personal: "host_primary",
      obsidian: null,
      dotfiles: null,
      scratch: null,
      asleep: null,
      "server-notes": null,
    });

    devMacStatus = "connected";
    await expect(bindingPass()).resolves.toEqual({
      personal: "host_primary",
      obsidian: "host_mac",
      // On both Macs: the user chooses.
      dotfiles: null,
      scratch: null,
      // Local Mac did not answer for this folder.
      asleep: null,
      "server-notes": "host_primary",
    });

    harness.sdk.calls.length = 0;
    const listPathsBefore = harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "listPaths",
    ).length;
    await expect(harness.callRpc("listNotes", { vaultId: "dotfiles" })).resolves.toMatchObject({
      entries: [],
      error:
        "Choose the machine that holds /Users/me/dotfiles for the Dotfiles vault (found on Local Mac, Build Mac), or run bb docs vault-host dotfiles <host-id>.",
    });
    expect(
      harness.experimental_hostRpcCalls.filter((call) => call.method === "listPaths"),
    ).toHaveLength(listPathsBefore);
    const read = await harness.runCli(["read", "plan.md", "--vault", "dotfiles"]);
    expect(read.exitCode).toBe(1);
    expect(read.stderr).toContain("Choose the machine that holds /Users/me/dotfiles");
    expect(harness.sdk.callsTo("files.read")).toEqual([]);
  });

  it("rebinds a vault to a chosen machine and keeps its proposals", async () => {
    const { bb, harness } = await loadNotebook({});
    const db = bb.storage.database();
    db.prepare(
      "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, NULL, ?, ?)",
    ).run("dotfiles", "Dotfiles", "/Users/me/dotfiles", 1_000);
    db.prepare("INSERT INTO proposals (vault_id, path, data) VALUES (?, ?, ?)").run(
      "dotfiles",
      "AGENTS.md",
      "{}",
    );
    harness.sdk.stub("hosts.list", async () => [personalMac, devMac, serverHost]);
    harness.sdk.stub(
      "hosts.pathsExist",
      async ({ hostId, paths }: { hostId: string; paths: string[] }) => ({
        existence: Object.fromEntries(paths.map((entry) => [entry, hostId !== "host_primary"])),
      }),
    );

    const unknown = await harness.runCli(["vault-host", "dotfiles", "host_gone"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown machine: host_gone");

    const missing = await harness.runCli(["vault-host", "dotfiles", "host_primary"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Server has no folder at /Users/me/dotfiles");

    const bound = await harness.runCli(["vault-host", "dotfiles", "host_dev", "--json"]);
    expect(bound.exitCode).toBe(0);
    expect(JSON.parse(bound.stdout)).toEqual({
      id: "dotfiles",
      name: "Dotfiles",
      hostId: "host_dev",
      rootPath: "/Users/me/dotfiles",
    });
    expect(
      db.prepare("SELECT path FROM proposals WHERE vault_id = 'dotfiles'").pluck().all(),
    ).toEqual(["AGENTS.md"]);
    expect(harness.realtimeSignals).toContainEqual(
      expect.objectContaining({ channel: "vault-changed", payload: { vaultId: "dotfiles" } }),
    );
  });

  it("keeps other vaults' mentions when one machine is offline or slow", async () => {
    const { bb, harness } = await loadNotebook({ "plan.md": "# Plan" });
    const insert = bb.storage
      .database()
      .prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
      );
    insert.run("obsidian", "Obsidian", "host_mac", "/Users/me/obsidian-vault", Date.now());
    insert.run("dotfiles", "Dotfiles", "host_dev", "/Users/me/dotfiles", Date.now());
    harness.sdk.stub("hosts.list", async () => [personalMac, devMac, serverHost]);
    const primaryListing = {
      paths: [{ kind: "file", path: "plan.md", name: "plan.md", score: 0, positions: [] }],
      truncated: false,
    };
    harness.sdk.stub("files.listPaths", async ({ hostId }: { hostId: string }) => {
      if (hostId === "host_mac") throw new Error("Host is not connected");
      if (hostId === "host_dev") return new Promise(() => {});
      return primaryListing;
    });
    const provider = harness.registrations.mentionProviders[0]!;

    const started = Date.now();
    await expect(
      provider.search({ trigger: "@", query: "plan", projectId: null, threadId: null }),
    ).resolves.toMatchObject([{ id: "personal:plan.md", title: "Plan" }]);
    expect(Date.now() - started).toBeLessThan(2_000);

    harness.sdk.stub("hosts.list", async () => [
      { ...personalMac, status: "disconnected" },
      devMac,
      serverHost,
    ]);
    const listed = harness.sdk.callsTo("files.listPaths").length;
    await expect(
      provider.search({ trigger: "@", query: "plan", projectId: null, threadId: null }),
    ).resolves.toMatchObject([{ id: "personal:plan.md" }]);
    expect(
      harness.sdk
        .callsTo("files.listPaths")
        .slice(listed)
        .map(([args]) => (args as { hostId: string }).hostId),
    ).not.toContain("host_mac");
  });

  it("rereads only the notes whose time or size changed", async () => {
    const { harness, setUtf8 } = await loadVirtualSyncVault({
      "/vault/a.md": { content: "# A", contentEncoding: "utf8", modifiedAtMs: 1 },
      "/vault/b.md": { content: "# B", contentEncoding: "utf8", modifiedAtMs: 2 },
    });
    const readPaths = () =>
      harness.sdk.callsTo("files.read").map(([args]) => (args as { path: string }).path);

    await expect(harness.callRpc("listNotes", {})).resolves.toMatchObject({
      notes: [{ title: "B" }, { title: "A" }],
    });
    expect(readPaths()).toEqual(["/vault/a.md", "/vault/b.md"]);

    await harness.callRpc("listNotes", {});
    expect(readPaths()).toHaveLength(2);

    setUtf8("/vault/a.md", "# A, edited");
    await expect(harness.callRpc("listNotes", {})).resolves.toMatchObject({
      notes: [{ title: "A, edited" }, { title: "B" }],
    });
    expect(readPaths()).toEqual(["/vault/a.md", "/vault/b.md", "/vault/a.md"]);
  });

  it("pulls into the invoking machine and refuses to guess between machines", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/plan.md": { content: "# Plan", contentEncoding: "utf8", modifiedAtMs: 1 },
    });
    harness.sdk.stub("hosts.list", async () => [serverHost, personalMac]);
    harness.sdk.stub("hosts.pathsExist", async ({ paths }: { paths: string[] }) => ({
      existence: Object.fromEntries(paths.map((entry) => [entry, entry === "/work"])),
    }));

    const ambiguous = await harness.runCli(["pull", "plan.md", "--into", "sync"], {
      cwd: "/work",
    });
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.stderr).toContain(
      "Pass --workspace-host <id>; /work exists on Server (host_primary), Local Mac (host_mac)",
    );
    expect(files.has("/work/sync/plan.md")).toBe(false);

    const noCwd = await harness.runCli(["pull", "plan.md", "--into", "sync"]);
    expect(noCwd.exitCode).toBe(2);
    expect(noCwd.stderr).toContain("Pass an absolute path instead of sync");

    harness.sdk.stub("threads.get", async () => ({ id: "thread_mac", environmentId: "env_mac" }));
    harness.sdk.stub("environments.get", async () => ({ id: "env_mac", hostId: "host_mac" }));
    const pulled = await harness.runCli(["pull", "plan.md", "--into", "sync"], {
      cwd: "/work",
      threadId: "thread_mac",
    });
    expect(pulled).toMatchObject({
      exitCode: 0,
      stdout: "Pulled 1 file(s) into /work/sync on Local Mac.",
    });
    expect(
      harness.sdk
        .callsTo("files.write")
        .map(([args]) => args as { hostId: string; path: string })
        .map(({ hostId, path: written }) => ({ hostId, path: written })),
    ).toEqual([
      { hostId: "host_mac", path: "/work/sync/plan.md" },
      { hostId: "host_mac", path: "/work/sync/.bb-docs-state.json" },
    ]);
  });

  it("pulls into the one connected machine that has the working directory", async () => {
    const { harness } = await loadVirtualSyncVault({
      "/vault/plan.md": { content: "# Plan", contentEncoding: "utf8", modifiedAtMs: 1 },
    });
    harness.sdk.stub("hosts.list", async () => [serverHost, personalMac]);
    harness.sdk.stub(
      "hosts.pathsExist",
      async ({ hostId, paths }: { hostId: string; paths: string[] }) => ({
        existence: Object.fromEntries(paths.map((entry) => [entry, hostId === "host_mac"])),
      }),
    );

    await expect(
      harness.runCli(["pull", "plan.md", "--into", "sync"], { cwd: "/work" }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Pulled 1 file(s) into /work/sync on Local Mac.",
    });
    expect(
      harness.sdk
        .callsTo("files.write")
        .map(([args]) => args as { hostId: string; path: string })
        .map(({ hostId, path: written }) => ({ hostId, path: written })),
    ).toEqual([
      { hostId: "host_mac", path: "/work/sync/plan.md" },
      { hostId: "host_mac", path: "/work/sync/.bb-docs-state.json" },
    ]);
  });

  it("keeps the notes an interrupted mention scan already read", async () => {
    const { harness } = await loadVirtualSyncVault({
      "/vault/a.md": { content: "# A", contentEncoding: "utf8", modifiedAtMs: 1 },
      "/vault/b.md": { content: "# B", contentEncoding: "utf8", modifiedAtMs: 2 },
      "/vault/c.md": { content: "# C", contentEncoding: "utf8", modifiedAtMs: 3 },
    });
    // c.md is behind a slow link and does not arrive before the 10 s scan deadline.
    let slow = true;
    harness.sdk.stub(
      "files.read",
      async ({ path: filePath, signal }: { path: string; signal?: AbortSignal }) => {
        if (filePath === "/vault/c.md" && slow) {
          await new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        const content = `# ${path.posix.basename(filePath, ".md").toUpperCase()}`;
        return {
          path: filePath,
          content,
          contentEncoding: "utf8" as const,
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(content),
          modifiedAtMs: 1,
          sha256: "sha",
        };
      },
    );
    const readPaths = () =>
      harness.sdk.callsTo("files.read").map(([args]) => (args as { path: string }).path);
    const provider = harness.registrations.mentionProviders[0]!;
    const search = () =>
      provider.search({ trigger: "@", query: "", projectId: null, threadId: null });
    // Fake time reaches the deadline instead of waiting it out.
    useFakeTimers();
    try {
      const first = search();
      await vi.waitFor(() => expect(readPaths()).toHaveLength(3));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toEqual([]);

      slow = false;
      await expect(search()).resolves.toMatchObject([
        { id: "personal:c.md" },
        { id: "personal:b.md" },
        { id: "personal:a.md" },
      ]);
      expect(readPaths().slice(3)).toEqual(["/vault/c.md"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Docs upstream live reads on fork hosts", () => {
  it("invalidates document reads after a save and a native host change", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const service = harness.behavior.runService("watch-vaults");
    try {
      await waitForSignal(() =>
        harness.experimental_hostRpcCalls.some((call) => call.method === "watchVault"),
      );
      await expect(
        harness.behavior.callRpc("readDocument", { vaultId: "personal", path: "plan.md" }),
      ).resolves.toMatchObject({ content: "# Plan", sha256: "test-sha", proposal: null });
      await harness.behavior.callRpc("saveDocument", {
        vaultId: "personal",
        path: "plan.md",
        content: "# Revised",
        expectedSha256: "test-sha",
        renameToTitle: false,
      });
      expect(harness.inspection.experimental_rpcInvalidations.flat()).toContain(
        "doc:personal:plan.md",
      );
      harness.inspection.experimental_rpcInvalidations.length = 0;
      await harness.behavior.experimental_emitHostSignal("host_primary", "vaultChanged", {
        vaultId: "personal",
        kind: "changed",
        changes: [{ path: "plan.md", sha256: "e".repeat(64) }],
      });
      expect(harness.inspection.experimental_rpcInvalidations.flat()).toContain(
        "doc:personal:plan.md",
      );
    } finally {
      service.controller.abort();
      await service.done;
      await harness.lifecycle.dispose();
    }
  });
});

describe("Docs preview lease and extension regressions", () => {
  it("shares previews across HTML and document reads, renews once near expiry, and isolates hosts", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan", "page.html": "<p>Page</p>" });
    const filePath = path.join(temporaryDirectories[0]!, "plan.md");
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let number = 0;
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: `/preview-${++number}`,
      expiresAtMs: now + 600_000,
    }));
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    try {
      const first = await Promise.all([
        harness.callRpc("preparePreview", { vaultId: "personal", path: "page.html" }),
        harness.callRpc("readDocument", { vaultId: "personal", path: "plan.md" }),
        harness.callRpc("openFile", { source, path: filePath }),
      ]);
      expect(number).toBe(1);
      expect(first[0]).toMatchObject({ baseUrl: "/preview-1" });
      expect(first[1]).toMatchObject({ preview: { baseUrl: "/preview-1" } });
      expect(first[2]).toMatchObject({ preview: { baseUrl: "/preview-1" } });
      now += 540_000;
      const renewed = await Promise.all([
        harness.callRpc("preparePreview", { vaultId: "personal", path: "page.html" }),
        harness.callRpc("openFile", { source, path: filePath }),
      ]);
      expect(number).toBe(2);
      expect(renewed[0]).toMatchObject({ baseUrl: "/preview-2" });
      expect(renewed[1]).toMatchObject({ preview: { baseUrl: "/preview-2" } });
      await harness.callRpc("openFile", {
        source: { ...source, experimental_hostId: "host_other" },
        path: filePath,
      });
      expect(number).toBe(3);
    } finally {
      clock.mockRestore();
      await harness.lifecycle.dispose();
    }
  });
  it("starts a fresh preview for a reader that joined one that failed", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan", "page.html": "<p>Page</p>" });
    let failFirst!: (error: Error) => void;
    let previews = 0;
    harness.sdk.stub("files.createPreview", async () => {
      previews += 1;
      if (previews === 1)
        return new Promise<never>((_, reject) => {
          failFirst = reject;
        });
      return { baseUrl: "/preview-2", expiresAtMs: Date.now() + 600_000 };
    });
    const first = harness.callRpc("preparePreview", { vaultId: "personal", path: "page.html" });
    await waitForSignal(() => previews === 1);
    // readDocument asks for the preview as it starts its read.
    const second = harness.callRpc("readDocument", { vaultId: "personal", path: "plan.md" });
    await waitForSignal(() => harness.sdk.callsTo("files.read").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    failFirst(new Error("preview service restarting"));
    await expect(first).rejects.toThrow("preview service restarting");
    await expect(second).resolves.toMatchObject({ preview: { baseUrl: "/preview-2" } });
    expect(previews).toBe(2);
    await harness.lifecycle.dispose();
  });
  it("invalidates .markdown titles and keeps the extension when naming Untitled documents", async () => {
    const { harness } = await loadNotebook({ "Untitled.markdown": "# Original" });
    await harness.callRpc("listNotes", { vaultId: "personal" });
    harness.inspection.experimental_rpcInvalidations.length = 0;
    await harness.callRpc("saveDocument", {
      vaultId: "personal",
      path: "Untitled.markdown",
      content: "# New title",
      expectedSha256: "test-sha",
      renameToTitle: false,
    });
    expect(harness.inspection.experimental_rpcInvalidations.flat()).toContain("tree:personal");
    await expect(
      harness.callRpc("saveDocument", {
        vaultId: "personal",
        path: "Untitled.markdown",
        content: "# Rename",
        expectedSha256: "test-sha",
        renameToTitle: true,
      }),
    ).resolves.toMatchObject({ path: "rename.markdown" });
    await harness.lifecycle.dispose();
  });
});

describe("Docs opened-file producer recovery", () => {
  it("retries transient arming and renewal failures without rereading unchanged documents", async () => {
    let attempts = 0;
    let failRenewal = false;
    let sha256 = "a".repeat(64);
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      {
        watchFile: async () => {
          attempts += 1;
          if (attempts === 1 || failRenewal) {
            failRenewal = false;
            throw new Error("host temporarily unavailable");
          }
          return { sha256 };
        },
      },
    );
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: "/stable-preview",
      expiresAtMs: Date.now() + 600_000,
    }));
    useFakeTimers();
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(attempts).toBe(2));
      harness.inspection.experimental_rpcInvalidations.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(3);
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
      failRenewal = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(4);
      sha256 = "b".repeat(64);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(5);
      expect(harness.inspection.experimental_rpcInvalidations.flat()).toEqual(
        expect.arrayContaining([expect.stringContaining("opened:")]),
      );
      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(attempts).toBe(5);
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
  it("re-arms at once when the host restarts its worker during a failure backoff", async () => {
    let attempts = 0;
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      {
        watchFile: async () => {
          attempts += 1;
          if (attempts <= 3) throw new Error("host temporarily unavailable");
          return { sha256: "a".repeat(64) };
        },
      },
    );
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: "/stable-preview",
      expiresAtMs: Date.now() + 600_000,
    }));
    useFakeTimers();
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(attempts).toBe(2));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(attempts).toBe(3));
      // Four seconds of backoff remain; a restarted worker cuts them short.
      await harness.behavior.experimental_emitHostWorkerExit("host_primary");
      await vi.waitFor(() => expect(attempts).toBe(4));
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
  it("lets a renewal in flight finish when the host restarts its worker, then re-arms at once", async () => {
    const calls: AbortSignal[] = [];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      {
        watchFile: async ({ signal }) => {
          calls.push(signal!);
          if (calls.length === 1) await answered;
          return { sha256: "a".repeat(64) };
        },
      },
    );
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: "/stable-preview",
      expiresAtMs: Date.now() + 600_000,
    }));
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await harness.behavior.experimental_emitHostWorkerExit("host_primary");
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The restart neither cancels the call in flight nor starts another beside it.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.aborted).toBe(false);
      // Once it answers, the next renewal starts without waiting a renewal interval.
      answer();
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[0]!.aborted).toBe(false);
    } finally {
      stop();
      await harness.lifecycle.dispose();
    }
  });
  it("retains a write's newer hash when an older renewal response arrives later", async () => {
    let calls = 0;
    let complete!: (value: { sha256: string }) => void;
    const stale = new Promise<{ sha256: string }>((resolve) => {
      complete = resolve;
    });
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      { watchFile: async () => (++calls === 2 ? stale : { sha256: "a".repeat(64) }) },
    );
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: "/stable-preview",
      expiresAtMs: Date.now() + 600_000,
    }));
    harness.sdk.stub("files.write", async () => ({
      outcome: "written" as const,
      sha256: "b".repeat(64),
      sizeBytes: 4,
    }));
    useFakeTimers();
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const input = { source, path: path.join(temporaryDirectories[0]!, "plan.md") };
    const stop = harness.behavior.experimental_watchRpc("openFile", { input });
    try {
      await vi.waitFor(() => expect(calls).toBe(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
      await harness.callRpc("saveOpenedFile", {
        ...input,
        content: "New",
        expectedSha256: "a".repeat(64),
      });
      harness.inspection.experimental_rpcInvalidations.length = 0;
      complete({ sha256: "a".repeat(64) });
      await vi.advanceTimersByTimeAsync(0);
      const watch = harness.experimental_hostRpcCalls.find((call) => call.method === "watchFile")!;
      await harness.behavior.experimental_emitHostSignal("host_primary", "fileChanged", {
        watchId: (watch.input as { watchId: string }).watchId,
        sha256: "b".repeat(64),
      });
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
      await harness.behavior.experimental_emitHostSignal("host_primary", "fileChanged", {
        watchId: (watch.input as { watchId: string }).watchId,
        sha256: null,
      });
      expect(harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
});

describe("Docs preview producers and subscription cleanup", () => {
  it("renews a standalone preview at expiry without refreshing every unchanged hash poll", async () => {
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      { watchFile: async () => ({ sha256: "a".repeat(64) }) },
    );
    let previews = 0;
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: `/preview-${++previews}`,
      expiresAtMs: Date.now() + 600_000,
    }));
    useFakeTimers();
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    try {
      await vi.waitFor(() => expect(previews).toBe(1));
      harness.inspection.experimental_rpcInvalidations.length = 0;
      await vi.advanceTimersByTimeAsync(420_000);
      expect(previews).toBe(1);
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(previews).toBe(2);
      expect(harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
      harness.inspection.experimental_rpcInvalidations.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
  it("renews HTML preview leases only while the preview is watched", async () => {
    const { harness } = await loadNotebook({ "page.html": "<p>Page</p>" });
    let previews = 0;
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: `/preview-${++previews}`,
      expiresAtMs: Date.now() + 600_000,
    }));
    useFakeTimers();
    const stop = harness.behavior.experimental_watchRpc("preparePreview", {
      input: { vaultId: "personal", path: "page.html" },
    });
    try {
      await vi.waitFor(() => expect(previews).toBe(1));
      await vi.advanceTimersByTimeAsync(481_001);
      expect(previews).toBe(2);
      expect(harness.inspection.experimental_rpcInvalidations.flat()).toContain(
        "doc:personal:page.html",
      );
      stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(previews).toBe(2);
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
  it("detaches old host readers when renewal resolves the source to another host", async () => {
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      { watchFile: async () => ({ sha256: "a".repeat(64) }) },
    );
    let hostId = "host_first";
    harness.sdk.stub("environments.get", async () => ({ id: "env", hostId }));
    harness.sdk.stub("files.createPreview", async () => ({
      baseUrl: `/preview-${hostId}`,
      expiresAtMs: Date.now() + 600_000,
    }));
    useFakeTimers();
    const source = { kind: "host", threadId: null, environmentId: "env", projectId: null };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    const calls = () =>
      harness.experimental_hostRpcCalls.filter((call) => call.method === "watchFile");
    try {
      await vi.waitFor(() => expect(calls()).toHaveLength(1));
      hostId = "host_second";
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls()).toHaveLength(2);
      const first = calls()[0]!.input as { watchId: string };
      const second = calls()[1]!.input as { watchId: string };
      expect(second.watchId).not.toBe(first.watchId);
      harness.inspection.experimental_rpcInvalidations.length = 0;
      await harness.behavior.experimental_emitHostSignal("host_first", "fileChanged", {
        watchId: first.watchId,
        sha256: "b".repeat(64),
      });
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
      await harness.behavior.experimental_emitHostSignal("host_second", "fileChanged", {
        watchId: second.watchId,
        sha256: "b".repeat(64),
      });
      expect(harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
      stop();
      await vi.advanceTimersByTimeAsync(0);
      harness.inspection.experimental_rpcInvalidations.length = 0;
      await harness.behavior.experimental_emitHostSignal("host_second", "fileChanged", {
        watchId: second.watchId,
        sha256: "c".repeat(64),
      });
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
  it("does not attach a reader when an arming call completes after subscription abort", async () => {
    let resolve!: (value: { sha256: string }) => void;
    const pending = new Promise<{ sha256: string }>((complete) => {
      resolve = complete;
    });
    let started = false;
    let requestSignal: AbortSignal | undefined;
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      {
        watchFile: async ({ signal }) => {
          started = true;
          requestSignal = signal;
          return pending;
        },
      },
    );
    useFakeTimers();
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      stop();
      expect(requestSignal?.aborted).toBe(true);
      resolve({ sha256: "a".repeat(64) });
      await vi.advanceTimersByTimeAsync(0);
      const call = harness.experimental_hostRpcCalls.find((call) => call.method === "watchFile")!;
      await harness.behavior.experimental_emitHostSignal("host_primary", "fileChanged", {
        watchId: (call.input as { watchId: string }).watchId,
        sha256: "b".repeat(64),
      });
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
    } finally {
      stop();
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });
});

describe("Docs shared preview cancellation", () => {
  it("detaches a stopped reader immediately while a reusable preview lease is still pending", async () => {
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      { watchFile: async () => ({ sha256: "a".repeat(64) }) },
    );
    let complete!: (value: { baseUrl: string; expiresAtMs: number }) => void;
    const pending = new Promise<{ baseUrl: string; expiresAtMs: number }>((resolve) => {
      complete = resolve;
    });
    let creating = false;
    harness.sdk.stub("files.createPreview", async () => {
      creating = true;
      return pending;
    });
    const source = {
      kind: "host",
      threadId: null,
      environmentId: null,
      projectId: null,
      experimental_hostId: "host_primary",
    };
    const stop = harness.behavior.experimental_watchRpc("openFile", {
      input: { source, path: path.join(temporaryDirectories[0]!, "plan.md") },
    });
    try {
      await waitForSignal(() => creating);
      stop();
      const call = harness.experimental_hostRpcCalls.find((call) => call.method === "watchFile")!;
      await harness.behavior.experimental_emitHostSignal("host_primary", "fileChanged", {
        watchId: (call.input as { watchId: string }).watchId,
        sha256: "b".repeat(64),
      });
      expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
      complete({ baseUrl: "/reusable-preview", expiresAtMs: Date.now() + 600_000 });
      await expect(
        harness.callRpc("preparePreview", { vaultId: "personal", path: "plan.md" }),
      ).resolves.toMatchObject({ baseUrl: "/reusable-preview" });
      expect(harness.sdk.callsTo("files.createPreview")).toHaveLength(1);
    } finally {
      complete({ baseUrl: "/reusable-preview", expiresAtMs: Date.now() + 600_000 });
      stop();
      await harness.lifecycle.dispose();
    }
  });
});
