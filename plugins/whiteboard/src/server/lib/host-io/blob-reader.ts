import type {
  BlobBatchReader,
  LocalVcsKind,
} from "../../../shared/node/vendor/local-vcs/src/index.ts";
import { hostIo, routeHost } from "./client.ts";

/** Reads queued within this window go to the host in one `readBlobs` call. */
export const BLOB_BATCH_MS = 5;
/** The contract's per-call item bound. */
export const BLOB_BATCH_ITEMS = 2000;

const hostReaders = new WeakSet<object>();

type Pending = {
  commit: string;
  path: string;
  resolve: (blob: Buffer | null) => void;
  reject: (error: unknown) => void;
};

/**
 * A `BlobBatchReader` whose reads run on the repository's host (design §1.5).
 * Reads are queued for `BLOB_BATCH_MS` and sent as one `readBlobs` call of up
 * to `BLOB_BATCH_ITEMS`; the host answers a prefix that fits its 4 MiB
 * response budget and the rest is re-requested. Like upstream, a closed
 * reader answers nothing, and a tree or a missing path reads as null.
 */
export function createHostBlobReader(input: {
  rootPath: string;
  kind: LocalVcsKind;
  hostId?: string;
}): BlobBatchReader {
  const queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let host: Promise<string> | undefined;

  const send = async (batch: Pending[]) => {
    try {
      host ??= input.hostId
        ? Promise.resolve(input.hostId)
        : routeHost({ rootPath: input.rootPath });
      const hostId = await host.catch((error: unknown) => {
        host = undefined;
        throw error;
      });
      let remaining = batch;
      while (remaining.length) {
        const { items } = await hostIo().client.call(
          "readBlobs",
          {
            rootPath: input.rootPath,
            kind: input.kind,
            items: remaining.map(({ commit, path }) => ({ commit, path })),
          },
          { hostId },
        );
        if (!items.length) throw new Error("whiteboard: the host answered no blobs.");
        items.forEach((item, index) =>
          remaining[index]!.resolve(item.bytes === null ? null : Buffer.from(item.bytes, "base64")),
        );
        remaining = remaining.slice(items.length);
      }
    } catch (error) {
      for (const pending of batch) pending.reject(error);
    }
  };

  const flush = () => {
    timer = undefined;
    while (queue.length) void send(queue.splice(0, BLOB_BATCH_ITEMS));
  };

  const read = (commit: string, path: string): Promise<Buffer | null> => {
    if (closed || path.includes("\n") || commit.includes("\n")) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      queue.push({ commit, path, resolve, reject });
      timer ??= setTimeout(flush, BLOB_BATCH_MS);
    });
  };

  const reader = {
    pid: undefined,
    processExit: () => Promise.resolve(),
    read,
    async readObject(commit: string, path: string) {
      const blob = await read(commit, path);
      return blob === null ? ({ found: "nothing" } as const) : ({ found: "blob", blob } as const);
    },
    async close() {
      closed = true;
    },
  };
  hostReaders.add(reader);
  return reader as unknown as BlobBatchReader;
}

/** Whether a reader came from `createHostBlobReader`. */
export function isHostBlobReader(reader: unknown): boolean {
  return typeof reader === "object" && reader !== null && hostReaders.has(reader);
}
