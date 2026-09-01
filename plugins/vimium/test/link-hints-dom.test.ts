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

function pressKey(key: string, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function markers(): string[] {
  return [...document.querySelectorAll(".vimium-hint-marker")].map(
    (marker) => marker.textContent ?? "",
  );
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

    // The textarea has a zero-size rect, so only the two stubbed targets hint.
    pressKey("f");
    expect(document.querySelector(".vimium-hint-layer")).not.toBeNull();
    expect(markers()).toEqual(["s", "a"]);

    pressKey("a");
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

  test("activating a dropdown trigger re-prompts scoped to its options", async () => {
    const controller = newController();
    const dispose = mountLinkHints(contextWith(controller.signal));

    document.body.innerHTML = '<button id="trigger" aria-haspopup="menu">Model</button>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    giveRect(trigger, 10, 10);
    const picked: string[] = [];
    trigger.addEventListener("click", () => {
      const menu = document.createElement("div");
      menu.id = "trigger-menu";
      menu.setAttribute("role", "menu");
      for (const name of ["Sol", "Luna"]) {
        const item = document.createElement("div");
        item.setAttribute("role", "menuitem");
        item.textContent = name;
        item.addEventListener("click", () => picked.push(name));
        menu.appendChild(item);
      }
      document.body.appendChild(menu);
      giveRect(menu.children[0] as Element, 10, 40);
      giveRect(menu.children[1] as Element, 10, 70);
      trigger.setAttribute("aria-controls", "trigger-menu");
    });

    pressKey("f");
    expect(markers()).toEqual(["s"]);
    pressKey("s");
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
