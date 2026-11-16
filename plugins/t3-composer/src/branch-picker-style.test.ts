// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BRANCH_PICKER_CSS, mountBranchPickerStyle } from "./branch-picker-style";

const styles = () => document.head.querySelectorAll("style[data-t3-branch-picker-style]");

describe("mountBranchPickerStyle", () => {
  it("adds one stylesheet and the disposer removes it", () => {
    const dispose = mountBranchPickerStyle(document, new AbortController().signal);
    expect(styles()).toHaveLength(1);
    dispose();
    expect(styles()).toHaveLength(0);
  });

  it("removes the stylesheet when the signal aborts", () => {
    const controller = new AbortController();
    const dispose = mountBranchPickerStyle(document, controller.signal);
    controller.abort();
    expect(styles()).toHaveLength(0);
    dispose();
    expect(styles()).toHaveLength(0);
  });

  it("adds nothing once aborted", () => {
    const controller = new AbortController();
    controller.abort();
    mountBranchPickerStyle(document, controller.signal)();
    expect(styles()).toHaveLength(0);
  });
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** BB's phone sheet: rows whose check is transparent unless chosen. */
function sheet(chosen: string) {
  const row = (value: string) =>
    `<button data-branch-picker-row data-value="${value}"><svg data-icon="Check" style="opacity: ${value === chosen ? 1 : 0}"></svg></button>`;
  const node = document.createElement("div");
  node.setAttribute("data-bb-plugin", "environment-project-checkout");
  node.setAttribute("data-bb-portaled-overlay", "");
  node.setAttribute("data-persistent-drawer-content", "");
  node.setAttribute("role", "dialog");
  node.innerHTML = `<div>${row("intent:current")}${row("intent:new")}</div>`;
  return node;
}
const chosen = () =>
  [...document.querySelectorAll("[data-t3-branch-chosen]")].map((row) =>
    row.getAttribute("data-value"),
  );

describe("the chosen branch row", () => {
  it("is tagged in an open picker, a late one, and after the choice changes, and untagged on dispose", async () => {
    const open = sheet("intent:current");
    document.body.append(open);
    const dispose = mountBranchPickerStyle(document, new AbortController().signal);
    await frame();
    expect(chosen()).toEqual(["intent:current"]);

    // A picker BB portals in later, inside its popper wrapper.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const late = sheet("intent:new");
    late.removeAttribute("data-persistent-drawer-content");
    wrapper.append(late);
    document.body.append(wrapper);
    await Promise.resolve();
    await frame();
    expect(chosen()).toEqual(["intent:current", "intent:new"]);

    // BB moves the check: the old row loses the tag, once.
    const [current, next] = open.querySelectorAll("svg");
    current!.setAttribute("style", "opacity: 0");
    next!.setAttribute("style", "opacity: 1");
    current!.setAttribute("class", "moved");
    await Promise.resolve();
    await frame();
    expect(chosen()).toEqual(["intent:new", "intent:new"]);
    expect(open.querySelectorAll("[data-t3-branch-chosen]")).toHaveLength(1);

    dispose();
    expect(chosen()).toEqual([]);
    open.remove();
    wrapper.remove();
  });

  it("selects bb's rows by attribute, never by a Tailwind class", () => {
    expect(BRANCH_PICKER_CSS).not.toMatch(/\.opacity-|\.size-|\.bg-/);
  });
});
