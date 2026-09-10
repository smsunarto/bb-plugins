import { afterEach, expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { cleanup, waitFor } from "@testing-library/react";
import { interceptComposer, routingStatus } from "../src/app/autorouter/intercept.ts";
import type { AutorouterRoute } from "../src/shared/autorouter/contract.ts";

installDom();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document
    .querySelector<HTMLButtonElement>('[aria-label="Dismiss autorouting notification"]')
    ?.click();
  cleanup();
  document.body.replaceChildren();
});

const route: AutorouterRoute = {
  projectId: "project",
  projectName: "Project",
  execution: {
    route: "sol/medium",
    providerId: "codex",
    providerLabel: "Codex",
    model: "gpt-5.6-sol",
    modelLabel: "5.6 Sol",
    reasoningLevel: "medium",
    reasoningLabel: "Medium",
  },
  usedFallback: false,
  modelReason: "Routine work",
  projectReason: "Explicit target",
};

let nextId = 0;
function fixture(
  options: {
    enabled?: boolean;
    followup?: boolean;
    selection?: string;
    infer?: () => Promise<AutorouterRoute | null>;
  } = {},
) {
  const threadId = `intercept-${nextId++}`;
  const form = document.createElement("form");
  form.setAttribute("data-promptbox", "");
  form.innerHTML =
    '<div role="textbox" contenteditable="true" enterkeyhint="send">Use the attached plan.</div><span data-attachment="plan.md"></span><button type="button" aria-label="Provider, model and reasoning" aria-controls="models"><span title="Codex: 6-Astra · High reasoning">Astra</span></button><button type="submit" data-promptbox-submit-action>Send</button>';
  const menu = document.createElement("div");
  menu.id = "models";
  menu.innerHTML =
    '<button type="button" title="Codex">Codex</button><button type="button"><span title="5.6 Sol">5.6 Sol</span></button><button type="button"><span title="Medium">Medium</span></button>';
  const picker = form.querySelector<HTMLButtonElement>('button[type="button"]')!;
  const title = picker.querySelector("span")!;
  title.setAttribute("title", options.selection ?? "Codex: 6-Astra · High reasoning");
  picker.addEventListener("click", () => {
    if (menu.isConnected) {
      menu.remove();
      picker.setAttribute("aria-expanded", "false");
    } else {
      document.body.append(menu);
      picker.setAttribute("aria-expanded", "true");
    }
  });
  const providerClicked = mock(() => {});
  const modelClicked = mock(() => {});
  menu.children[0]!.addEventListener("click", providerClicked);
  menu.children[1]!.addEventListener("click", modelClicked);
  menu.children[1]!.addEventListener("click", () =>
    title.setAttribute("title", "Codex: 5.6 Sol · High reasoning"),
  );
  menu.children[2]!.addEventListener("click", () =>
    title.setAttribute(
      "title",
      title.getAttribute("title")!.replace(/· .* reasoning$/, "· Medium reasoning"),
    ),
  );
  const astraModel = document.createElement("button");
  astraModel.type = "button";
  astraModel.textContent = "6-Astra";
  astraModel.addEventListener("click", modelClicked);
  astraModel.addEventListener("click", () =>
    title.setAttribute("title", "Codex: 6-Astra · High reasoning"),
  );
  menu.append(astraModel);
  const sent = mock(() => {});
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sent();
  });
  document.body.append(form);
  const infer = mock(options.infer ?? (async () => route));
  const lock = mock((_locked: boolean) => {});
  cleanups.push(
    interceptComposer({
      root: form,
      scope: () =>
        options.followup
          ? { kind: "thread", threadId }
          : { kind: "new-thread", projectId: "project" },
      text: () => form.querySelector('[role="textbox"]')!.textContent!,
      enabled: () => options.enabled ?? true,
      lock,
      infer,
    }),
  );
  return {
    form,
    editor: form.querySelector<HTMLElement>('[role="textbox"]')!,
    send: form.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    sent,
    infer,
    lock,
    title,
    providerClicked,
    modelClicked,
    key: options.followup ? `thread:${threadId}` : "new-thread",
  };
}

test("click and repeated Enter while inference is pending resume native submission exactly once", async () => {
  let resolve!: (route: AutorouterRoute) => void;
  const f = fixture({
    infer: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  f.send.click();
  f.send.click();
  f.editor.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  expect(f.infer).toHaveBeenCalledTimes(1);
  expect(f.sent).not.toHaveBeenCalled();
  resolve(route);
  await waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1));
  expect(f.form.querySelector('[data-attachment="plan.md"]')).not.toBeNull();
  expect(f.editor.textContent).toBe("Use the attached plan.");
  expect(f.lock.mock.calls.at(-1)).toEqual([false]);
});

test("ordinary Enter routes before submitting", async () => {
  const f = fixture();
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  f.editor.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1));
});

test.each([
  { shiftKey: true },
  { metaKey: true },
  { ctrlKey: true },
  { altKey: true },
  { isComposing: true },
])("preserves native modified Enter and composition: %j", (modifiers) => {
  const f = fixture();
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  f.editor.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(f.infer).not.toHaveBeenCalled();
});

test("typeahead selection and touch-keyboard newlines bypass routing", () => {
  const f = fixture();
  const menu = document.createElement("div");
  menu.setAttribute("data-promptbox-typeahead-menu", "");
  menu.innerHTML = '<button title="/index-projects">Index projects</button>';
  f.form.append(menu);
  f.editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  menu.remove();
  f.editor.setAttribute("enterkeyhint", "enter");
  f.editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(f.infer).not.toHaveBeenCalled();
});

