// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { composerHost, markComposerHost } from "./composer-host";

afterEach(() => {
  document.body.innerHTML = "";
});

function composer(wrapper: string) {
  document.body.innerHTML = `<div ${wrapper}><div data-composer-box><form data-t3-composer></form></div></div>`;
  return document.querySelector("form")!;
}

it("marks BB's follow-up and new-thread wrappers while mounted, and clears the mark after", () => {
  for (const wrapper of ["data-follow-up-composer", "data-app-composer"]) {
    const form = composer(wrapper);
    const host = document.querySelector(`[${wrapper}]`)!;
    const unmark = markComposerHost(form, "data-t3-composer-host");
    expect(host.hasAttribute("data-t3-composer-host")).toBe(true);
    unmark();
    expect(host.hasAttribute("data-t3-composer-host")).toBe(false);
  }
});

it("keeps the mark until the last of two holders clears it", () => {
  const form = composer("data-follow-up-composer");
  const host = composerHost(form)!;
  const first = markComposerHost(form, "data-t3-permission-host");
  const second = markComposerHost(form, "data-t3-permission-host");
  first();
  expect(host.hasAttribute("data-t3-permission-host")).toBe(true);
  second();
  expect(host.hasAttribute("data-t3-permission-host")).toBe(false);
});

it("marks nothing for a composer outside BB's wrappers or one level too deep", () => {
  document.body.innerHTML = `<section><div data-composer-box><form id="a"></form></div></section>
    <div data-follow-up-composer><div><div data-composer-box><form id="b"></form></div></div></div>`;
  for (const id of ["a", "b"]) {
    const form = document.getElementById(id)!;
    expect(composerHost(form)).toBeNull();
    markComposerHost(form, "data-t3-composer-host")();
  }
  expect(document.querySelector("[data-t3-composer-host]")).toBeNull();
});
