// Annotation Format Schema (AFS) 1.1 — https://www.agentation.com/schema
//
// The browser toolbar emits these objects; bb agents consume them. The schemas
// are deliberately loose about unknown keys so a newer `agentation` release can
// add context fields without this plugin dropping them on the floor. Every
// value that crosses the rpc boundary must still be strict JSON, so
// `sanitizeJson` runs before anything is stored or returned.

import { z } from "zod";

export const AFS_VERSION = "1.1";

export const annotationIntents = ["fix", "change", "question", "approve"] as const;
export const annotationSeverities = ["blocking", "important", "suggestion"] as const;
export const annotationStatuses = ["pending", "acknowledged", "resolved", "dismissed"] as const;
export const annotationKinds = ["feedback", "placement", "rearrange"] as const;

export type AnnotationIntent = (typeof annotationIntents)[number];
export type AnnotationSeverity = (typeof annotationSeverities)[number];
export type AnnotationStatus = (typeof annotationStatuses)[number];
export type AnnotationKind = (typeof annotationKinds)[number];

/** Statuses the browser toolbar stops drawing a marker for. */
export const closedStatuses: readonly AnnotationStatus[] = ["resolved", "dismissed"];

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const threadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["human", "agent"]),
  content: z.string(),
  timestamp: z.number(),
});

/**
 * Where in bb an annotation was made. This is the part AFS cannot express:
 * bb is a single-page app whose DOM is assembled from the host shell plus any
 * number of plugin surfaces, so "which plugin owns this element" is the
 * difference between actionable feedback and a selector nobody can place.
 */
export const bbContextSchema = z.object({
  /** Route path the annotation was taken on, e.g. `/threads/thr_abc`. */
  route: z.string(),
  /** Owning plugin id when the element sat inside a plugin surface. */
  pluginId: z.string().nullable(),
  /** Plugin surface kind (`navPanel`, `threadPanel`, …) when detectable. */
  surface: z.string().nullable(),
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** Human label for the route, used in listings. */
  routeLabel: z.string().nullable(),
});

export type BbContext = z.infer<typeof bbContextSchema>;

/** AFS 1.1 annotation as emitted by the `agentation` browser component. */
export const annotationSchema = z.looseObject({
  id: z.string().min(1),
  comment: z.string(),
  elementPath: z.string(),
  timestamp: z.number(),
  x: z.number(),
  y: z.number(),
  element: z.string(),

  url: z.string().optional(),
  boundingBox: rectSchema.optional(),

  reactComponents: z.string().optional(),
  cssClasses: z.string().optional(),
  computedStyles: z.string().optional(),
  accessibility: z.string().optional(),
  nearbyText: z.string().optional(),
  nearbyElements: z.string().optional(),
  selectedText: z.string().optional(),
  sourceFile: z.string().optional(),
  fullPath: z.string().optional(),

  isFixed: z.boolean().optional(),
  isMultiSelect: z.boolean().optional(),

  intent: z.enum(annotationIntents).optional(),
  severity: z.enum(annotationSeverities).optional(),
  kind: z.enum(annotationKinds).optional(),

  placement: z
    .looseObject({
      componentType: z.string(),
      width: z.number(),
      height: z.number(),
      scrollY: z.number(),
      text: z.string().optional(),
    })
    .optional(),
  rearrange: z
    .looseObject({
      selector: z.string(),
      label: z.string(),
      tagName: z.string(),
      originalRect: rectSchema,
      currentRect: rectSchema,
    })
    .optional(),

  status: z.enum(annotationStatuses).optional(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.enum(["human", "agent"]).optional(),
  thread: z.array(threadMessageSchema).optional(),
});

export type Annotation = z.infer<typeof annotationSchema>;

/** An annotation as this plugin stores and serves it. */
export const storedAnnotationSchema = z.looseObject({
  ...annotationSchema.shape,
  sessionId: z.string(),
  status: z.enum(annotationStatuses),
  kind: z.enum(annotationKinds),
  thread: z.array(threadMessageSchema),
  bb: bbContextSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Free-text note the agent left when it resolved or dismissed the item. */
  resolution: z.string().nullable(),
  /** Monotonic write cursor, used by clients to detect missed changes. */
  seq: z.number().int(),
});

export type StoredAnnotation = z.infer<typeof storedAnnotationSchema>;

export const annotationRoutingStates = ["staged", "sending", "assigned"] as const;

export const annotationRoutingSchema = z.object({
  annotationId: z.string(),
  state: z.enum(annotationRoutingStates),
  assignedThreadId: z.string().nullable(),
  dispatchId: z.string().nullable(),
  updatedAt: z.string(),
});

export type AnnotationRouting = z.infer<typeof annotationRoutingSchema>;

export const sessionStatuses = ["active", "approved", "closed"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const sessionSchema = z.object({
  id: z.string(),
  url: z.string(),
  route: z.string(),
  title: z.string().nullable(),
  status: z.enum(sessionStatuses),
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionSummarySchema = z.object({
  ...sessionSchema.shape,
  counts: z.object({
    total: z.number().int(),
    pending: z.number().int(),
    acknowledged: z.number().int(),
    resolved: z.number().int(),
    dismissed: z.number().int(),
  }),
  lastAnnotationAt: z.string().nullable(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * Strip anything JSON cannot carry. bb rejects rpc results containing
 * `undefined`, bigints, functions, or non-finite numbers rather than coercing
 * them, and the toolbar is third-party code we do not control.
 */
export function sanitizeJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, raw: unknown) => {
      if (typeof raw === "number" && !Number.isFinite(raw)) return null;
      if (typeof raw === "bigint") return Number(raw);
      return raw;
    }),
  ) as T;
}

export function isClosed(status: AnnotationStatus): boolean {
  return closedStatuses.includes(status);
}