test("disabled autorouter leaves the native submit path untouched", () => {
  const f = fixture({ enabled: false });
  f.send.click();
  expect(f.sent).toHaveBeenCalledTimes(1);
  expect(f.infer).not.toHaveBeenCalled();
});

test("changing the draft while routing prevents a stale result from sending", async () => {
  let resolve!: (route: AutorouterRoute) => void;
  const f = fixture({
    infer: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  f.send.click();
  f.editor.textContent = "A different task";
  resolve(route);
  await waitFor(() => expect(routingStatus(f.key).error).toBe(true));
  expect(f.sent).not.toHaveBeenCalled();
  expect(f.editor.textContent).toBe("A different task");
  expect(f.lock.mock.calls.at(-1)).toEqual([false]);
});

test("failed routing leaves the draft and displays the error", async () => {
  const f = fixture({
    infer: async () => {
      throw new Error("Fallback unavailable");
    },
  });
  f.send.click();
  await waitFor(() =>
    expect(routingStatus(f.key)).toMatchObject({
      busy: false,
      error: true,
      message: "Fallback unavailable",
    }),
  );
  expect(f.sent).not.toHaveBeenCalled();
  expect(f.editor.textContent).toBe("Use the attached plan.");
});

const astraRoute: AutorouterRoute = {
  ...route,
  execution: {
    ...route.execution!,
    route: "astra/medium",
    model: "gpt-6-astra",
    modelLabel: "6-Astra",
  },
};

test.each([
  "Codex: 5.6-Sol · High reasoning",
  "Claude Code: Fable 5.1 · High reasoning",
  "Claude Code: Opus 5 · High reasoning",
])("non-Astra follow-up submits unchanged without inference: %s", (selection) => {
  const f = fixture({ followup: true, selection });
  f.send.click();
  expect(f.sent).toHaveBeenCalledTimes(1);
  expect(f.infer).not.toHaveBeenCalled();
  expect(f.title.getAttribute("title")).toBe(selection);
  expect(f.providerClicked).not.toHaveBeenCalled();
  expect(f.modelClicked).not.toHaveBeenCalled();
});

test("Astra follow-up changes only reasoning without notifications", async () => {
  const f = fixture({ followup: true, infer: async () => astraRoute });
  f.send.click();
  await waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1));
  expect(f.title.getAttribute("title")).toBe("Codex: 6-Astra · Medium reasoning");
  expect(f.providerClicked).not.toHaveBeenCalled();
  expect(f.modelClicked).not.toHaveBeenCalled();
  expect(document.querySelector(".autorouter-notification")).toBeNull();
});

test("a model-changing follow-up result is rejected before clicking any execution option", async () => {
  const f = fixture({ followup: true });
  f.send.click();
  await waitFor(() => expect(routingStatus(f.key).error).toBe(true));
  expect(f.sent).not.toHaveBeenCalled();
  expect(f.title.getAttribute("title")).toBe("Codex: 6-Astra · High reasoning");
  expect(f.providerClicked).not.toHaveBeenCalled();
  expect(f.modelClicked).not.toHaveBeenCalled();
});

test("a manual execution edit during routing preserves the draft and the user's selection", async () => {
  let resolve!: (route: AutorouterRoute) => void;
  const f = fixture({
    followup: true,
    infer: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  f.send.click();
  f.title.setAttribute("title", "Codex: 5.6-Sol · Low reasoning");
  resolve(astraRoute);
  await waitFor(() => expect(routingStatus(f.key).error).toBe(true));
  expect(f.sent).not.toHaveBeenCalled();
  expect(f.modelClicked).not.toHaveBeenCalled();
  expect(f.title.getAttribute("title")).toBe("Codex: 5.6-Sol · Low reasoning");
});

test("native model selector shimmers during routing and clears after success or failure", async () => {
  let resolve!: (value: AutorouterRoute) => void;
  const f = fixture({
    infer: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  f.send.click();
  expect(f.form.querySelector("[data-autorouter-working]")).not.toBeNull();
  resolve(route);
  await waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1));
  expect(f.form.querySelector("[data-autorouter-working]")).toBeNull();
  const failed = fixture({
    infer: async () => {
      throw new Error("Offline");
    },
  });
  failed.send.click();
  await waitFor(() => expect(routingStatus(failed.key).error).toBe(true));
  expect(failed.form.querySelector("[data-autorouter-working]")).toBeNull();
});

test("project-only routing preserves the native execution selection", async () => {
  const f = fixture({ infer: async () => ({ ...route, execution: null }) });
  f.send.click();
  await waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1));
  expect(f.title.getAttribute("title")).toBe("Codex: 6-Astra · High reasoning");
  expect(f.modelClicked).not.toHaveBeenCalled();
});

test("Luna Max follow-up changes model to Astra through the native selector", async () => {
  const f = fixture({
    followup: true,
    selection: "Codex: 5.6-Luna · Max reasoning",
    infer: async () => astraRoute,
  });
  f.send.click();
  await waitFor(() => expect(f.sent).toHaveBeenCalledTimes(1));
  expect(f.title.getAttribute("title")).toBe("Codex: 6-Astra · Medium reasoning");
  expect(f.modelClicked).toHaveBeenCalledTimes(1);
});

test("Astra follow-up rejects a Luna destination before native selection changes", async () => {
  const f = fixture({
    followup: true,
    infer: async () => ({
      ...route,
      execution: {
        ...route.execution!,
        route: "luna/max",
        model: "gpt-5.6-luna",
        modelLabel: "5.6-Luna",
        reasoningLevel: "max",
        reasoningLabel: "Max",
      },
    }),
  });
  f.send.click();
  await waitFor(() => expect(routingStatus(f.key).error).toBe(true));
  expect(f.sent).not.toHaveBeenCalled();
  expect(f.modelClicked).not.toHaveBeenCalled();
});
