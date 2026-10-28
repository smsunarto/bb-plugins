import { describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { findChrome } from "../lib/browser.ts";
import { preview } from "./preview.ts";

const chrome = await findChrome(process.env.BB_HTML_TEST_CHROME ?? "");

const invocation = { threadId: "thr_1", projectId: "proj_1", signal: new AbortController().signal };

function tool() {
  return preview({
    settings: { get: async () => ({ chromePath: chrome ?? "", chromeNoSandbox: false }) },
    withBrowser: <T>(task: () => Promise<T>) => task(),
    threadFiles: () => async () => undefined,
  } as never);
}

describe.skipIf(chrome === undefined)("html_preview with headless Chrome", () => {
  test("measures a document, captures a PNG, and reports console output", async () => {
    const result = (await tool().execute(
      {
        html: '<!doctype html><html><body><div style="height:300px">Chart</div><script>console.warn("drawn")</script></body></html>',
        width: 500,
      },
      invocation,
    )) as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0]!.text!);
    expect(summary).toMatchObject({ width: 500, contentHeight: 300, capturedHeight: 300 });
    expect(summary.consoleMessages).toEqual([{ level: "warning", text: "drawn" }]);
    const png = Buffer.from(result.content[1]!.data!, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  }, 30_000);

  test("previews a fragment inside the visualization runtime the thread gives it", async () => {
    const result = (await tool().execute(
      {
        html: '<div style="height:300px">Chart</div><script>console.warn(typeof bb.setWidgetState)</script>',
        width: 500,
      },
      invocation,
    )) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0]!.text!);
    // The runtime's body padding is 12px above and below.
    expect(summary).toMatchObject({ contentHeight: 324 });
    expect(summary.consoleMessages).toEqual([{ level: "warning", text: "function" }]);
  }, 30_000);

  // Chrome's Local Network Access also blocks loopback; public-proxy.test.ts checks the proxy alone.
  test("keeps the page off the bb server's own network", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("secret");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await tool().execute(
        {
          html: `<img src="http://127.0.0.1:${port}/a.png"><img src="http://localhost:${port}/b.png"><iframe src="http://127.0.0.1:${port}/"></iframe><script>fetch("http://127.0.0.1:${port}/c").catch(()=>{})</script>`,
        },
        invocation,
      );
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  }, 30_000);
});
