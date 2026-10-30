export type ReviewApiTarget =
  | { kind: "worktree"; repositoryId: string; base?: string }
  | { kind: "commits"; repositoryId: string; head: string; base?: string };

/** A catalog row; document contents stay in snapshots. */
export interface ReviewApiSummary {
  reviewId: string;
  version: number;
  title: string;
  /** Absent for a review. The one scratchpad has no pins or lifecycle. */
  kind?: "scratchpad";
  /** What is on the scratchpad, for its Home card; absent for a review. */
  contents?: { blocks: number; diagrams: number };
  /** Absent for a document whose references all carry their own pins. */
  source?: {
    pins: {
      repositoryId: string;
      base: string;
      head: string;
      worktreeRevision?: string;
    };
    target: ReviewApiTarget;
  };
  createdAt: string;
  /** Timestamp of the earliest retained review version, when known. */
  firstCreatedAt?: string;
  /** Present on reviews imported from the legacy MDX store. */
  origin?: {
    branch?: string;
    baseRef?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    revision?: string;
  };
  /** Shared imports have separate local checkouts but retain their remote identity. */
  shared?: { cloneUrl?: string };
  /** Display grouping only; source pins remain bound to their own checkout. */
  repositoryGroup?: { key: string; label: string };
  repositoryName: string;
  repositoryPath?: string;
  diffStats?: {
    fileCount: number;
    additions: number;
    deletions: number;
  } | null;
  viewedAt: string | null;
  dismissedAt: string | null;
}

export interface ReviewSourceEntry {
  path: string;
  kind: "file" | "directory";
}
