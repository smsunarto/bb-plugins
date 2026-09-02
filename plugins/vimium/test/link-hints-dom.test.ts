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
  options: { closeOnPick?: boolean; names?: readonly string[] } = {},
): void {
  const closeOnPick = options.closeOnPick ?? true;
  const names = options.names ?? ["Sol", "Luna"];
  trigger.addEventListener("click", () => {
    const menu = document.createElement("div");
    menu.id = "trigger-menu";
    menu.setAttribute("role", "menu");
    for (const name of names) {
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
    for (const [index, item] of [...menu.children].entries()) {
      giveRect(item, 10, 40 + index * 30);
    }
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

  test("plain i focuses the composer from idle and active hint modes", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><div id="editor" role="textbox"></div></div>' +
      '<button id="only">Only</button>';
    giveRect(document.getElementById("editor") as HTMLElement, 10, 10);
    giveRect(document.getElementById("only") as HTMLElement, 10, 10);
    let focusCalls = 0;
    (document.getElementById("editor") as HTMLElement).focus = () => {
      focusCalls += 1;
    };

    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      expect(pressKey("i", window, init)).toBe(true);
    }
    expect(focusCalls).toBe(0);

    expect(pressKey("i")).toBe(false);
    expect(focusCalls).toBe(1);

    pressKey("f");
    expect(markers()).toEqual(["i", "dd"]);
    expect(pressKey("i", window, { metaKey: true })).toBe(true);
    expect(focusCalls).toBe(1);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    pressKey("f");
    expect(markers()).toEqual(["i", "dd"]);
    expect(pressKey("i")).toBe(false);
    expect(focusCalls).toBe(2);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("releases passive composer focus but allows explicit keyboard and pointer focus", () => {
    document.body.innerHTML =
      '<button id="outside">Outside</button>' +
      '<div data-app-composer><div id="editor" role="textbox" tabindex="0"></div></div>';
    const outside = document.getElementById("outside") as HTMLElement;
    const editor = document.getElementById("editor") as HTMLElement;
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));
    expect(document.activeElement).not.toBe(editor);

    editor.focus();
    expect(document.activeElement).not.toBe(editor);

    expect(pressKey("i")).toBe(false);
    expect(document.activeElement).toBe(editor);

    editor.blur();
    editor.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
    editor.focus();
    expect(document.activeElement).toBe(editor);

    editor.blur();
    outside.focus();
    pressKey("Tab", outside);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    void dispose();
    controller.abort();
  });

  test("keeps the composer focusable on coarse-pointer devices", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query === "(pointer: coarse)", media: query }),
    });

    try {
      document.body.innerHTML =
        '<div data-app-composer><div id="editor" role="textbox" tabindex="0"></div></div>';
      const editor = document.getElementById("editor") as HTMLElement;
      editor.focus();

      const controller = newController();
      const dispose = mountLinkHints(contextWith(controller.signal));
      expect(document.activeElement).toBe(editor);

      editor.blur();
      editor.focus();
      expect(document.activeElement).toBe(editor);

      void dispose();
      controller.abort();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test("plain i stays available to editable targets while hint mode is idle", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><div id="composer" role="textbox"></div></div>' +
      '<input id="input"><textarea id="textarea"></textarea><select id="select"></select>' +
      '<div id="contenteditable" contenteditable="true"></div>' +
      '<div id="textbox" role="textbox"></div><button id="only">Only</button>';
    giveRect(document.getElementById("only") as HTMLElement, 10, 10);
    let focusCalls = 0;
    (document.getElementById("composer") as HTMLElement).focus = () => {
      focusCalls += 1;
    };

    for (const id of ["input", "textarea", "select", "contenteditable", "textbox"]) {
      expect(pressKey("i", document.getElementById(id) as HTMLElement)).toBe(true);
    }
    expect(focusCalls).toBe(0);

    void dispose();
    controller.abort();
  });

  test("plain i focuses the composer from an editable target while hint mode is active", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><div id="composer" role="textbox"></div></div>' +
      '<input id="input"><button id="only">Only</button>';
    giveRect(document.getElementById("composer") as HTMLElement, 10, 10);
    giveRect(document.getElementById("only") as HTMLElement, 10, 10);
    let focusCalls = 0;
    (document.getElementById("composer") as HTMLElement).focus = () => {
      focusCalls += 1;
    };

    const input = document.getElementById("input") as HTMLElement;
    let received = 0;
    input.addEventListener("keydown", () => {
      received += 1;
    });
    pressKey("F", input, { code: "KeyF", metaKey: true, shiftKey: true });
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();
    expect(pressKey("i", input)).toBe(false);
    expect(received).toBe(0);
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();
    expect(focusCalls).toBe(1);

    void dispose();
    controller.abort();
  });

  test("plain i is not swallowed when no composer textbox exists", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="only">Only</button>';
    giveRect(document.getElementById("only") as HTMLElement, 10, 10);

    expect(pressKey("i")).toBe(true);

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
      '<button id="back" aria-label="Go back">Back</button>' +
      '<button id="forward" aria-label="Go forward">Forward</button>' +
      '<button id="extensions" aria-roledescription="sortable">Extensions</button>' +
      '<a id="settings" href="/settings">Settings</a>' +
      '<button id="sidebar" aria-label="Toggle sidebar (⌘ B)">Sidebar</button>' +
      '<button id="right-panel" aria-label="Show right panel (⌘ J)">Panel</button>' +
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
      "back",
      "forward",
      "extensions",
      "settings",
      "sidebar",
      "right-panel",
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
    expect(markers()).toEqual([
      "m",
      "p",
      "i",
      "a",
      "k",
      "l",
      "b",
      "j",
      "n",
      "s",
      "[",
      "]",
      "e",
      ",",
      "q",
      "\\",
      "dd",
    ]);

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
    installMenuTrigger(project, picked, {
      names: ["bb", "New project", "docs", "Don’t work in a project"],
    });

    pressKey("f");
    expect(markers()).toEqual(["p", "i", "dd"]);

    pressKey("p");
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["f", "i", "j", "x"]);

    void dispose();
    controller.abort();
  });


  test("the provider dialog numbers tabs and gives search plus choices single keys", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><button id="model" aria-label="Provider, model and reasoning" aria-haspopup="dialog">Model</button></div>';
    const trigger = document.getElementById("model") as HTMLElement;
    giveRect(trigger, 10, 10);
    trigger.addEventListener("click", () => {
      const dialog = document.createElement("div");
      dialog.id = "model-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML =
        '<button id="codex">Codex</button><button id="claude">Claude</button>' +
        '<div class="overflow-y-auto"><input id="model-search" placeholder="Search models">' +
        '<button id="sol">Sol</button><button id="terra">Terra</button>' +
        '<button id="none">none</button><button id="high">high</button>' +
        '<button id="fast" role="switch">Fast mode</button></div>';
      document.body.appendChild(dialog);
      for (const [index, target] of [
        ...dialog.querySelectorAll<HTMLElement>("button,input"),
      ].entries()) {
        giveRect(target, 10, 40 + index * 30);
      }
      trigger.setAttribute("aria-controls", "model-dialog");
    });

    pressKey("f");
    pressKey("m");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["1", "2", "i", "f", "j", "d", "k", "qs"]);

    pressKey("i");
    expect((document.activeElement as HTMLElement).id).toBe("model-search");
    expect(document.querySelector(".vimium-hint-layer")).toBeNull();

    void dispose();
    controller.abort();
  });

  test("permission modes use the left home row", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<div data-app-composer><button id="permission" aria-label="Permission mode" aria-haspopup="menu">Ask</button></div>';
    const trigger = document.getElementById("permission") as HTMLElement;
    giveRect(trigger, 10, 10);
    installMenuTrigger(trigger, [], {
      names: ["Ask", "Plan", "Auto", "Read only", "Full", "Custom"],
    });

    pressKey("f");
    pressKey("k");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(markers()).toEqual(["a", "s", "d", "f", "g", "h"]);

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

  test("active agents hide locked composer controls until the run stops", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML =
      '<button id="scroll" aria-label="Scroll to latest event">Latest</button>' +
      '<div data-app-composer data-app-composer-role="primary">' +
      '<div id="editor" role="textbox"></div>' +
      '<button id="stop" aria-label="Stop run" data-promptbox-submit-action>Stop</button>' +
      '<div data-follow-up-composer-footer>' +
      '<div><button id="project" data-promptbox-project-control>Monorepo</button>' +
      '<button id="machine" aria-label="Environment">Dev Mac</button></div>' +
      '<div><button id="permission" aria-label="Permission mode">Ask</button></div>' +
      "</div></div>";
    for (const [index, id] of [
      "scroll",
      "editor",
      "stop",
      "project",
      "machine",
      "permission",
    ].entries()) {
      giveRect(document.getElementById(id) as HTMLElement, 10, 10 + index * 30);
    }

    pressKey("f");
    expect(markers()).toEqual(["i", "j", "k"]);

    pressKey("Escape");
    document.getElementById("stop")?.setAttribute("aria-label", "Submit");
    pressKey("f");
    expect(markers()).toHaveLength(6);
    expect(markers()).toEqual(expect.arrayContaining(["i", "j", "p", "l", "k"]));

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

  test("thread rows count 1-0 and zero picks the tenth row", () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = `${Array.from(
      { length: 11 },
      (_, index) =>
        `<a id="t${index + 1}" data-sidebar-thread-shortcut-target href="#">${index + 1}</a>`,
    ).join("")}<button id="other">Other</button>`;
    for (const [index, id] of [
      ...Array.from({ length: 11 }, (_, row) => `t${row + 1}`),
      "other",
    ].entries()) {
      giveRect(document.getElementById(id) as HTMLElement, 10, 10 + index * 30);
    }
    const clicked: string[] = [];
    document.getElementById("t10")?.addEventListener("click", (event) => {
      event.preventDefault();
      clicked.push("t10");
    });

    pressKey("f");
    const labels = markers();
    expect(labels.slice(0, 10)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    expect(labels[10]?.length).toBe(2);

    pressKey("0");
    expect(clicked).toEqual(["t10"]);
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
    expect(markers()).toEqual(["dd", "df", "dw"]);

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
