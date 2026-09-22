import { describe, expect, mock, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_PREVIEW_BYTES, requireAbsolutePreviewFile } from "../lib/preview-file.ts";
import { preparePreview } from "./prepare-preview.ts";

function context(read?: () => unknown) {
  const storageLocation = mock(async () => ({
    hostId: "host-1",
    storageRootPath: "/unrelated/thread",
  }));
  const readFile = mock(
    async () => read?.() ?? { content: "<h1>OK</h1>", contentEncoding: "utf8", sizeBytes: 11 },
  );
  const createPreview = mock(async () => ({
    baseUrl: "/api/v1/file-previews/lease",
    expiresAtMs: 12345,
  }));
  const bb = {
    sdk: { threads: { storageLocation }, files: { read: readFile, createPreview } },
  } as unknown as BbPluginApi;
  return { ctx: stubHostContext({ bb }), storageLocation, readFile, createPreview };
}

describe("absolute preview paths", () => {
  test.each([
    "/tmp/demo.html",
    "/outside/notes.MARKDOWN",
    "C:\\reports\\demo.html",
    "\\\\host\\share\\demo.html",
  ])("accepts %s", (file) => {
    expect(requireAbsolutePreviewFile(file)).toBe(file);
  });
  test.each([
    "demo.html",
    "../demo.html",
    "~/demo.html",
    "C:demo.html",
    "https://host/demo.html",
    "/tmp/a\0.html",
  ])("rejects %s", (file) => {
    expect(() => requireAbsolutePreviewFile(file)).toThrow(/absolute/);
  });
  test("rejects unsupported extensions", () => {
    expect(() => requireAbsolutePreviewFile("/tmp/a.txt")).toThrow(/must end with/);
  });
});

test("reads an absolute file outside the thread storage and leases its directory on the same host", async () => {
  const { ctx, storageLocation, readFile, createPreview } = context();
  expect(
    await preparePreview.execute(ctx, { threadId: "thread-1", file: "/outside/report #1.html" }),
  ).toEqual({
    kind: "html",
    file: "/outside/report #1.html",
    hostId: "host-1",
    url: "/api/v1/file-previews/lease/report%20%231.html",
    expiresAtMs: 12345,
    html: "<h1>OK</h1>",
  });
  expect(storageLocation).toHaveBeenCalledWith({ threadId: "thread-1" });
  expect(readFile).toHaveBeenCalledWith({
    path: "/outside/report #1.html",
    rootPath: "/outside",
    hostId: "host-1",
  });
  expect(createPreview).toHaveBeenCalledWith({
    rootPath: "/outside",
    hostId: "host-1",
    ttlMs: 3_600_000,
  });
});

test("returns Markdown with the same absolute-file transport", async () => {
  const { ctx } = context(() => ({ content: "# Notes", contentEncoding: "utf8", sizeBytes: 7 }));
  expect(
    await preparePreview.execute(ctx, { threadId: "thread-1", file: "/outside/notes.md" }),
  ).toEqual({
    kind: "markdown",
    file: "/outside/notes.md",
    hostId: "host-1",
    url: "/api/v1/file-previews/lease/notes.md",
    expiresAtMs: 12345,
    content: "# Notes",
  });
});

test("rejects the removed source attribute", () => {
  expect(() =>
    preparePreview.input.parse({
      threadId: "thread-1",
      file: "/tmp/demo.html",
      source: "workspace",
    }),
  ).toThrow();
});

test("rejects relative files before resolving a host or reading", async () => {
  const { ctx, storageLocation, readFile } = context();
  await expect(
    preparePreview.execute(ctx, { threadId: "thread-1", file: "demo.html" }),
  ).rejects.toThrow(/absolute/);
  expect(storageLocation).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});

test("maps missing files and rejects binary or oversized content before creating a lease", async () => {
  for (const [read, error] of [
    [
      () => {
        throw Object.assign(new Error("missing"), { status: 404 });
      },
      /Preview file not found/,
    ],
    [() => ({ content: "AA==", contentEncoding: "base64", sizeBytes: 1 }), /UTF-8/],
    [
      () => ({ content: "", contentEncoding: "utf8", sizeBytes: MAX_PREVIEW_BYTES + 1 }),
      /too large/,
    ],
  ] as const) {
    const { ctx, createPreview } = context(read);
    await expect(
      preparePreview.execute(ctx, { threadId: "thread-1", file: "/outside/demo.html" }),
    ).rejects.toThrow(error);
    expect(createPreview).not.toHaveBeenCalled();
  }
});
