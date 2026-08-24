import type { BbContext, StoredAnnotation } from "./afs.ts";

export interface ThreadTitleParts {
  title: string | null;
  titleFallback: string | null;
}

export function threadDisplayTitle(thread: ThreadTitleParts): string {
  const title = thread.title?.trim();
  if (title) return title;

  const fallback = thread.titleFallback?.trim();
  return fallback || "Untitled thread";
}

export function annotationSourceLabel(
  context: Pick<BbContext, "route" | "routeLabel" | "threadId">,
  threadTitles: Readonly<Record<string, string>>,
): string {
  if (context.threadId) {
    return `thread: ${threadTitles[context.threadId] ?? "unavailable"}`;
  }

  return context.routeLabel?.trim() || context.route;
}

export interface AnnotationMentionLabelParts {
  location: string;
  target: string;
  comment: string;
}

export function annotationMentionLabelParts(
  annotation: Pick<StoredAnnotation, "comment" | "element" | "id">,
  location: string,
): AnnotationMentionLabelParts {
  const normalizedLocation = location.trim().replace(/\s+/gu, " ") || "unknown location";
  const comment = annotation.comment.trim().replace(/\s+/gu, " ") || annotation.id;
  const target = annotation.element.trim().replace(/\s+/gu, " ") || "annotation";

  return {
    location: truncateLabelPart(normalizedLocation, 32),
    target: truncateLabelPart(target, 25),
    comment: truncateLabelPart(comment, 45),
  };
}

export function annotationMentionLabel(
  annotation: Pick<StoredAnnotation, "comment" | "element" | "id">,
  location: string,
): string {
  const parts = annotationMentionLabelParts(annotation, location);
  return `[${parts.location}] ${parts.target} → ${parts.comment}`;
}

function truncateLabelPart(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function annotationMatchesMentionQuery(
  annotation: Pick<StoredAnnotation, "bb" | "comment" | "element" | "id">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return [
    annotation.id,
    annotation.comment,
    annotation.element,
    annotation.bb.pluginId,
    annotation.bb.routeLabel,
    annotation.bb.route,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}
