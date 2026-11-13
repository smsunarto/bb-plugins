// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { mountHeaderIcon } from "./header-icon.ts";

const ours = (label: string) => label === "#482 · Draft" || label === "Local, not pushed";
const settle = () => new Promise((done) => setTimeout(done, 0));
const icons = (root: ParentNode = document) => root.querySelectorAll("[data-sc-header-icon]");

function header(...labels: string[]): HTMLElement {
  const actions = document.createElement("div");
  actions.setAttribute("data-thread-header-workflow-actions", "");
  for (const label of labels) {
    const button = document.createElement("button");
    button.textContent = label;
    actions.append(button);
  }
  return actions;
}

afterEach(() => document.body.replaceChildren());

test("the icon goes on the Source Control button only, and keeps the label as its name", () => {
  document.body.append(header("View in GitButler", "#482 · Draft"));
  const abort = new AbortController();
  mountHeaderIcon(document, abort.signal, ours);
  const [other, mine] = document.querySelectorAll("button");
  expect(icons(other!)).toHaveLength(0);
  expect(icons(mine!)).toHaveLength(1);
  expect(mine!.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  expect(mine!.textContent).toBe("#482 · Draft");
  abort.abort();
});

test("a header that mounts later, and a button bb relabels, get one icon each", async () => {
  const abort = new AbortController();
  mountHeaderIcon(document, abort.signal, ours);
  const pane = document.createElement("section");
  pane.append(header("#482 · Draft"));
  document.body.append(pane);
  await settle();
  const button = document.querySelector("button")!;
  expect(icons(button)).toHaveLength(1);
  // React sets a relabelled button's text, which replaces its children.
  button.textContent = "Local, not pushed";
  await settle();
  expect(icons(button)).toHaveLength(1);
  expect(button.textContent).toBe("Local, not pushed");
  abort.abort();
});

test("stopping the script takes the icons out and stops adding them", async () => {
  document.body.append(header("#482 · Draft"));
  const abort = new AbortController();
  mountHeaderIcon(document, abort.signal, ours);
  expect(icons()).toHaveLength(1);
  abort.abort();
  expect(icons()).toHaveLength(0);
  document.body.append(header("Local, not pushed"));
  await settle();
  expect(icons()).toHaveLength(0);
});
