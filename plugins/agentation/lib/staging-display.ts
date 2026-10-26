import type {
  ComposerDraftReplacement,
  ComposerDraftSnapshot,
  ComposerMention,
} from "@get-bb/plugin-sdk/app";

import type { BbContext, StoredAnnotation } from "./afs.ts";

const annotationMentionItemPrefix = "v1/";

/** The composer mention provider the server registers for annotation pills. */
export const ANNOTATION_MENTION_PROVIDER = "annotation";

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

export function annotationMentionItemId(annotationId: string, threadId: string | null): string {
  if (!threadId) return annotationId;
  return `${annotationMentionItemPrefix}${encodeURIComponent(annotationId)}/${encodeURIComponent(threadId)}`;
}

export function parseAnnotationMentionItemId(itemId: string): {
  annotationId: string;
  threadId: string | null;
} {
  if (!itemId.startsWith(annotationMentionItemPrefix)) {
    return { annotationId: itemId, threadId: null };
  }

  const encoded = itemId.slice(annotationMentionItemPrefix.length);
  const divider = encoded.indexOf("/");
  if (divider < 1 || divider === encoded.length - 1) {
    return { annotationId: itemId, threadId: null };
  }

  try {
    return {
      annotationId: decodeURIComponent(encoded.slice(0, divider)),
      threadId: decodeURIComponent(encoded.slice(divider + 1)),
    };
  } catch {
    return { annotationId: itemId, threadId: null };
  }
}

/**
 * The draft without this plugin's annotation pills for `itemIds`, with later
 * mention ranges shifted onto the shorter text. Returns `draft` itself when no
 * pill matches, which `composer.replace` treats as a no-op. Attachments are
 * omitted so the replacement preserves them.
 */
export function withoutAnnotationMentions(
  draft: ComposerDraftSnapshot,
  pluginId: string,
  itemIds: ReadonlySet<string>,
): ComposerDraftReplacement {
  const removed = draft.mentions
    .filter(
      (mention) =>
        mention.kind === "plugin" &&
        mention.pluginId === pluginId &&
        mention.provider === ANNOTATION_MENTION_PROVIDER &&
        itemIds.has(mention.id),
    )
    .sort((left, right) => left.from - right.from);
  if (removed.length === 0) return draft;

  let text = "";
  let cursor = 0;
  for (const mention of removed) {
    text += draft.text.slice(cursor, mention.from);
    cursor = mention.to;
  }
  text += draft.text.slice(cursor);

  const removedSet = new Set(removed);
  const mentions: ComposerMention[] = [];
  for (const mention of draft.mentions) {
    if (removedSet.has(mention)) continue;
    const shift = removed.reduce(
      (sum, gone) => sum + (gone.to <= mention.from ? gone.to - gone.from : 0),
      0,
    );
    mentions.push(
      shift === 0 ? mention : { ...mention, from: mention.from - shift, to: mention.to - shift },
    );
  }
  return { text, mentions };
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

interface DispatchedMentionBlock {
  type: string;
  mentions?: readonly { resource: { kind: string; pluginId?: string; itemId?: string } }[];
}

/**
 * Annotations a sent message mentions without naming a thread. The
 * new-thread composer has no thread to put in the pill, so the dispatch that
 * creates the thread assigns them. Wire item ids carry the provider prefix.
 */
export function threadlessAnnotationMentionIds(
  blocks: readonly DispatchedMentionBlock[],
  pluginId: string,
): string[] {
  const prefix = `${ANNOTATION_MENTION_PROVIDER}:`;
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const { resource } of block.mentions ?? []) {
      if (resource.kind !== "plugin" || resource.pluginId !== pluginId) continue;
      if (!resource.itemId?.startsWith(prefix)) continue;
      const { annotationId, threadId } = parseAnnotationMentionItemId(
        resource.itemId.slice(prefix.length),
      );
      if (threadId === null) ids.add(annotationId);
    }
  }
  return [...ids];
}
