import { describe, expect, test } from "vitest";
import {
  HtmlRenderPageError,
  imageTooLargeError,
  preparePage,
  rejectViewportHeight,
} from "./prepare.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("rejectViewportHeight", () => {
  test("rejects vh in stylesheets and style attributes", () => {
    expect(() => rejectViewportHeight("<style>main{height:100vh}</style>")).toThrow(
      HtmlRenderPageError,
    );
    expect(() => rejectViewportHeight('<div style="min-height: 50dvh"></div>')).toThrow(/50dvh/);
  });

  test("allows vh outside CSS and inside base64", () => {
    expect(() => rejectViewportHeight("<p>100vh is banned</p><!-- 100vh -->")).not.toThrow();
    expect(() =>
      rejectViewportHeight("<style>a{background:url(data:image/png;base64,ab+1vh)}</style>"),
    ).not.toThrow();
  });
});

describe("preparePage", () => {
  test("inlines local images read from the thread's machine", async () => {
    const reads: string[] = [];
    const { html, missing } = await preparePage('<img src="/Users/me/chart.png">', async (path) => {
      reads.push(path);
      return PNG;
    });
    expect(reads).toEqual(["/Users/me/chart.png"]);
    expect(missing).toEqual([]);
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from(PNG).toString("base64")}"`);
  });

  test("reports files that are missing or are not images", async () => {
    const { html, missing } = await preparePage(
      '<img src="/missing.png"><img src="/home/me/.ssh/id_rsa.png">',
      async (path) =>
        path === "/missing.png" ? undefined : new TextEncoder().encode("-----BEGIN KEY"),
    );
    expect(missing).toEqual(["/missing.png", "/home/me/.ssh/id_rsa.png"]);
    expect(html).toContain('src="/home/me/.ssh/id_rsa.png"');
  });

  test("rejects an image over 10 MiB", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    await expect(preparePage('<img src="/big.png">', async () => big)).rejects.toThrow(
      /at most 10.0 MiB/,
    );
  });

  test("bounds the page by every reference to an image, not each image once", async () => {
    const image = new Uint8Array(4 * 1024 * 1024);
    image.set(PNG);
    const html = '<img src="/a.png">'.repeat(8);
    await expect(preparePage(html, async () => image)).rejects.toThrow(/the limit is 25.0 MiB/);
  });

  test("passes on a size error the host reports", async () => {
    await expect(
      preparePage('<img src="/huge.png">', async (path) => {
        throw imageTooLargeError(path, 12 * 1024 * 1024);
      }),
    ).rejects.toThrow("/huge.png is 12.0 MiB");
  });
});
