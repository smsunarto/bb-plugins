import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stubHostContext } from "@bb-kit/core/testing";

export interface FakeFile {
  readonly content: string;
  readonly contentEncoding?: "utf8" | "base64";
  readonly sha256?: string;
  readonly modifiedAtMs?: number;
}

export interface FakeBbOptions {
  readonly environments?: Readonly<Record<string, { hostId: string; path: string | null }>>;
  readonly threads?: Readonly<Record<string, { hostId: string; storageRootPath: string }>>;
  readonly files?: Readonly<Record<string, FakeFile | Error>>;
}

export interface FakeCalls {
  readonly environmentsGet: { environmentId: string }[];
  readonly storageLocation: { threadId: string }[];
  readonly filesRead: { hostId?: string; path: string; rootPath?: string }[];
  readonly published: { channel: string; payload: unknown }[];
}

export type FakeBb = BbPluginApi & { readonly calls: FakeCalls };

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
    published: [],
  };
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
        const file = options.files?.[fileKey(args)];
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
  return Object.assign(ctx.bb, { calls }) as FakeBb;
}
