// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishHiddenProjectIds, resetHiddenProjects } from "./hidden-projects";
import { mountProjectPickerHide } from "./project-picker-hide";

// Markup as bb 0.50.1 renders ProjectSelector (see project-picker-hide.ts), trimmed to the
// attributes the script reads.
const CAPTAINS = "proj_captains";
const row = (id: string) =>
  `<div cmdk-item="" role="option" aria-disabled="false" aria-selected="false" data-value="${id}">${id}</div>`;
const list = (ids: string[]) =>
  `<div cmdk-root=""><div cmdk-list=""><div cmdk-group-items="">${ids.map(row).join("")}</div></div></div>`;

/** A project button: the new-thread footer's, or another ProjectSelector's (Archived threads). */
function trigger(where: "new-thread" | "archived"): HTMLButtonElement {
  const host = document.createElement("div");
  if (where === "new-thread") host.setAttribute("data-new-thread-footer", "");
  host.innerHTML = `<button data-promptbox-project-control="" aria-expanded="false">Project</button>`;
  document.body.append(host);
  return host.querySelector("button")!;
}

/** Opens a desktop popover for `button`, as Radix does: wrapper on <body>, aria-controls. */
function openPopover(button: HTMLButtonElement, id: string, ids: string[]): HTMLElement {
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-controls", id);
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-radix-popper-content-wrapper", "");
  wrapper.innerHTML = `<div role="dialog" id="${id}" aria-label="Project">${list(ids)}</div>`;
  document.body.append(wrapper);
  return wrapper;
}

