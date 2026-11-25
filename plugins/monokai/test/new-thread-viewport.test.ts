import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { HOME_ATTRIBUTE } from "../app/home-marker.ts";
import { mountNewThreadLayout } from "../app/new-thread-layout.ts";

installDom();

const marker = "data-monokai-compose-viewport";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const media = Object.assign(new window.EventTarget(), { matches: true });
const originalMatchMedia = window.matchMedia;
let controller: AbortController;

beforeEach(() => {
  controller = new AbortController();
  media.matches = true;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value(query: string) {
      expect(query).toBe("(width > 767px)");
      return media;
    },
  });
});

afterEach(() => {
  controller.abort();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  document.documentElement.removeAttribute(HOME_ATTRIBUTE);
  document.getElementById("bb-app-theme")?.remove();
  document.body.replaceChildren();
});

function setDesktop(matches: boolean) {
  media.matches = matches;
  media.dispatchEvent(new window.Event("change"));
}

function viewport() {
  const node = document.createElement("div");
  node.innerHTML = '<div data-testid="root-compose-compact-home"></div>';
  document.body.append(node);
  return node;
}

test("marks only mounted home wrappers and releases them on replacement or disposal", async () => {
  const first = viewport();
  mountNewThreadLayout({ signal: controller.signal });
  expect(first.hasAttribute(marker)).toBe(true);

  const late = viewport();
  first.replaceChildren();
  await flush();
  expect(first.hasAttribute(marker)).toBe(false);
  expect(late.hasAttribute(marker)).toBe(true);

  const replacement = viewport();
  const home = replacement.firstElementChild;
  if (!home) throw new Error("Missing home");
  late.replaceChildren(home);
  await flush();
  expect(late.hasAttribute(marker)).toBe(true);
  expect(replacement.hasAttribute(marker)).toBe(false);

  controller.abort();
  expect(late.hasAttribute(marker)).toBe(false);
  const after = viewport();
  await flush();
  expect(after.hasAttribute(marker)).toBe(false);
});

test("only searches for desktop wrappers while the desktop media query matches", async () => {
  media.matches = false;
  mountNewThreadLayout({ signal: controller.signal });
  const unrelated = document.createElement("div");
  unrelated.append(document.createElement("p"));
  const search = mock(() => document.querySelectorAll("never-matches"));
  Object.defineProperty(unrelated, "querySelectorAll", { value: search });
  document.body.append(unrelated);
  const home = viewport();
  await flush();
  expect(search).not.toHaveBeenCalled();
  expect(home.hasAttribute(marker)).toBe(false);

  setDesktop(true);
  expect(home.hasAttribute(marker)).toBe(true);
  setDesktop(false);
  expect(home.hasAttribute(marker)).toBe(false);
  document.body.append(unrelated);
  await flush();
  expect(search).not.toHaveBeenCalled();
  setDesktop(true);
  expect(home.hasAttribute(marker)).toBe(true);
});

test("orders the compact selector tray, editor and Recent within their existing parents", async () => {
  media.matches = false;
  mountNewThreadLayout({ signal: controller.signal });
  const theme = document.createElement("style");
  theme.id = "bb-app-theme";
  theme.textContent = ".dark { --bb-monokai-active: 1; }";
  document.head.append(theme);
  document.body.innerHTML = `
    <aside id="root-compose-main-panel">
      <div data-testid="root-compose-compact-home">
        <div data-testid="root-compose-compact-scroll-viewport">
          <a href="/threads/first">Recent</a>
        </div>
        <div data-testid="root-compose-compact-composer">
          <section data-app-composer data-t3-composer-host>
            <div data-composer-box><div contenteditable tabindex="0">Editor</div></div>
            <div data-new-thread-footer><button>Project</button></div>
          </section>
        </div>
      </div>
    </aside>`;
  const order = () =>
    [...document.querySelectorAll("a, button, [contenteditable]")].map((node) => node.textContent);
  expect(order()).toEqual(["Recent", "Editor", "Project"]);
  document.documentElement.setAttribute(HOME_ATTRIBUTE, "");
  await flush();
  expect(order()).toEqual(["Project", "Editor", "Recent"]);
  const edit = document.querySelector("[contenteditable]");
  document.querySelector("[data-app-composer]")?.append(document.createElement("div"));
  await flush();
  expect(document.querySelector("[contenteditable]")).toBe(edit);
  expect(order()).toEqual(["Project", "Editor", "Recent"]);

  theme.textContent = "";
  await flush();
  expect(order()).toEqual(["Recent", "Editor", "Project"]);
  theme.textContent = ".dark { --bb-monokai-active: 1; }";
  await flush();
  expect(order()).toEqual(["Project", "Editor", "Recent"]);
  setDesktop(true);
  expect(order()).toEqual(["Recent", "Editor", "Project"]);
  setDesktop(false);
  expect(order()).toEqual(["Project", "Editor", "Recent"]);
  controller.abort();
  expect(order()).toEqual(["Recent", "Editor", "Project"]);
});
