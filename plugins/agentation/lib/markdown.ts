// Rendering annotations for agents.
//
// The toolbar already produces markdown for copy/paste, but it knows nothing
// about bb: it cannot say which plugin owns the element or which thread the
// reviewer was looking at. These renderers add that, and they are what the
// agent tools, the CLI, and "Send to agent" all return, so an annotation reads
// the same wherever an agent meets it.

import type { Session, StoredAnnotation } from "./afs.ts";
import { pluginUiSurfacePromptContext } from "./plugin-ui-surface-map.ts";

function line(label: string, value: string | null | undefined): string {
  return value ? `**${label}:** ${value}\n` : "";
}

function locationOf(annotation: StoredAnnotation): string {
  const { pluginId, route, routeLabel } = annotation.bb;
  const routeContext = routeLabel ? ` \`${route}\` (${routeLabel})` : ` \`${route}\``;
  if (!pluginId) return `bb app shell · route${routeContext}`;
  return `plugin \`${pluginId}\` · route${routeContext}`;
}

function pluginUiOf(annotation: StoredAnnotation): string | null {
  const { pluginId, surface, surfaceId } = annotation.bb;
  if (!pluginId || !surface) return null;

  const context = pluginUiSurfacePromptContext(surface);
  const registrationId = surfaceId ? ` · registration \`${surfaceId}\`` : "";
  return `\`${context.registration}\`${registrationId} — ${context.role}. Start at this registration in plugin \`${pluginId}\`'s \`app.tsx\`, then follow its component or run handler.`;
}

function describeKind(annotation: StoredAnnotation): string | null {
  if (annotation.kind === "placement" && annotation.placement) {
    const { componentType, width, height } = annotation.placement;
    return `place a \`${componentType}\` here, roughly ${Math.round(width)}×${Math.round(height)}px`;
  }
  if (annotation.kind === "rearrange" && annotation.rearrange) {
    const { label, originalRect, currentRect } = annotation.rearrange;
    const dx = Math.round(currentRect.y - originalRect.y);
    const direction = dx < 0 ? "earlier" : "later";
    return `move the \`${label}\` section ${Math.abs(dx)}px ${direction} in the page order`;
  }
  return null;
}

/** One annotation as a self-contained markdown section. */
export function renderAnnotation(annotation: StoredAnnotation, index?: number): string {
  const heading =
    index === undefined
      ? `### ${annotation.element} — ${annotation.id}`
      : `### ${index}. ${annotation.element} — ${annotation.id}`;

  let out = `${heading}\n`;
  out += line("Where", locationOf(annotation));
  out += line("Plugin UI", pluginUiOf(annotation));
  out += line("Selector", `\`${annotation.elementPath}\``);
  out += line("React", annotation.reactComponents);
  out += line("Source", annotation.sourceFile);
  out += line("Classes", annotation.cssClasses);
  out += line("Selected text", annotation.selectedText ? `"${annotation.selectedText}"` : null);
  out += line("Nearby text", annotation.selectedText ? null : annotation.nearbyText?.slice(0, 160));
  out += line("Intent", annotation.intent);
  out += line("Severity", annotation.severity);
  out += line("Status", annotation.status);

  const kindNote = describeKind(annotation);
  out += line("Layout request", kindNote);

  out += `**Feedback:** ${annotation.comment}\n`;

  if (annotation.thread.length > 0) {
    out += `\n**Conversation:**\n`;
    for (const message of annotation.thread) {
      out += `- _${message.role}_: ${message.content}\n`;
    }
  }
  if (annotation.resolution) {
    out += `\n**Resolution:** ${annotation.resolution}\n`;
  }
  return out;
}

/** A batch of annotations, grouped so the agent reads one page at a time. */
export function renderAnnotations(
  annotations: StoredAnnotation[],
  options: { title?: string; sessions?: Session[] } = {},
): string {
  if (annotations.length === 0) {
    return "No annotations.";
  }

  const bySession = new Map<string, StoredAnnotation[]>();
  for (const annotation of annotations) {
    const bucket = bySession.get(annotation.sessionId);
    if (bucket) bucket.push(annotation);
    else bySession.set(annotation.sessionId, [annotation]);
  }

  const sessionsById = new Map((options.sessions ?? []).map((session) => [session.id, session]));

  let out = `## ${options.title ?? "bb UI feedback"}\n\n`;
  out += `${annotations.length} annotation${annotations.length === 1 ? "" : "s"} across ${bySession.size} page${bySession.size === 1 ? "" : "s"}. For plugin UI, start from the named SDK registration in the owning plugin's \`app.tsx\`, then use the selector and React path to narrow the rendered component.\n`;

  for (const [sessionId, sessionAnnotations] of bySession) {
    const session = sessionsById.get(sessionId);
    const label = session ? `${session.route} (${sessionId})` : sessionId;
    out += `\n---\n\n## Page: ${label}\n\n`;
    sessionAnnotations.forEach((annotation, index) => {
      out += `${renderAnnotation(annotation, index + 1)}\n`;
    });
  }

  return out.trimEnd();
}

/** A self-contained assignment sent directly to one bb thread. */
export function renderAnnotationAssignment(
  annotations: StoredAnnotation[],
  sessions: Session[],
): string {
  const markdown = renderAnnotations(annotations, {
    title: "bb UI feedback from Agentation",
    sessions,
  });

  return `${markdown}\n\nThe annotations above are the complete batch assigned to this thread. Work only on these annotation IDs. Do not call \`agentation_get_all_pending\`; it can include feedback assigned to other threads. Resolve each item with the \`agentation_resolve\` tool once it is fixed, or use \`agentation_reply\` if you need a decision from me.`;
}

/** Fresh agent-only context for one annotation mention in the composer. */
export function renderAnnotationMentionContext(
  annotation: StoredAnnotation,
  session: Session | null,
): string {
  const page = session ? `${session.route} (${session.id})` : annotation.sessionId;
  return `## Agentation annotation reference\n\n**Page:** ${page}\n\n${renderAnnotation(annotation)}\n\nThis mention points to Agentation annotation \`${annotation.id}\`. Use that ID with the Agentation tools if the user asks you to act on it.`;
}

/** One line per annotation, for CLI listings and tool summaries. */
export function renderAnnotationLine(annotation: StoredAnnotation): string {
  const owner = annotation.bb.pluginId ? `plugin:${annotation.bb.pluginId}` : "bb-shell";
  const severity = annotation.severity ? ` [${annotation.severity}]` : "";
  const comment = annotation.comment.replace(/\s+/g, " ").slice(0, 100);
  return `${annotation.id}  ${annotation.status.padEnd(12)} ${owner.padEnd(24)} ${annotation.element.padEnd(10)}${severity} ${comment}`;
}
