import { describe, expect, mock, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolve } from "node:path";

import {
  MAX_PREVIEW_BYTES,
  requireRelativePreviewFile,
  resolveContainedPreviewPath,
} from "../lib/preview-file.ts";
import { preparePreview } from "./prepare-preview.ts";

const ROOT = "/workspace/project";
const STORAGE_ROOT = "/thread-storage/thread-1";
const HOST_ID = "host-1";

function context(
  options: {
    environment?: { path?: string | null; hostId?: string } | null;
    read?: (input: unknown) => unknown;
  } = {},
) {
  const environment =
    options.environment === undefined
      ? { id: "env-1", path: ROOT, hostId: HOST_ID }
      : options.environment;
  const getThread = mock(async () => ({ id: "thread-1", environment }));
  const storageLocation = mock(async () => ({ hostId: HOST_ID, storageRootPath: STORAGE_ROOT }));
  const readFile = mock(
    async (input: unknown) =>
      options.read?.(input) ?? {
        content: "<html><body>ok</body></html>",
        contentEncoding: "utf8",
        sizeBytes: 32,
      },
  );
  const bb = {
    sdk: { threads: { get: getThread, storageLocation }, files: { read: readFile } },
  } as unknown as BbPluginApi;
  return { ctx: stubHostContext({ bb }), getThread, storageLocation, readFile };
}

describe("requireRelativePreviewFile", () => {
  test("accepts nested HTML and Markdown paths", () => {
    expect(requireRelativePreviewFile("demo.html")).toBe("demo.html");
    expect(requireRelativePreviewFile("charts/out.HTML")).toBe("charts/out.HTML");
    expect(requireRelativePreviewFile("notes.md")).toBe("notes.md");
    expect(requireRelativePreviewFile("docs/summary.MARKDOWN")).toBe("docs/summary.MARKDOWN");
  });

  test("rejects absolute, traversing, and unsupported paths", () => {
    expect(() => requireRelativePreviewFile("/etc/passwd.html")).toThrow(/source-relative/);
    expect(() => requireRelativePreviewFile("../secret.html")).toThrow(/traversal|escape/);
    expect(() => requireRelativePreviewFile("..\\secret.html")).toThrow(/traversal|escape/);
    expect(() => requireRelativePreviewFile("charts/../secret.html")).toThrow(/traversal/);
    expect(() => requireRelativePreviewFile("demo.txt")).toThrow(/\.html/);
    expect(() => requireRelativePreviewFile("notes.mdx")).toThrow(/\.md/);
    expect(() => requireRelativePreviewFile("")).toThrow(/non-empty/);
  });
});

describe("resolveContainedPreviewPath", () => {
  test("resolves under the root", () => {
    expect(resolveContainedPreviewPath(ROOT, "charts/demo.html")).toBe(
      resolve(ROOT, "charts/demo.html"),
    );
  });

  test("rejects a resolved path outside the root", () => {
    expect(() => resolveContainedPreviewPath(ROOT, "../outside.html")).toThrow(/escape/);
  });
});

