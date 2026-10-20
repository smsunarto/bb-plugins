import type { MediaRequest } from "./generation.ts";

/** Add canvas reference labels at dispatch, preserving the authored brief and its validation. */
export function generationPrompt(
  request: Exclude<MediaRequest, { kind: "model-3d" } | { kind: "model-edit" }>,
) {
  if (request.kind === "video" || !request.imageReferenceKey) return request.prompt;
  return `${request.prompt}\n\n${request.imageReferenceKey}`;
}
