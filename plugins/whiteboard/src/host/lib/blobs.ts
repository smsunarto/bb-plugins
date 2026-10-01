import {
  HOST_PAYLOAD_LIMIT_BYTES,
  type HostInput,
  type HostOutput,
} from "../../shared/contracts/host-contract.ts";
import {
  type BlobBatchReader,
  createBlobBatchReader,
} from "../../shared/node/vendor/local-vcs/src/index.ts";

/** One response carries at most this much base64 (design §3.1: split at 4 MiB). */
export const BLOB_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Reads in flight at once; one `git cat-file --batch` pipelines them. */
const BLOB_READ_WINDOW = 64;

const readers = new Map<string, BlobBatchReader>();

/** One `git cat-file --batch` per object store, as upstream LocalReviewData keeps per repository. */
function readerFor(input: HostInput<"readBlobs">): BlobBatchReader {
  const key = `${input.kind}\0${input.rootPath}`;
  let reader = readers.get(key);
  if (!reader) {
    reader = createBlobBatchReader({ rootPath: input.rootPath, kind: input.kind });
    readers.set(key, reader);
  }
  return reader;
}

/**
 * Batched blob reads for pinned source (design §1.5). The answer lists the
 * requested items in order. It may stop early once it holds
 * `BLOB_RESPONSE_BYTES`; the server re-requests the rest. A single blob whose
 * base64 exceeds the hop limit answers `null` (unavailable), as no hop can
 * carry it.
 */
export async function readBlobs(
  input: HostInput<"readBlobs">,
  _signal: AbortSignal,
): Promise<HostOutput<"readBlobs">> {
  const reader = readerFor(input);
  const items: HostOutput<"readBlobs">["items"] = [];
  let total = 0;
  // Read a window at a time, so blobs past the response budget are never read
  // (the server re-requests them; reading them all would be quadratic).
  for (let start = 0; start < input.items.length; start += BLOB_READ_WINDOW) {
    const blobs = await Promise.all(
      input.items
        .slice(start, start + BLOB_READ_WINDOW)
        .map((item) => reader.read(item.commit, item.path).catch(() => null)),
    );
    for (const blob of blobs) {
      if (blob === null) {
        items.push({ bytes: null });
        continue;
      }
      const size = Math.ceil(blob.length / 3) * 4;
      if (size > HOST_PAYLOAD_LIMIT_BYTES) {
        items.push({ bytes: null });
        continue;
      }
      if (items.length > 0 && total + size > BLOB_RESPONSE_BYTES) return { items };
      items.push({ bytes: blob.toString("base64") });
      total += size;
    }
  }
  return { items };
}

/** Close every reader (host entry dispose). */
export async function closeBlobReaders(): Promise<void> {
  const open = [...readers.values()];
  readers.clear();
  await Promise.all(open.map((reader) => reader.close()));
}
