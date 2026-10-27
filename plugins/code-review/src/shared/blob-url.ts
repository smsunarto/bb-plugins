import { z } from "zod";
import { type Comparison, type ComparisonSide, comparisonSchema } from "./schema.ts";

/*
 * The URL a whole file is read from, one side of one changed file. It names
 * commits, never branches, so what it serves never changes and is cached.
 */

export const BLOB_PATH = "/blob";
export const THREE_KIT_PATH = "/three-kit.js";

const sideSchema = z.enum(["base", "head"]);
const filePathSchema = z.string().min(1).max(4096);

export function blobQuery(comparison: Comparison, side: ComparisonSide, path: string): string {
  const params = new URLSearchParams({ kind: comparison.kind });
  if (comparison.kind === "github") {
    params.set("account", comparison.account);
    params.set("owner", comparison.owner);
    params.set("repo", comparison.repo);
    if (comparison.headRepository) params.set("headRepository", comparison.headRepository);
  } else {
    params.set("host", comparison.hostId);
    params.set("checkout", comparison.path);
  }
  params.set("base", comparison.base);
  params.set("head", comparison.head);
  params.set("side", side);
  params.set("path", path);
  return params.toString();
}

export function blobUrl(
  pluginId: string,
  comparison: Comparison,
  side: ComparisonSide,
  path: string,
): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${BLOB_PATH}?${blobQuery(comparison, side, path)}`;
}

export type BlobRequest = { comparison: Comparison; side: ComparisonSide; path: string };

/** The inverse of {@link blobQuery}. Null for anything malformed. */
export function parseBlobQuery(read: (name: string) => string | undefined): BlobRequest | null {
  const kind = read("kind");
  const comparison = comparisonSchema.safeParse(
    kind === "github"
      ? {
          kind,
          account: read("account"),
          owner: read("owner"),
          repo: read("repo"),
          headRepository: read("headRepository") ?? null,
          base: read("base"),
          head: read("head"),
        }
      : {
          kind,
          hostId: read("host"),
          path: read("checkout"),
          base: read("base"),
          head: read("head"),
        },
  );
  const side = sideSchema.safeParse(read("side"));
  const path = filePathSchema.safeParse(read("path"));
  if (!comparison.success || !side.success || !path.success) return null;
  return { comparison: comparison.data, side: side.data, path: path.data };
}