describe("preparePreview", () => {
  test("reads workspace HTML through bb.sdk.files with host and root confinement", async () => {
    const { ctx, getThread, readFile } = context();

    expect(
      await preparePreview.execute(ctx, {
        threadId: "thread-1",
        file: "charts/demo.html",
        source: "workspace",
      }),
    ).toEqual({
      kind: "html",
      file: "charts/demo.html",
      source: "workspace",
      html: "<html><body>ok</body></html>",
    });
    expect(getThread).toHaveBeenCalledWith({ threadId: "thread-1", include: "environment" });
    expect(readFile).toHaveBeenCalledWith({
      path: resolve(ROOT, "charts/demo.html"),
      rootPath: ROOT,
      hostId: HOST_ID,
    });
  });

  test("defaults the source to the workspace", async () => {
    const { ctx } = context();
    const input = preparePreview.input.parse({ threadId: "thread-1", file: "demo.html" });
    expect(input.source).toBe("workspace");
    expect(await preparePreview.execute(ctx, input)).toMatchObject({ source: "workspace" });
  });

  test("rejects an unknown source during input validation", () => {
    expect(() =>
      preparePreview.input.parse({ threadId: "thread-1", file: "demo.html", source: "project" }),
    ).toThrow();
  });

  test("returns Markdown content with a workspace document for relative links", async () => {
    const { ctx, readFile } = context({
      read: () => ({ content: "# Notes\n\nReady.", contentEncoding: "utf8", sizeBytes: 16 }),
    });

    expect(
      await preparePreview.execute(ctx, {
        threadId: "thread-1",
        file: "reports/notes.md",
        source: "workspace",
      }),
    ).toEqual({
      kind: "markdown",
      file: "reports/notes.md",
      source: "workspace",
      content: "# Notes\n\nReady.",
      document: {
        rootPath: ROOT,
        threadId: "thread-1",
        target: { kind: "workspace", environmentId: "env-1", path: "reports/notes.md" },
      },
    });
    expect(readFile).toHaveBeenCalledWith({
      path: resolve(ROOT, "reports/notes.md"),
      rootPath: ROOT,
      hostId: HOST_ID,
    });
  });

  test("reads thread storage without resolving the workspace", async () => {
    const { ctx, getThread, storageLocation, readFile } = context({
      read: () => ({ content: "# Report", contentEncoding: "utf8", sizeBytes: 8 }),
    });

    expect(
      await preparePreview.execute(ctx, {
        threadId: "thread-1",
        file: "reports/summary.markdown",
        source: "thread-storage",
      }),
    ).toEqual({
      kind: "markdown",
      file: "reports/summary.markdown",
      source: "thread-storage",
      content: "# Report",
      document: {
        rootPath: STORAGE_ROOT,
        threadId: "thread-1",
        target: { kind: "thread-storage", threadId: "thread-1", path: "reports/summary.markdown" },
      },
    });
    expect(storageLocation).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(getThread).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith({
      path: resolve(STORAGE_ROOT, "reports/summary.markdown"),
      rootPath: STORAGE_ROOT,
      hostId: HOST_ID,
    });

    expect(
      await preparePreview.execute(ctx, {
        threadId: "thread-1",
        file: "reports/result.html",
        source: "thread-storage",
      }),
    ).toEqual({
      kind: "html",
      file: "reports/result.html",
      source: "thread-storage",
      html: "# Report",
    });
    expect(getThread).not.toHaveBeenCalled();
  });

  test("requires a live environment path and host", async () => {
    const noPath = context({ environment: { path: null, hostId: HOST_ID } });
    await expect(
      preparePreview.execute(noPath.ctx, {
        threadId: "thread-1",
        file: "demo.html",
        source: "workspace",
      }),
    ).rejects.toThrow(/no workspace path/);

    const noHost = context({ environment: { path: ROOT, hostId: "" } });
    await expect(
      preparePreview.execute(noHost.ctx, {
        threadId: "thread-1",
        file: "demo.html",
        source: "workspace",
      }),
    ).rejects.toThrow(/no hostId/);
  });

  test("rejects invalid paths before reading", async () => {
    const { ctx, readFile } = context();
    await expect(
      preparePreview.execute(ctx, {
        threadId: "thread-1",
        file: "../secret.html",
        source: "workspace",
      }),
    ).rejects.toThrow(/traversal|escape/);
    await expect(
      preparePreview.execute(ctx, { threadId: "thread-1", file: "notes.txt", source: "workspace" }),
    ).rejects.toThrow(/\.html/);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("maps missing files and rejects non-UTF-8 or oversized content", async () => {
    const missing = context({
      read() {
        throw Object.assign(new Error("missing"), { status: 404 });
      },
    });
    await expect(
      preparePreview.execute(missing.ctx, {
        threadId: "thread-1",
        file: "gone.html",
        source: "workspace",
      }),
    ).rejects.toThrow(/Preview file not found/);

    const binary = context({
      read: () => ({ content: "????", contentEncoding: "base64", sizeBytes: 4 }),
    });
    await expect(
      preparePreview.execute(binary.ctx, {
        threadId: "thread-1",
        file: "bin.html",
        source: "workspace",
      }),
    ).rejects.toThrow(/UTF-8/);

    const huge = context({
      read: () => ({ content: "", contentEncoding: "utf8", sizeBytes: MAX_PREVIEW_BYTES + 1 }),
    });
    await expect(
      preparePreview.execute(huge.ctx, {
        threadId: "thread-1",
        file: "big.md",
        source: "workspace",
      }),
    ).rejects.toThrow(/too large/);
  });
});
