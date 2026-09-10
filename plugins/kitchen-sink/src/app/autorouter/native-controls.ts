import type { AutorouterExecution } from "../../shared/autorouter/contract.ts";

export const SUBMIT = 'button[data-promptbox-submit-action][type="submit"]';
export const MODEL_PICKER = 'button[aria-label^="Provider, model and reasoning"]';
export const PROJECT_PICKER = "button[data-promptbox-project-control]";

/** Wait for a native controlled state to render, with bounded failure. */
export function waitFor<T>(
  doc: Document,
  read: () => T | null | undefined | false,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Autorouting cancelled."));
    };
    const check = () => {
      try {
        const result = read();
        if (result) {
          cleanup();
          resolve(result);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, 10_000);
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

function nativeButton(root: ParentNode, selector: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled)
    throw new Error("BB's composer controls are unavailable. Your draft has been kept.");
  return button;
}

async function openPicker(button: HTMLButtonElement, signal: AbortSignal) {
  if (button.getAttribute("aria-expanded") !== "true") button.click();
  return waitFor(
    button.ownerDocument,
    () => {
      const id = button.getAttribute("aria-controls");
      return id ? button.ownerDocument.getElementById(id) : null;
    },
    signal,
    "Could not open BB's selection menu. Your draft has been kept.",
  );
}

export async function selectProject(root: HTMLElement, projectId: string, signal: AbortSignal) {
  const button = nativeButton(root.closest("[data-app-composer]") ?? root, PROJECT_PICKER);
  const menu = await openPicker(button, signal);
  const option = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.getAttribute("data-value") === projectId,
  );
  if (!option || option.getAttribute("aria-disabled") === "true")
    throw new Error(
      "The routed project is unavailable in BB's project picker. Your draft has been kept.",
    );
  option.click();
}

function labeledButton(root: ParentNode, label: string) {
  const normalized = label.trim().toLowerCase();
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      !button.disabled &&
      (button.getAttribute("title")?.trim().toLowerCase() === normalized ||
        button.querySelector("[title]")?.getAttribute("title")?.trim().toLowerCase() ===
          normalized ||
        button.textContent?.trim().toLowerCase() === normalized),
  );
}

function selectionTitle(button: HTMLButtonElement): string {
  return button.querySelector("[title]")?.getAttribute("title") ?? "";
}

export function executionTitle(root: HTMLElement): string {
  const button = root.querySelector<HTMLButtonElement>(MODEL_PICKER);
  return button ? selectionTitle(button) : "";
}

export function isAstraSelection(root: HTMLElement): boolean {
  return executionTitle(root).startsWith("Codex: 6-Astra · ");
}

export function isLunaMaxSelection(root: HTMLElement): boolean {
  return executionTitle(root) === "Codex: 5.6-Luna · Max reasoning";
}
export function isFollowupSelection(root: HTMLElement): boolean {
  return isAstraSelection(root) || isLunaMaxSelection(root);
}
export async function selectFollowupExecution(
  root: HTMLElement,
  route: AutorouterExecution,
  signal: AbortSignal,
) {
  if (
    executionTitle(root) ===
    `${route.providerLabel}: ${route.modelLabel} · ${route.reasoningLabel} reasoning`
  )
    return;
  if (route.providerId !== "codex" || route.model !== "gpt-6-astra" || !isFollowupSelection(root)) {
    throw new Error("Follow-up autorouting can only select Astra. Your draft has been kept.");
  }
  if (isLunaMaxSelection(root)) await selectExecution(root, route, signal);
  else await selectAstraReasoning(root, route, signal);
}

/** Follow-ups never click provider or model options, even for an invalid RPC result. */
export async function selectAstraReasoning(
  root: HTMLElement,
  route: AutorouterExecution,
  signal: AbortSignal,
) {
  const assertModel = () => {
    if (
      route.providerId !== "codex" ||
      route.model !== "gpt-6-astra" ||
      !isAstraSelection(root) ||
      !executionTitle(root).startsWith(`${route.providerLabel}: ${route.modelLabel} · `)
    ) {
      throw new Error(
        "Follow-up autorouting can only change Astra reasoning. Your draft has been kept.",
      );
    }
  };
  assertModel();
  const button = nativeButton(root, MODEL_PICKER);
  const menu = await openPicker(button, signal);
  assertModel();
  const reasoning = labeledButton(menu, route.reasoningLabel);
  if (!reasoning)
    throw new Error("The routed Astra reasoning level is unavailable. Your draft has been kept.");
  reasoning.click();
  await waitFor(
    root.ownerDocument,
    () => {
      assertModel();
      return (
        executionTitle(root) ===
        `${route.providerLabel}: ${route.modelLabel} · ${route.reasoningLabel} reasoning`
      );
    },
    signal,
    "BB did not apply the routed reasoning level. Your draft has been kept.",
  );
  if (button.getAttribute("aria-expanded") === "true") button.click();
}

/** Drive BB's own pickers so native draft, permissions and attachment handling stay authoritative. */
export async function selectExecution(
  root: HTMLElement,
  route: AutorouterExecution,
  signal: AbortSignal,
) {
  const button = nativeButton(root, MODEL_PICKER);
  const menu = await openPicker(button, signal);
  const provider = labeledButton(menu, route.providerLabel);
  if (provider) provider.click();
  else if (!selectionTitle(button).startsWith(`${route.providerLabel}:`)) {
    throw new Error(`The ${route.providerLabel} provider is unavailable in this composer.`);
  }
  const model = await waitFor(
    root.ownerDocument,
    () => labeledButton(menu, route.modelLabel),
    signal,
    `The ${route.modelLabel} model is unavailable on the selected machine. Your draft has been kept.`,
  );
  model.click();
  await waitFor(
    root.ownerDocument,
    () => selectionTitle(button).startsWith(`${route.providerLabel}: ${route.modelLabel}`),
    signal,
    "BB did not apply the routed model. Your draft has been kept.",
  );
  const reasoning = await waitFor(
    root.ownerDocument,
    () => labeledButton(menu, route.reasoningLabel),
    signal,
    `The ${route.reasoningLabel} reasoning level is unavailable. Your draft has been kept.`,
  );
  reasoning.click();
  await waitFor(
    root.ownerDocument,
    () =>
      selectionTitle(button)
        .toLowerCase()
        .includes(`· ${route.reasoningLabel.toLowerCase()} reasoning`),
    signal,
    "BB did not apply the routed reasoning level. Your draft has been kept.",
  );
  if (button.getAttribute("aria-expanded") === "true") button.click();
}

export function isSubmitEnter(event: KeyboardEvent, root: HTMLElement): boolean {
  const target = event.target;
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    target instanceof HTMLElement &&
    target.matches('[role="textbox"][contenteditable="true"][enterkeyhint="send"]') &&
    root.contains(target) &&
    !root.querySelector("[data-promptbox-typeahead-menu] button[title]")
  );
}
