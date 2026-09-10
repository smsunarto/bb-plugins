import type { AutorouterRoute, AutorouterScope } from "../../shared/autorouter/contract.ts";
import {
  isSubmitEnter,
  executionTitle,
  isAstraSelection,
  selectAstraReasoning,
  selectExecution,
  selectProject,
  SUBMIT,
  waitFor,
} from "./native-controls.ts";
import { notifyAutorouted } from "./notification.tsx";

export interface ComposerBinding {
  root: HTMLElement;
  scope(): AutorouterScope;
  text(): string;
  enabled(): boolean;
  lock(locked: boolean): void;
  infer(selectionTitle: string): Promise<AutorouterRoute | null>;
}

export interface RoutingStatus {
  busy: boolean;
  message: string;
  error: boolean;
}
const IDLE: RoutingStatus = { busy: false, message: "", error: false };
const states = new Map<string, RoutingStatus>();
const listeners = new Set<() => void>();
const bindings = new Set<ComposerBinding>();
const jobs = new Map<string, AbortController>();
const resuming = new WeakSet<HTMLElement>();

export const composerKey = (scope: AutorouterScope) =>
  scope.kind === "new-thread" ? "new-thread" : `thread:${scope.threadId}`;
export const routingStatus = (key: string) => states.get(key) ?? IDLE;
export function subscribeRouting(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function report(key: string, status: RoutingStatus) {
  states.set(key, status);
  for (const listener of listeners) listener();
}

function forgetUnusedStatus(key: string) {
  if (!jobs.has(key) && ![...bindings].some((binding) => composerKey(binding.scope()) === key)) {
    states.delete(key);
  }
}

/** Mounted by the SDK composer action. Only its own native composer is intercepted. */
export function interceptComposer(binding: ComposerBinding) {
  bindings.add(binding);
  const doc = binding.root.ownerDocument;
  const intercept = (event: Event) => {
    if (resuming.has(binding.root) || !binding.enabled()) return;
    const target = event.target;
    const isClick =
      event.type === "click" &&
      target instanceof Element &&
      target.closest(SUBMIT)?.closest("[data-promptbox]") === binding.root;
    const isForm = event.type === "submit" && target === binding.root;
    const isEnter = event instanceof KeyboardEvent && isSubmitEnter(event, binding.root);
    if (!isClick && !isForm && !isEnter) return;
    const key = composerKey(binding.scope());
    if (!jobs.has(key) && !canRoute(binding)) return;
    const button = binding.root.querySelector<HTMLButtonElement>(SUBMIT);
    if (!jobs.has(key) && (!button || button.disabled)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (jobs.has(key) || (event instanceof KeyboardEvent && event.repeat)) return;
    void routeAndSubmit(binding);
  };
  doc.addEventListener("click", intercept, true);
  doc.addEventListener("submit", intercept, true);
  doc.addEventListener("keydown", intercept, true);
  return () => {
    bindings.delete(binding);
    doc.removeEventListener("click", intercept, true);
    doc.removeEventListener("submit", intercept, true);
    doc.removeEventListener("keydown", intercept, true);
    binding.lock(false);
    forgetUnusedStatus(composerKey(binding.scope()));
  };
}

function canRoute(binding: ComposerBinding) {
  return binding.scope().kind === "new-thread" || isAstraSelection(binding.root);
}
function routeMessage(route: AutorouterRoute | null) {
  return route
    ? `${route.usedFallback ? "Fallback: " : ""}${route.modelLabel} · ${route.reasoningLabel}`
    : "";
}

async function routeAndSubmit(initial: ComposerBinding) {
  const key = composerKey(initial.scope());
  const controller = new AbortController();
  jobs.set(key, controller);
  const { signal } = controller;
  let current = initial;
  const text = initial.text();
  const originalScope = initial.scope();
  const originalSelection = executionTitle(initial.root);
  const doc = initial.root.ownerDocument;
  const unchanged = (binding: ComposerBinding) => {
    if (!binding.root.isConnected || !binding.enabled() || binding.text() !== text) {
      throw new Error("The composer changed while routing. Review your draft and submit again.");
    }
  };
  try {
    report(key, {
      busy: true,
      message:
        originalScope.kind === "thread" ? "Routing Astra reasoning…" : "Routing project and model…",
      error: false,
    });
    initial.lock(true);
    const route = await initial.infer(originalSelection);
    unchanged(initial);
    if (executionTitle(initial.root) !== originalSelection) {
      throw new Error(
        "The execution selection changed while routing. Review your draft and submit again.",
      );
    }
    if (
      originalScope.kind === "new-thread" &&
      route?.projectId &&
      route.projectId !== originalScope.projectId
    ) {
      await selectProject(initial.root, route.projectId, signal);
      current = await waitFor(
        doc,
        () =>
          [...bindings].find((binding) => {
            const scope = binding.scope();
            return (
              binding.root.isConnected &&
              scope.kind === "new-thread" &&
              scope.projectId === route.projectId
            );
          }),
        signal,
        "BB did not switch to the routed project. Your draft has been kept.",
      );
      current.lock(true);
    }
    unchanged(current);
    if (route) {
      report(key, {
        busy: true,
        message: routeMessage(route),
        error: false,
      });
      if (originalScope.kind === "thread") await selectAstraReasoning(current.root, route, signal);
      else await selectExecution(current.root, route, signal);
    }
    unchanged(current);
    current.lock(false);
    const button = await waitFor(
      doc,
      () => {
        unchanged(current);
        if (
          route &&
          executionTitle(current.root) !==
            `${route.providerLabel}: ${route.modelLabel} · ${route.reasoningLabel} reasoning`
        ) {
          throw new Error(
            "The execution selection changed before sending. Your draft has been kept.",
          );
        }
        const button = current.root.querySelector<HTMLButtonElement>(SUBMIT);
        return button && !button.disabled ? button : null;
      },
      signal,
      "BB is not ready to send. Your draft has been kept.",
    );
    resuming.add(current.root);
    try {
      button.click();
    } finally {
      resuming.delete(current.root);
    }
    report(key, {
      busy: false,
      message: routeMessage(route),
      error: false,
    });
    if (route) notifyAutorouted(route, originalScope.kind === "thread");
  } catch (error) {
    report(key, {
      busy: false,
      message:
        error instanceof Error ? error.message : "Autorouting failed. Your draft has been kept.",
      error: true,
    });
  } finally {
    initial.lock(false);
    if (current !== initial) current.lock(false);
    jobs.delete(key);
    forgetUnusedStatus(key);
  }
}
