// Vendored from dev.fast review/app/src/host/review-session-data.ts @4ecc570 (MIT).
import type {
  ReviewDocumentVersionWire,
  ReviewStackLayer,
} from "../../../../../../shared/vendor/review-protocol/src/index.ts";

import type { LoadedAgentTrace } from "../use-agent-trace.ts";

export interface ReviewSessionData {
  /** Absent for a review. The scratchpad hides review-only chrome. */
  kind?: "scratchpad";
  /** Absent for a document whose references all carry their own pins. */
  pins?: { base: string; head: string };
  historicalRevision: string | null;
  updatedAtMs: number;
  /** Head branch captured with the displayed snapshot. */
  headBranch?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  traces: ReadonlyMap<string, LoadedAgentTrace>;
  listVersions(): Promise<ReviewDocumentVersionWire[]>;
  stack(signal: AbortSignal): Promise<ReviewStackLayer[]>;
  dismiss(): Promise<void>;
}
