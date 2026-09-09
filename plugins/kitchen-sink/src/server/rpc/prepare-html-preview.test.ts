import { describe, expect, mock, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolve } from "node:path";

import {
  MAX_HTML_BYTES,
  requireWorkspaceHtmlFile,
  resolveContainedHtmlPath,
} from "../lib/html-preview.ts";
import { prepareHtmlPreview } from "./prepare-html-preview.ts";

const ROOT = "/workspace/project";
const HOST_ID = "host-1";

function context(
  options: {
    environment?: { path?: string | null; hostId?: string } | null;
    read?: (input: unknown) => unknown;
  } = {},
) {
  const environment =
    options.environment === undefined ? { path: ROOT, hostId: HOST_ID } : options.environment;
  const getThread = mock(async () => ({ id: "thread-1", environment }));
  const readFile = mock(
    async (input: unknown) =>
      options.read?.(input) ?? {
        content: "<html><body>ok</body></html>",
        contentEncoding: "utf8",
        sizeBytes: 32,
      },
  );
  const bb = {
    sdk: { threads: { get: getThread }, files: { read: readFile } },
  } as unknown as BbPluginApi;
  return { ctx: stubHostContext({ bb }), getThread, readFile };
}

describe("requireWorkspaceHtmlFile", () => {
  test("accepts nested HTML paths", () => {
    expect(requireWorkspaceHtmlFile("demo.html")).toBe("demo.html");
    expect(requireWorkspaceHtmlFile("charts/out.HTML")).toBe("charts/out.HTML");
  });

  test("rejects absolute, traversing, and non-HTML paths", () => {
    expect(() => requireWorkspaceHtmlFile("/etc/passwd.html")).toThrow(/workspace-relative/);
    expect(() => requireWorkspaceHtmlFile("../secret.html")).toThrow(/traversal|escape/);
    expect(() => requireWorkspaceHtmlFile("..\\secret.html")).toThrow(/traversal|escape/);
    expect(() => requireWorkspaceHtmlFile("charts/../secret.html")).toThrow(/traversal/);
    expect(() => requireWorkspaceHtmlFile("demo.md")).toThrow(/\.html/);
    expect(() => requireWorkspaceHtmlFile("")).toThrow(/non-empty/);
  });
});

describe("resolveContainedHtmlPath", () => {
  test("resolves under the workspace root", () => {
    expect(resolveContainedHtmlPath(ROOT, "charts/demo.html")).toBe(
      resolve(ROOT, "charts/demo.html"),
    );
  });

  test("rejects a resolved path outside the workspace root", () => {
    expect(() => resolveContainedHtmlPath(ROOT, "../outside.html")).toThrow(/escape/);
  });
});

describe("prepareHtmlPreview", () => {
  test("reads through bb.sdk.files with host and root confinement", async () => {
    const { ctx, getThread, readFile } = context();

    expect(
      await prepareHtmlPreview.execute(ctx, {
        threadId: "thread-1",
        file: "charts/demo.html",
      }),
    ).toEqual({ file: "charts/demo.html", html: "<html><body>ok</body></html>" });
    expect(getThread).toHaveBeenCalledWith({
      threadId: "thread-1",
      include: "environment",
    });
    expect(readFile).toHaveBeenCalledWith({
      path: resolve(ROOT, "charts/demo.html"),
      rootPath: ROOT,
      hostId: HOST_ID,
    });
  });

  test("requires a live environment path and host", async () => {
    const noPath = context({ environment: { path: null, hostId: HOST_ID } });
    await expect(
      prepareHtmlPreview.execute(noPath.ctx, { threadId: "thread-1", file: "demo.html" }),
    ).rejects.toThrow(/no workspace path/);

    const noHost = context({ environment: { path: ROOT, hostId: "" } });
    await expect(
      prepareHtmlPreview.execute(noHost.ctx, { threadId: "thread-1", file: "demo.html" }),
    ).rejects.toThrow(/no hostId/);
  });

  test("rejects invalid paths before reading", async () => {
    const { ctx, readFile } = context();
    await expect(
      prepareHtmlPreview.execute(ctx, { threadId: "thread-1", file: "../secret.html" }),
    ).rejects.toThrow(/traversal|escape/);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("maps missing files and rejects non-UTF-8 or oversized content", async () => {
    const missing = context({
      read() {
        throw Object.assign(new Error("missing"), { status: 404 });
      },
    });
    await expect(
      prepareHtmlPreview.execute(missing.ctx, { threadId: "thread-1", file: "gone.html" }),
    ).rejects.toThrow(/HTML file not found/);

    const binary = context({
      read: () => ({ content: "????", contentEncoding: "base64", sizeBytes: 4 }),
    });
    await expect(
      prepareHtmlPreview.execute(binary.ctx, { threadId: "thread-1", file: "bin.html" }),
    ).rejects.toThrow(/UTF-8/);

    const huge = context({
      read: () => ({ content: "", contentEncoding: "utf8", sizeBytes: MAX_HTML_BYTES + 1 }),
    });
    await expect(
      prepareHtmlPreview.execute(huge.ctx, { threadId: "thread-1", file: "big.html" }),
    ).rejects.toThrow(/too large/);
  });
});
