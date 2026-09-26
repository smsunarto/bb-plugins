import { describe, expect, mock, test } from "bun:test";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import { loadPreview, MAX_PREVIEW_BYTES, parsePreviewFile } from "./load-preview.ts";

function sdk(read?: () => unknown) {
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
  const client = {
    threads: { storageLocation },
    files: { read: readFile, createPreview },
  } as unknown as ReturnType<typeof useSdk>;
  return { client, storageLocation, readFile, createPreview };
}

describe("absolute preview paths", () => {
  test.each([
    ["/tmp/demo.html", "/tmp", "demo.html"],
    ["/outside/notes.MARKDOWN", "/outside", "notes.MARKDOWN"],
    ["/demo.html", "/", "demo.html"],
    ["C:\\reports\\demo.html", "C:\\reports", "demo.html"],
    ["C:\\demo.html", "C:\\", "demo.html"],
    ["\\\\host\\share\\demo.html", "\\\\host\\share\\", "demo.html"],
  ])("accepts %s", (file, directory, name) => {
    expect(parsePreviewFile(file)).toEqual({
      file,
      directory,
      name,
      kind: name.endsWith(".html") ? "html" : "markdown",
    });
  });
  test.each([
    ["/tmp//a/./b/../demo.html", "/tmp/a/demo.html", "/tmp/a"],
    ["C:/reports\\..\\demo.html", "C:\\demo.html", "C:\\"],
    ["/../demo.html", "/demo.html", "/"],
  ])("normalizes %s", (input, file, directory) => {
    expect(parsePreviewFile(input)).toMatchObject({ file, directory });
  });
  test.each([
    "demo.html",
    "../demo.html",
    "~/demo.html",
    "C:demo.html",
    "https://host/demo.html",
    "/tmp/a\0.html",
  ])("rejects %s", (file) => {
    expect(() => parsePreviewFile(file)).toThrow(/absolute/);
  });
  test("rejects unsupported extensions and directories", () => {
    expect(() => parsePreviewFile("/tmp/a.txt")).toThrow(/must end with/);
    expect(() => parsePreviewFile("/tmp/")).toThrow(/must end with/);
    expect(() => parsePreviewFile("/")).toThrow(/name a file/);
  });
});

test("reads an absolute file outside the thread storage and leases its directory on the same host", async () => {
  const { client, storageLocation, readFile, createPreview } = sdk();
  expect(await loadPreview(client, "thread-1", "/outside/report #1.html")).toEqual({
    kind: "html",
    file: "/outside/report #1.html",
    hostId: "host-1",
    url: "/api/v1/file-previews/lease/report%20%231.html",
    expiresAtMs: 12345,
    html: "<h1>OK</h1>",
  });
  expect(storageLocation).toHaveBeenCalledWith({ threadId: "thread-1", signal: undefined });
  expect(readFile).toHaveBeenCalledWith({
    path: "/outside/report #1.html",
    rootPath: "/outside",
    hostId: "host-1",
    signal: undefined,
  });
  expect(createPreview).toHaveBeenCalledWith({
    rootPath: "/outside",
    hostId: "host-1",
    ttlMs: 3_600_000,
    signal: undefined,
  });
});

test("returns Markdown with the same absolute-file transport", async () => {
  const { client } = sdk(() => ({ content: "# Notes", contentEncoding: "utf8", sizeBytes: 7 }));
  expect(await loadPreview(client, "thread-1", "/outside/notes.md")).toEqual({
    kind: "markdown",
    file: "/outside/notes.md",
    hostId: "host-1",
    url: "/api/v1/file-previews/lease/notes.md",
    expiresAtMs: 12345,
    content: "# Notes",
  });
});

test("rejects relative files before resolving a host or reading", async () => {
  const { client, storageLocation, readFile } = sdk();
  await expect(loadPreview(client, "thread-1", "demo.html")).rejects.toThrow(/absolute/);
  expect(storageLocation).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});

test("maps missing files and rejects binary or oversized content before creating a lease", async () => {
  for (const [read, error] of [
    [
      () => {
        throw Object.assign(new Error("missing"), { status: 404 });
      },
      /Preview file not found: \/outside\/demo\.html/,
    ],
    [() => ({ content: "AA==", contentEncoding: "base64", sizeBytes: 1 }), /UTF-8/],
    [
      () => ({ content: "", contentEncoding: "utf8", sizeBytes: MAX_PREVIEW_BYTES + 1 }),
      /too large/,
    ],
  ] as const) {
    const { client, createPreview } = sdk(read);
    await expect(loadPreview(client, "thread-1", "/outside/demo.html")).rejects.toThrow(error);
    expect(createPreview).not.toHaveBeenCalled();
  }
});
