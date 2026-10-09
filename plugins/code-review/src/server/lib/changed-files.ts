import {
  type ChangedFiles,
  type DiffRevision,
  type FileStatus,
  type PrRef,
  type ViewedState,
  sameRevision,
} from "../../shared/schema.ts";
import { type Gh, GhError } from "./gh.ts";
import { type GqlPageInfo, remainingPages, restRepo } from "./github.ts";
import { loadPrHead } from "./pull-request.ts";

/*
 * Patches come from REST, which is the only API that returns them. The
 * viewer's "viewed" marks come from GraphQL, which is the only API that has
 * them. The two are joined by path.
 *
 * A push or a retarget can land between those reads, and patches labeled
 * with the wrong head or base put every comment written on them on the wrong
 * lines. So the reads sit between two reads of both: the first page of marks
 * before, a check after. If either moved, the whole load runs again.
 */

const MAX_ATTEMPTS = 3;

export const FILES_QUERY = `query ChangedFiles($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      baseRefName
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

type Files = { pageInfo: GqlPageInfo; nodes: { path: string; viewerViewedState: string }[] };
type FilesPage = { repository: { pullRequest: DiffRevision & { files: Files } } };

export type RestFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

const STATUSES = new Set<FileStatus>([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

const VIEWED: Record<string, ViewedState> = {
  VIEWED: "viewed",
  UNVIEWED: "unviewed",
  DISMISSED: "dismissed",
};

export function mapChangedFiles(
  { headRefOid, baseRefName }: DiffRevision,
  files: RestFile[],
  viewed: Files["nodes"],
): ChangedFiles {
  const marks = new Map(viewed.map((node) => [node.path, VIEWED[node.viewerViewedState]]));
  return {
    headRefOid,
    baseRefName,
    files: files.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: STATUSES.has(file.status as FileStatus) ? (file.status as FileStatus) : "changed",
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      viewed: marks.get(file.filename) ?? "unviewed",
    })),
  };
}

export async function loadChangedFiles(gh: Gh, ref: PrRef): Promise<ChangedFiles> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const changed = await readChangedFiles(gh, ref);
    if (sameRevision(await loadPrHead(gh, ref), changed)) return changed;
  }
  throw new GhError("failed", "The pull request kept changing while its files loaded. Try again.");
}

/** The files and marks, labeled with the head and base the first page of marks reported. */
async function readChangedFiles(gh: Gh, ref: PrRef): Promise<ChangedFiles> {
  const variables = { owner: ref.owner, name: ref.repo, number: ref.number };
  const page = (after: string | null) =>
    gh.graphql(FILES_QUERY, { ...variables, after }) as Promise<FilesPage>;
  const { files: firstFiles, ...revision } = (await page(null)).repository.pullRequest;
  const [files, viewed] = await Promise.all([
    gh.rest(`${restRepo(ref.owner, ref.repo)}/pulls/${ref.number}/files?per_page=100`, {
      paginate: true,
    }) as Promise<RestFile[]>,
    remainingPages(
      firstFiles,
      async (after) => (await page(after)).repository.pullRequest.files,
      // GitHub lists at most 3000 files on a pull request.
      30,
    ),
  ]);
  return mapChangedFiles(revision, files, viewed);
}
