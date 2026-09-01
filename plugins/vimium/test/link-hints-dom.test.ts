import "./helpers/dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { mountLinkHints } from "../app/link-hints.ts";

function contextWith(signal: AbortSignal): PluginContentScriptContext {
  return { pluginId: "vimium", generation: 1, signal };
}

/** jsdom brand-checks listener options, so signals must come from its own realm. */
function newController(): AbortController {
  return new window.AbortController();
}

function giveRect(element: Element, left: number, top: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      width: 60,
      height: 20,
      right: left + 60,
      bottom: top + 20,
      toJSON: () => ({}),
    }),
  });
}

function pressKey(
  key: string,
  target: EventTarget = window,
  init: Omit<KeyboardEventInit, "key"> = {},
): boolean {
  return target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

function markers(): string[] {
  return [...document.querySelectorAll(".vimium-hint-marker")].map(
    (marker) => marker.textContent ?? "",
  );
}

/**
 * A dropdown trigger that appends a two-item menu on click, like a Radix
 * portal; picking an item records it and, unless the popup is persistent
 * like bb's model dialog, closes the menu.
 */
function installMenuTrigger(
  trigger: HTMLElement,
  picked: string[],
  options: { closeOnPick?: boolean } = {},
): void {
  const closeOnPick = options.closeOnPick ?? true;
  trigger.addEventListener("click", () => {
    const menu = document.createElement("div");
    menu.id = "trigger-menu";
    menu.setAttribute("role", "menu");
    for (const name of ["Sol", "Luna"]) {
      const item = document.createElement("div");
      item.setAttribute("role", "menuitem");
      item.textContent = name;
      item.addEventListener("click", () => {
        picked.push(name);
        if (closeOnPick) menu.remove();
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    giveRect(menu.children[0] as Element, 10, 40);
    giveRect(menu.children[1] as Element, 10, 70);
    trigger.setAttribute("aria-controls", "trigger-menu");
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mountLinkHints", () => {
  test("f shows markers, typing a label clicks its target, and the DOM comes back clean", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<button id="first">First</button><a id="second" href="#second">Second</a>' +
      "<textarea></textarea>";
    const button = document.getElementById("first") as HTMLElement;
    const link = document.getElementById("second") as HTMLElement;
    giveRect(button, 10, 10);
    giveRect(link, 10, 40);
    const clicked: string[] = [];
    button.addEventListener("click", () => clicked.push("first"));
    link.addEventListener("click", () => clicked.push("second"));

    // The textarea has a zero-size rect, so only the two stubbed targets hint,
    // with two-character general labels.
    pressKey("f");
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();
    expect(markers()).toEqual(["dd", "df"]);

    pressKey("d");
    pressKey("f");
    expect(clicked).toEqual(["second"]);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();
    expect(markers()).toEqual([]);

    void dispose();
    controller.abort();
  });

  test("f inside an editable target stays inert", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="only">Only</button><textarea id="editor"></textarea>';
    giveRect(document.getElementById("only") as HTMLElement, 10, 10);

    pressKey("f", document.getElementById("editor") as HTMLElement);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("stable app controls keep their reserved single-character labels", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><button id="model" aria-label="Provider, model and reasoning (⇧ ⌘ M)" aria-haspopup="dialog">Sol</button>' +
      '<button id="project" data-promptbox-project-control>Project</button>' +
      '<div id="editor" role="textbox"></div>' +
      '<button id="actions" aria-label="Prompt actions" aria-haspopup="menu">+</button>' +
      '<button id="permission" aria-label="Permission mode" aria-haspopup="menu">Ask</button>' +
      '<button id="machine" aria-label="Environment" aria-haspopup="menu">Mac</button>' +
      '<button id="branch" aria-label="Branch" aria-haspopup="menu">main</button>' +
      '<button id="send" data-promptbox-submit-action>Send</button></div>' +
      '<button id="new-thread" aria-label="New thread (⌘ N)">New thread</button>' +
      '<button id="search" aria-label="Search threads (⌘ K)">Search</button>' +
      '<button id="context" aria-label="Context window 42% used">42%</button>' +
      '<button id="plain">Plain</button>';
    for (const [index, id] of [
      "model",
      "project",
      "editor",
      "actions",
      "permission",
      "machine",
      "branch",
      "send",
      "new-thread",
      "search",
      "context",
      "plain",
    ].entries()) {
      giveRect(document.getElementById(id) as HTMLElement, 10, 10 + index * 30);
    }
    const clicked: string[] = [];
    document
      .getElementById("model")
      ?.addEventListener("click", () => clicked.push("model"));

    pressKey("f");
    expect(markers()).toEqual(["m", "p", "i", "a", "k", "l", "b", "j", "n", "s", "dd"]);

    pressKey("m");
    expect(clicked).toEqual(["model"]);

    void dispose();
    controller.abort();
  });

  test("the project selector gets p and picking it opens the dropdown", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><button id="project" data-promptbox-project-control aria-haspopup="menu">Project</button>' +
      '<div id="editor" role="textbox"></div></div>' +
      '<button id="plain">Plain</button>';
    const project = document.getElementById("project") as HTMLElement;
    const editor = document.getElementById("editor") as HTMLElement;
    giveRect(project, 10, 10);
    giveRect(editor, 10, 40);
    giveRect(document.getElementById("plain") as HTMLElement, 10, 70);
    const picked: string[] = [];
    installMenuTrigger(project, picked);

    pressKey("f");
    expect(markers()).toEqual(["p", "i", "dd"]);

    pressKey("p");
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "j"]);

    void dispose();
    controller.abort();
  });

  test("the conversation timeline is a quiet zone", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-timeline-row-list><button id="inside">In</button></div>' +
      '<button id="utility" data-utility-button>Line</button>' +
      '<button id="outside">Out</button>';
    giveRect(document.getElementById("inside") as HTMLElement, 10, 10);
    giveRect(document.getElementById("utility") as HTMLElement, 10, 40);
    giveRect(document.getElementById("outside") as HTMLElement, 10, 70);

    pressKey("f");
    expect(markers()).toEqual(["dd"]);

    void dispose();
    controller.abort();
  });

  test("a scroll away from the hints keeps the prompt, a window scroll exits", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div id="quiet" data-timeline-row-list><button>In</button></div>' +
      '<button id="outside">Out</button>';
    giveRect(document.getElementById("outside") as HTMLElement, 10, 10);

    pressKey("f");
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();

    document
      .getElementById("quiet")
      ?.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();

    document.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("thread rows count 1-9 and a digit picks its row", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<a id="t1" href="/threads/a">A</a><a id="t2" href="/threads/b">B</a>' +
      '<a id="t3" data-sidebar-thread-shortcut-target href="#">C</a><button id="other">Other</button>';
    for (const [index, id] of ["t1", "t2", "t3", "other"].entries()) {
      giveRect(document.getElementById(id) as HTMLElement, 10, 10 + index * 30);
    }
    const clicked: string[] = [];
    document.getElementById("t2")?.addEventListener("click", (event) => {
      event.preventDefault();
      clicked.push("t2");
    });

    pressKey("f");
    expect(markers()).toEqual(["1", "2", "3", "dd"]);

    pressKey("2");
    expect(clicked).toEqual(["t2"]);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("activating a dropdown trigger re-prompts scoped to its options", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="trigger" aria-haspopup="menu">Model</button>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    giveRect(trigger, 10, 10);
    const picked: string[] = [];
    installMenuTrigger(trigger, picked);

    pressKey("f");
    expect(markers()).toEqual(["dd"]);
    pressKey("d");
    pressKey("d");
    expect(markers()).toEqual([]);

    // The reprompt polls on a 60ms timer, so give it two ticks.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "j"]);

    pressKey("j");
    expect(picked).toEqual(["Luna"]);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("the force chord replaces a scoped reprompt with a whole-screen prompt", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="trigger" aria-haspopup="menu">Model</button>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    giveRect(trigger, 10, 10);
    installMenuTrigger(trigger, []);

    pressKey("f");
    pressKey("d");
    pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "j"]);

    // The chord is swallowed at once, then the dismissal poll gives up on the
    // Escape-deaf test menu (~8 ticks of 60ms) and prompts over it anyway:
    // trigger plus both menu items, with general labels.
    const propagated = pressKey("F", window, { code: "KeyF", metaKey: true, shiftKey: true });
    expect(propagated).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(markers()).toEqual(["dd", "df", "de"]);

    void dispose();
    controller.abort();
  });

  test("the force chord closes an open layer before prompting the whole screen", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    // A modal layer over an aria-hidden page, like Radix leaves it; its
    // Escape handler undoes both, like Radix does on dismiss.
    document.body.innerHTML =
      '<div id="page" aria-hidden="true"><button id="under">Under</button></div>' +
      '<div id="layer" role="dialog" data-bb-portaled-overlay><button id="in-layer">In</button></div>';
    giveRect(document.getElementById("under") as HTMLElement, 10, 10);
    giveRect(document.getElementById("in-layer") as HTMLElement, 10, 40);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        document.getElementById("layer")?.remove();
        document.getElementById("page")?.removeAttribute("aria-hidden");
      },
      { once: true },
    );

    pressKey("F", window, { code: "KeyF", metaKey: true, shiftKey: true });
    expect(markers()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(markers()).toEqual(["dd"]);

    void dispose();
    controller.abort();
  });

  test("a pick that leaves the popup open re-prompts scoped to it", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="trigger" aria-haspopup="menu">Model</button>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    giveRect(trigger, 10, 10);
    const picked: string[] = [];
    installMenuTrigger(trigger, picked, { closeOnPick: false });

    pressKey("f");
    pressKey("d");
    pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "j"]);

    pressKey("f");
    expect(picked).toEqual(["Sol"]);
    expect(markers()).toEqual([]);

    // The after-pick poll waits ~6 ticks of 80ms for the popup to close, then
    // follows it with a fresh scoped prompt.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(markers()).toEqual(["f", "j"]);

    void dispose();
    controller.abort();
  });

  test("dismissing the popup dismisses the scoped prompt", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="trigger" aria-haspopup="menu">Model</button>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    giveRect(trigger, 10, 10);
    installMenuTrigger(trigger, []);

    pressKey("f");
    pressKey("d");
    pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "j"]);

    document.getElementById("trigger-menu")?.remove();
    // The popup watcher polls on a 100ms timer.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("picking from a composer dropdown hands focus back to the composer", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><button id="trigger" aria-haspopup="menu">Actions</button>' +
      '<div id="editor" role="textbox"></div></div>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    giveRect(trigger, 10, 10);
    const picked: string[] = [];
    installMenuTrigger(trigger, picked);
    let focusCalls = 0;
    (document.getElementById("editor") as HTMLElement).focus = () => {
      focusCalls += 1;
    };

    pressKey("f");
    pressKey("d");
    pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "j"]);

    pressKey("f");
    expect(picked).toEqual(["Sol"]);
    // The refocus poll waits for the menu to close, then claims focus on the
    // next 80ms tick.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(focusCalls).toBeGreaterThanOrEqual(1);

    void dispose();
    controller.abort();
  });

  test("Escape exits and the disposer plus abort remove everything", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="only">Only</button>';
    giveRect(document.getElementById("only") as HTMLElement, 10, 10);

    pressKey("f");
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();
    pressKey("Escape");
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    pressKey("f");
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();
    void dispose();
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    controller.abort();
    pressKey("f");
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();
  });
});
