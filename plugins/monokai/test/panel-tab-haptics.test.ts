import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { mountPanelTabHaptics, nativeSelectionHaptic } from "../app/panel-tab-haptics.ts";

installDom();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let controller: AbortController;
let ticks: number;
let first: HTMLButtonElement;
let second: HTMLButtonElement;

const tab = (pager: Element, pressed: boolean) => {
  const pill = document.createElement("div");
  pill.setAttribute("data-tab-pill", "");
  const button = document.createElement("button");
  button.setAttribute("aria-pressed", String(pressed));
  pill.append(button);
  pager.append(pill);
  return button;
};

beforeEach(() => {
  const pager = document.createElement("div");
  pager.setAttribute("data-testid", "mobile-panel-tab-pager");
  document.body.append(pager);
  first = tab(pager, true);
  second = tab(pager, false);
  ticks = 0;
  controller = new AbortController();
  mountPanelTabHaptics({ signal: controller.signal, haptic: () => ticks++ });
});

afterEach(() => {
  controller.abort();
  document.body.replaceChildren();
});

test("ticks once when the active tab moves", async () => {
  first.setAttribute("aria-pressed", "false");
  second.setAttribute("aria-pressed", "true");
  await flush();
  expect(ticks).toBe(1);
});

test("ignores a re-render that keeps the selection and pressed buttons outside the tab strip", async () => {
  first.setAttribute("aria-pressed", "true");
  const other = document.createElement("button");
  other.setAttribute("aria-pressed", "false");
  document.body.append(other);
  await flush();
  other.setAttribute("aria-pressed", "true");
  await flush();
  expect(ticks).toBe(0);
});

test("stops once disposed", async () => {
  controller.abort();
  second.setAttribute("aria-pressed", "true");
  await flush();
  expect(ticks).toBe(0);
});

test("posts a selection haptic only through a bridge that offers haptics", () => {
  const posted: unknown[] = [];
  const view = {
    bb: { native: { post: (m: unknown) => posted.push(m), capabilities: ["haptic"] } },
  };
  nativeSelectionHaptic(view as unknown as Window);
  nativeSelectionHaptic({
    bb: { native: { post: () => posted.push("x"), capabilities: [] } },
  } as unknown as Window);
  nativeSelectionHaptic({} as Window);
  expect(posted).toEqual([{ type: "haptic", kind: "selection" }]);
});
