import { JSDOM } from "jsdom";
import { expect, test } from "vitest";
import { PREVIEW_FRAME_HTML } from "./preview-frame.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function framePage() {
  const { window } = new JSDOM('<!doctype html><iframe sandbox="allow-scripts"></iframe>', {
    runScripts: "dangerously",
  });
  const iframe = window.document.querySelector("iframe")!;
  const received: unknown[] = [];
  window.addEventListener("message", (event) => received.push(event.data));
  const frame = iframe.contentWindow as Window & typeof globalThis;
  frame.document.open();
  frame.document.write(PREVIEW_FRAME_HTML);
  frame.document.close();
  const send = (source: Window, data: unknown) =>
    frame.dispatchEvent(new frame.MessageEvent("message", { source, data }));
  return { parent: window as unknown as Window, frame, received, send };
}

test("the frame page asks its parent for a document and writes only the parent's", async () => {
  const { parent, frame, received, send } = framePage();
  await tick();
  expect(received).toEqual([{ type: "bb:html:frame-ready" }]);

  const html =
    "<!doctype html><p id=written>Prepared</p><script>parent.postMessage('ran', '*')</script>";
  send(frame, { type: "bb:html:document", html });
  send(parent, { type: "bb:html:other", html });
  send(parent, { type: "bb:html:document", html: 7 });
  expect(frame.document.getElementById("written")).toBeNull();

  send(parent, { type: "bb:html:document", html });
  expect(frame.document.getElementById("written")?.textContent).toBe("Prepared");
  await tick();
  expect(received).toEqual([{ type: "bb:html:frame-ready" }, "ran"]);
});