/** BB's phone drawer: joins <body> empty while the button is open; the list renders after. */
function openDrawer(button: HTMLButtonElement): HTMLElement {
  button.setAttribute("aria-expanded", "true");
  const drawer = document.createElement("div");
  drawer.setAttribute("data-persistent-drawer-content", "");
  drawer.setAttribute("data-state", "open");
  drawer.setAttribute("role", "dialog");
  document.body.append(drawer);
  return drawer;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const styleEl = () =>
  document.head.querySelector<HTMLStyleElement>("style[data-t3-captain-projects-style]");
/** Whether the injected stylesheet hides `el`, by matching its rules' selectors. */
function hiddenByStyle(el: Element): boolean {
  const rules = [...(styleEl()?.sheet?.cssRules ?? [])] as CSSStyleRule[];
  return rules.some((rule) => el.matches(rule.selectorText));
}
const rowIn = (root: Element, id: string) => root.querySelector(`[cmdk-item][data-value="${id}"]`)!;

beforeEach(() => {
  localStorage.clear();
  resetHiddenProjects();
});
afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("mountProjectPickerHide", () => {
  it("hides and disables the hidden row in the new-thread popover, and only that row", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    const popover = openPopover(trigger("new-thread"), "radix-1", ["proj_a", CAPTAINS]);
    await flush();
    expect(hiddenByStyle(rowIn(popover, CAPTAINS))).toBe(true);
    expect(rowIn(popover, CAPTAINS).getAttribute("aria-disabled")).toBe("true");
    expect(hiddenByStyle(rowIn(popover, "proj_a"))).toBe(false);
    expect(rowIn(popover, "proj_a").getAttribute("aria-disabled")).toBe("false");
    dispose();
    expect(styleEl()).toBeNull();
    expect(rowIn(popover, CAPTAINS).getAttribute("aria-disabled")).toBe("false");
    expect(popover.hasAttribute("data-t3-new-thread-projects")).toBe(false);
  });

  it("leaves another ProjectSelector, such as Archived threads, listing Captains", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    trigger("new-thread");
    const archived = openPopover(trigger("archived"), "radix-2", ["proj_a", CAPTAINS]);
    await flush();
    expect(hiddenByStyle(rowIn(archived, CAPTAINS))).toBe(false);
    expect(rowIn(archived, CAPTAINS).getAttribute("aria-disabled")).toBe("false");
    dispose();
  });

  it("follows the phone drawer from its empty first open through later opens", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    const button = trigger("new-thread");
    const drawer = openDrawer(button);
    await flush();
    drawer.innerHTML = `<div aria-label="Project">${list(["proj_a", CAPTAINS])}</div>`;
    await flush();
    expect(hiddenByStyle(rowIn(drawer, CAPTAINS))).toBe(true);
    expect(rowIn(drawer, CAPTAINS).getAttribute("aria-disabled")).toBe("true");
    expect(hiddenByStyle(rowIn(drawer, "proj_a"))).toBe(false);
    dispose();
  });

  it("matches a drawer mounted before the script when it next opens from the new-thread button", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const button = trigger("new-thread");
    const drawer = document.createElement("div");
    drawer.setAttribute("data-persistent-drawer-content", "");
    drawer.setAttribute("data-state", "closed");
    drawer.innerHTML = `<div aria-label="Project">${list([CAPTAINS])}</div>`;
    document.body.append(drawer);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    expect(hiddenByStyle(rowIn(drawer, CAPTAINS))).toBe(false);
    button.setAttribute("aria-expanded", "true");
    drawer.setAttribute("data-state", "open");
    await flush();
    expect(hiddenByStyle(rowIn(drawer, CAPTAINS))).toBe(true);
    expect(rowIn(drawer, CAPTAINS).getAttribute("aria-disabled")).toBe("true");
    dispose();
  });

  it("does not claim a drawer another ProjectSelector opens", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    trigger("new-thread");
    const drawer = openDrawer(trigger("archived"));
    drawer.innerHTML = `<div aria-label="Project">${list([CAPTAINS])}</div>`;
    await flush();
    expect(hiddenByStyle(rowIn(drawer, CAPTAINS))).toBe(false);
    dispose();
  });

  it("moves a highlight stranded on a re-mounted hidden row to the first enabled row", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    const popover = openPopover(trigger("new-thread"), "radix-1", ["proj_a"]);
    await flush();
    const root = popover.querySelector("[cmdk-root]")!;
    const keys: string[] = [];
    root.addEventListener("keydown", (event) => keys.push((event as KeyboardEvent).key));
    // cmdk highlights the row it mounts for "Cap" before the observer runs.
    popover
      .querySelector("[cmdk-group-items]")!
      .insertAdjacentHTML(
        "afterbegin",
        row(CAPTAINS).replace('aria-selected="false"', 'aria-selected="true"'),
      );
    await flush();
    expect(keys).toEqual(["Home"]);
    dispose();
  });

  it("stops Enter on a hidden highlighted row and lets it through otherwise", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    const popover = openPopover(trigger("new-thread"), "radix-1", [CAPTAINS, "proj_a"]);
    await flush();
    const root = popover.querySelector("[cmdk-root]")!;
    const enter = () =>
      root.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    rowIn(popover, CAPTAINS).setAttribute("aria-selected", "true");
    expect(enter()).toBe(false);
    rowIn(popover, CAPTAINS).setAttribute("aria-selected", "false");
    rowIn(popover, "proj_a").setAttribute("aria-selected", "true");
    expect(enter()).toBe(true);
    dispose();
  });

  it("re-enables a row once its project is no longer hidden", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    const dispose = mountProjectPickerHide(document, new AbortController().signal);
    const popover = openPopover(trigger("new-thread"), "radix-1", [CAPTAINS]);
    await flush();
    publishHiddenProjectIds([]);
    expect(hiddenByStyle(rowIn(popover, CAPTAINS))).toBe(false);
    expect(rowIn(popover, CAPTAINS).getAttribute("aria-disabled")).toBe("false");
    dispose();
  });

  it("stops on abort and adds nothing once aborted", () => {
    const controller = new AbortController();
    mountProjectPickerHide(document, controller.signal);
    controller.abort();
    expect(styleEl()).toBeNull();
    mountProjectPickerHide(document, controller.signal)();
    expect(styleEl()).toBeNull();
  });
});
