// Vendored from dev.fast review-protocol/src/index.ts @4ecc570 (MIT).
export * from "@dev.fast/diffr";

export * from "./structural-diff.ts";

import type { JsonValue } from "../../json/src/index.ts";
import { z } from "zod";

export {
  parseReviewCodePeekPatch,
  reviewCodePeekRowAnchorLine,
  reviewCodePeekRangeCounts,
  type ReviewCodePeekPatch,
  type ReviewCodePeekHunk,
  type ReviewCodePeekHunkRow,
  type ReviewCodePeekOrientation,
} from "./code-peek-diff.ts";

import {
  type ReviewAgentTraceListResponse,
  ReviewAgentTraceListResponseSchema,
  type ReviewAgentTraceResponse,
  ReviewAgentTraceResponseSchema,
  type ReviewCliInstallApplyRequest,
  ReviewCliInstallApplyRequestSchema,
  type ReviewCliInstallApplyResponse,
  ReviewCliInstallApplyResponseSchema,
  type ReviewCliInstallStatus,
  ReviewCliInstallStatusSchema,
  type ReviewDesktopDiscovery,
  ReviewDesktopDiscoverySchema,
  type ReviewDesktopVerbFrame,
  ReviewDesktopVerbFrameSchema,
  type ReviewDesktopVerbResult,
  ReviewDesktopVerbResultSchema,
  type ReviewDiffFilesResponse,
  ReviewDiffFilesResponseSchema,
  type ReviewFileContentRequest,
  ReviewFileContentRequestSchema,
  type ReviewFileContentResponse,
  ReviewFileContentResponseSchema,
  type ReviewStackResponse,
  ReviewStackResponseSchema,
  type ReviewTutorialOpenResponse,
  ReviewTutorialOpenResponseSchema,
  type ReviewVerbRequest,
  ReviewVerbRequestSchema,
  type ReviewVerbResponse,
  ReviewVerbResponseSchema,
} from "./contracts.ts";

export * from "./bug-report.ts";

export * from "../../json/src/index.ts";

export * from "./contracts.ts";

export * from "./review-api-client.ts";

export {
  type ByCommitEntry,
  type ReviewAgentTraceEvent,
  ReviewAgentTraceEventSchema,
  type ReviewAgentTraceSession,
  ReviewAgentTraceSessionSchema,
  type SessionMeta,
  byCommitSchema,
  commitShaSchema,
  sessionIdSchema,
  sessionMetaSchema,
} from "../../trace-protocol/src/index.ts";

export function parseReviewDesktopDiscovery(
  value: JsonValue,
): ReviewDesktopDiscovery {
  return parseZod(ReviewDesktopDiscoverySchema, value);
}

export function parseReviewStackResponse(
  value: JsonValue,
): ReviewStackResponse {
  return parseZod(ReviewStackResponseSchema, value);
}

export function parseReviewCliInstallStatus(
  value: JsonValue,
): ReviewCliInstallStatus {
  return parseZod(ReviewCliInstallStatusSchema, value);
}

export function parseReviewCliInstallApplyRequest(
  value: JsonValue,
): ReviewCliInstallApplyRequest {
  return parseZod(ReviewCliInstallApplyRequestSchema, value);
}

export function parseReviewCliInstallApplyResponse(
  value: JsonValue,
): ReviewCliInstallApplyResponse {
  return parseZod(ReviewCliInstallApplyResponseSchema, value);
}

export function parseReviewTutorialOpenResponse(
  value: JsonValue,
): ReviewTutorialOpenResponse {
  return parseZod(ReviewTutorialOpenResponseSchema, value);
}

export function parseReviewDesktopVerbFrame(
  value: JsonValue,
): ReviewDesktopVerbFrame {
  return parseZod(ReviewDesktopVerbFrameSchema, value);
}

export function parseReviewDesktopVerbResult(
  value: JsonValue,
): ReviewDesktopVerbResult {
  return parseZod(ReviewDesktopVerbResultSchema, value);
}

export function parseReviewDiffFilesResponse(
  value: JsonValue,
): ReviewDiffFilesResponse {
  return parseZod(ReviewDiffFilesResponseSchema, value);
}

export function parseReviewFileContentResponse(
  value: JsonValue,
): ReviewFileContentResponse {
  return parseZod(ReviewFileContentResponseSchema, value);
}

export function parseReviewFileContentRequest(
  value: JsonValue,
): ReviewFileContentRequest {
  return parseZod(ReviewFileContentRequestSchema, value);
}

export function parseReviewVerbRequest(value: JsonValue): ReviewVerbRequest {
  return parseZod(ReviewVerbRequestSchema, value);
}

export function parseReviewVerbResponse(value: JsonValue): ReviewVerbResponse {
  return parseZod(ReviewVerbResponseSchema, value);
}

export function parseReviewAgentTraceListResponse(
  value: JsonValue,
): ReviewAgentTraceListResponse {
  return parseZod(ReviewAgentTraceListResponseSchema, value);
}

export function parseReviewAgentTraceResponse(
  value: JsonValue,
): ReviewAgentTraceResponse {
  return parseZod(ReviewAgentTraceResponseSchema, value);
}

export function parseZod<T>(
  schema: z.ZodType<T>,
  value: JsonValue,
  label?: string,
  prefixPath = false,
): T {
  const result = schema.safeParse(value);

  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const issuePath = formatIssuePath(issue?.path ?? []);

  const path =
    prefixPath && label
      ? issuePath
        ? `${label}.${issuePath}`
        : label
      : issuePath || label;

  throw new Error(
    `${path ? `${path} ` : ""}${issue?.message ?? "Invalid input"}`,
  );
}

function formatIssuePath(path: PropertyKey[]): string {
  let output = "";

  for (const segment of path) {
    if (Number.isInteger(segment)) {
      output += `[${String(segment)}]`;
    } else {
      output += `${output ? "." : ""}${String(segment)}`;
    }
  }

  return output;
}

export { structuralRows } from "./source-alignment.ts";
