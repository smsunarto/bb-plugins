import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { mountArchiveToast } from "../app/archive-toast.ts";

installDom();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => document.body.replaceChildren());

function toast(title = "Thread archived", action = "Undo") {
  const element = document.createElement("li");
  element.setAttribute("data-sonner-toast", "");
  element.innerHTML = `<div data-testid="app-toast-title"></div><div><div data-testid="app-toast-description">Thread title</div></div><button></button>`;
  element.querySelector('[data-testid="app-toast-title"]')!.textContent = title;
  element.querySelector("button")!.textContent = action;
  return element;
}

test("archive pills survive late mount and rerender, restore on disposal, and preserve other notifications", async () => {
  const initial = toast();
  const error = toast("Thread archived", "Unarchive");
  document.body.append(initial, error);
  const controller = new AbortController();
  mountArchiveToast({ signal: controller.signal });
  expect(initial.hasAttribute("data-monokai-archive-toast")).toBe(true);
  expect(error.hasAttribute("data-monokai-archive-toast")).toBe(false);
  const late = toast("Threads archived");
  document.body.append(late);
  await flush();
  expect(late.hasAttribute("data-monokai-archive-toast")).toBe(true);
  initial.replaceChildren(...toast().childNodes);
  await flush();
  expect(initial.querySelector("[data-monokai-archive-description]")).not.toBeNull();
  initial.querySelector('[data-testid="app-toast-title"]')!.textContent = "Unable to archive";
  await flush();
  expect(initial.hasAttribute("data-monokai-archive-toast")).toBe(false);
  controller.abort();
  expect(document.querySelector("[data-monokai-archive-toast]")).toBeNull();
  expect(document.querySelector("[data-monokai-archive-description]")).toBeNull();
  document.body.append(toast());
  await flush();
  expect(document.querySelector("[data-monokai-archive-toast]")).toBeNull();
});
