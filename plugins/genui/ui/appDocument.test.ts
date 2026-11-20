// The app frame's own runtime, run as the frame runs it: the srcdoc's script in a document of its
// own, posting to a stand-in host. Checks what a link click inside an app sends BB.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildSrcdoc } from "./appDocument";

const PR = "https://github.com/acme/api/pull/12";

/** An app with one link, its runtime started; the messages it posts to BB are collected. */
function app() {
  const posted: Record<string, unknown>[] = [];
  const html = `<a id="pr" href="${PR}">PR</a>`;
  const dom = new JSDOM(buildSrcdoc(html, { theme: {}, motionOff: false, storage: {} }), {
    runScripts: "dangerously",
    beforeParse(window) {
      // The frame posts to its parent (BB), and opens links only inside the reader's click.
      Object.defineProperty(window, "parent", {
        value: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
      });
      Object.defineProperty(window.navigator, "userActivation", { value: { isActive: true } });
      window.matchMedia = () =>
        ({ matches: false, addEventListener() {}, removeEventListener() {} }) as never;
      // jsdom has no ResizeObserver; the runtime reports the app's height through one.
      Object.assign(window, {
        ResizeObserver: class {
          observe() {}
          disconnect() {}
        },
      });
    },
  });
  const click = (init: MouseEventInit = {}) =>
    dom.window.document
      .getElementById("pr")!
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
      );
  const links = () => posted.filter((message) => message.type === "openLink");
  return { click, links };
}

describe("an app's link click", () => {
  it("posts a plain click without a plain flag, which BB reads as plain", () => {
    const frame = app();
    frame.click();
    expect(frame.links()).toEqual([{ type: "openLink", url: PR, source: "genui-app" }]);
  });

  it("posts a modified click with plain: false", () => {
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      const frame = app();
      frame.click({ [modifier]: true });
      expect(frame.links(), modifier).toEqual([
        { type: "openLink", url: PR, plain: false, source: "genui-app" },
      ]);
    }
  });
});
