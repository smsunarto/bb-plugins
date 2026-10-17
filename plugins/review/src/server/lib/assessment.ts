import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Reviewer } from "../../shared/schema.ts";

type Events = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
type Request = Extract<Events[number], { type: "client/turn/requested" }>;
function turnFor(events: Events, requestId: string) {
  const accepted = events.filter(
    (event) => event.type === "turn/input/accepted" && event.data.clientRequestId === requestId,
  );
  return accepted.length === 1 && accepted[0]!.scope.kind === "turn"
    ? accepted[0]!.scope.turnId
    : null;
}
function failedAttempt(events: Events, request: Request) {
  const turn = turnFor(events, request.data.requestId);
  if (!turn)
    return events.some(
      (event) =>
        event.type === "client/turn/rejected" && event.data.requestId === request.data.requestId,
    );
  const terminal = events.find(
    (event) =>
      event.type === "turn/completed" && event.scope.kind === "turn" && event.scope.turnId === turn,
  );
  return terminal?.type === "turn/completed" && terminal.data.status !== "completed";
}
function sameRetryInput(previous: Request, retry: Request, accepted: boolean) {
  // BB continues already-accepted input instead of duplicating it in the session.
  const continuation =
    accepted &&
    retry.data.input.length === 1 &&
    retry.data.input[0]?.type === "text" &&
    retry.data.input[0].text === "Please continue." &&
    retry.data.input[0].visibility === "agent-only";
  const normalize = (request: Request) =>
    JSON.stringify(request.data.input.map(({ visibility: _visibility, ...item }) => item));
  return continuation || normalize(previous) === normalize(retry);
}
function retryChain(requests: Request[], events: Events) {
  return requests.every((request, index) => {
    if (!index) return !request.data.retryOfRequestId;
    const previous = requests[index - 1]!;
    // BB points every retry to the original request, including later attempts.
    const linked =
      request.data.retryOfRequestId === requests[0]!.data.requestId ||
      request.data.retryOfRequestId === previous.data.requestId;
    return (
      linked &&
      failedAttempt(events, previous) &&
      sameRetryInput(previous, request, Boolean(turnFor(events, previous.data.requestId)))
    );
  });
}
function cleanTurns(requests: Request[], events: Events) {
  return requests.every((request) => {
    const turnId = turnFor(events, request.data.requestId);
    return !events.some(
      (event) =>
        event.type === "turn/input/accepted" &&
        event.scope.kind === "turn" &&
        event.scope.turnId === turnId &&
        event.data.clientRequestId !== request.data.requestId,
    );
  });
}
/** A retry replaces a failed attempt; only its own output and context reads count. */
export function bindAssessment(runId: string, reviewer: Reviewer, events: Events) {
  const all = events.filter((event): event is Request => event.type === "client/turn/requested");
  const hasHeader = (request: Request) =>
    request.data.input.some(
      (item) => item.type === "text" && item.text.startsWith(`Review run ${runId}:`),
    );
  const root = all.find((request) => hasHeader(request) && !request.data.retryOfRequestId);
  const requests = all.filter(
    (request) =>
      hasHeader(request) || (root && request.data.retryOfRequestId === root.data.requestId),
  );
  const latest = requests.at(-1);
  const turnId = latest ? turnFor(events, latest.data.requestId) : null;
  const turn = events.filter(
    (event) => event.scope.kind === "turn" && event.scope.turnId === turnId,
  );
  const messages = turn.filter(
    (event) => event.type === "item/completed" && event.data.item.type === "agentMessage",
  );
  const message = messages.at(-1);
  const text =
    message?.type === "item/completed" && message.data.item.type === "agentMessage"
      ? message.data.item.text
      : "";
  const terminal = turn.find((event) => event.type === "turn/completed");
  const finished = terminal?.type === "turn/completed" && terminal.data.status === "completed";
  const fallback = events.some(
    (event) =>
      event.type === "provider/modelFallback" &&
      (event.scope.kind !== "turn" || event.scope.turnId === turnId),
  );
  // BB may demote a requested fast tier when its global switch is disabled.
  const executionMatches =
    latest?.data.execution.model === reviewer.model &&
    latest.data.execution.reasoningLevel === reviewer.reasoningLevel;
  return {
    text,
    finished,
    turnId: turnId ?? "",
    valid: Boolean(
      turnId &&
      retryChain(requests, events) &&
      cleanTurns(requests, events) &&
      finished &&
      !fallback &&
      executionMatches,
    ),
  };
}
