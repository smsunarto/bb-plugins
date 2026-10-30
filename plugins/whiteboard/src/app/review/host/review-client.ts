import type { ReviewRuntimeConfig } from "../../../shared/review-protocol/index.ts";

export type ReviewClientConfig = Partial<Pick<ReviewRuntimeConfig, "reviewId" | "wasmUrl">>;

export function reviewWasmUrl(config: ReviewClientConfig): string {
  if (!config.wasmUrl) throw new Error("Review WASM asset URL is missing.");

  return config.wasmUrl;
}

export function reviewStorageKey(
  config: ReviewClientConfig | null,
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return [
    "progressive-review",
    namespace,
    config?.reviewId ?? "server-render",
    ...parts.map((part) => String(part ?? "")),
  ].join(":");
}

// Unlike reviewStorageKey, this omits the review identity: UI preferences
// like panel widths belong to the reader, not to one review, so they
// apply across reviews.
export function reviewPreferenceKey(
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return ["progressive-review", namespace, ...parts.map((part) => String(part ?? ""))].join(":");
}
