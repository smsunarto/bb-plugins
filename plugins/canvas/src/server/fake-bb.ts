import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stubHostContext } from "@bb-kit/core/testing";

export interface FakeFile {
  readonly content: string;
  readonly contentEncoding?: "utf8" | "base64";
  readonly sha256?: string;
  readonly modifiedAtMs?: number;
}

export interface FakeWriteArgs {
  readonly hostId?: string;
  readonly path: string;
  readonly rootPath?: string;
  readonly content: string;
  readonly expectedSha256?: string | null;
}

export type FakeStore = Map<string, FakeFile | Error>;

export interface FakeBbOptions {
  readonly environments?: Readonly<Record<string, { hostId: string; path: string | null }>>;
  readonly threads?: Readonly<Record<string, { hostId: string; storageRootPath: string }>>;
  readonly files?: Readonly<Record<string, FakeFile | Error>>;
  /** Runs before each write lands, so a test can play a concurrent writer. */
  readonly beforeWrite?: (args: FakeWriteArgs, store: FakeStore) => void;
}

export interface FakeCalls {
  readonly environmentsGet: { environmentId: string }[];
  readonly storageLocation: { threadId: string }[];
  readonly filesRead: { hostId?: string; path: string; rootPath?: string }[];
  readonly filesWrite: FakeWriteArgs[];
  readonly published: { channel: string; payload: unknown }[];
}

export type FakeBb = BbPluginApi & { readonly calls: FakeCalls; readonly store: FakeStore };

function fileKey(args: { hostId?: string; path: string; rootPath?: string }): string {
  return [args.hostId ?? "primary", args.rootPath ?? "", args.path].join("|");
}

export function fileKeyOf(
  hostId: string | undefined,
  rootPath: string | undefined,
  path: string,
): string {
  return fileKey({ hostId, rootPath, path });
}

async function sha256Of(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fakeBb(options: FakeBbOptions): FakeBb {
  const calls: FakeCalls = {
    environmentsGet: [],
    storageLocation: [],
    filesRead: [],
    filesWrite: [],
    published: [],
  };
  const store: FakeStore = new Map(Object.entries(options.files ?? {}));
  const sdk = {
    environments: {
      async get(args: { environmentId: string }) {
        calls.environmentsGet.push(args);
        const environment = options.environments?.[args.environmentId];
        if (environment === undefined)
          throw new Error(`environment not found: ${args.environmentId}`);
        return environment;
      },
    },
    threads: {
      async storageLocation(args: { threadId: string }) {
        calls.storageLocation.push(args);
        const thread = options.threads?.[args.threadId];
        if (thread === undefined) throw new Error(`thread not found: ${args.threadId}`);
        return thread;
      },
    },
    files: {
      async read(args: { hostId?: string; path: string; rootPath?: string }) {
        calls.filesRead.push(args);
        const file = store.get(fileKey(args));
        if (file === undefined)
          throw new Error(`ENOENT: no such file or directory, open '${args.path}'`);
        if (file instanceof Error) throw file;
        return {
          content: file.content,
          contentEncoding: file.contentEncoding ?? "utf8",
          path: args.path,
          sha256: file.sha256 ?? (await sha256Of(file.content)),
          ...(file.modifiedAtMs === undefined ? {} : { modifiedAtMs: file.modifiedAtMs }),
        };
      },
      async write(args: FakeWriteArgs) {
        calls.filesWrite.push(args);
        options.beforeWrite?.(args, store);
        const key = fileKey(args);
        const current = store.get(key);
        const currentSha256 =
          current === undefined || current instanceof Error
            ? null
            : (current.sha256 ?? (await sha256Of(current.content)));
        if (args.expectedSha256 !== undefined && args.expectedSha256 !== currentSha256) {
          return { outcome: "conflict", currentSha256 };
        }
        const sha256 = await sha256Of(args.content);
        store.set(key, { content: args.content, sha256 });
        return { outcome: "written", sha256, sizeBytes: args.content.length };
      },
    },
  };
  const bb = {
    sdk,
    realtime: {
      publish(channel: string, payload: unknown) {
        calls.published.push({ channel, payload });
      },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as BbPluginApi;
  const ctx = stubHostContext({ bb });
  return Object.assign(ctx.bb, { calls, store }) as FakeBb;
}
