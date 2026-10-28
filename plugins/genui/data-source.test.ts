import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import { loadGalleryAsset, loadThreadAudio, loadThreadFile, loadThreadImage, MAX_AUDIO_BYTES, MAX_DATA_BYTES, MAX_IMAGE_BYTES } from "./data-source";

const WORKSPACE = "/work/repo";
const STORAGE = "/home/u/.bb/thread-storage/thr_1";

/** A file as `files.read` returns it: text as UTF-8, binary as base64. */
interface FakeFile {
  content: string;
  encoding?: "utf8" | "base64";
  sizeBytes?: number;
}

/** Just the SDK calls the loader makes, over an in-memory file table. */
function fakeBb(files: Record<string, string | FakeFile>, reads: string[] = []): BbPluginApi {
  const sdk = {
    threads: {
      get: async () => ({ id: "thr_1", environment: { id: "env_1", path: WORKSPACE, hostId: "host_1" } }),
      storageLocation: async () => ({ storageRootPath: STORAGE, hostId: "host_1" }),
    },
    files: {
      read: async ({ path, rootPath }: { path: string; rootPath: string }) => {
        reads.push(`${rootPath}|${path}`);
        const entry = files[path];
        if (entry === undefined) throw Object.assign(new Error("missing"), { status: 404 });
        const file = typeof entry === "string" ? { content: entry } : entry;
        return {
          path,
          content: file.content,
          contentEncoding: file.encoding ?? "utf8",
          sizeBytes: file.sizeBytes ?? file.content.length,
          sha256: "x",
        };
      },
    },
  };
  return { sdk } as unknown as BbPluginApi;
}

describe("loadThreadFile", () => {
  it("reads workspace-relative paths inside the workspace root", async () => {
    const reads: string[] = [];
    const bb = fakeBb({ [`${WORKSPACE}/bench/results.json`]: '[{"name":"a","ms":12}]' }, reads);
    expect(await loadThreadFile(bb, "thr_1", "bench/results.json")).toEqual({
      ok: true,
      value: [{ name: "a", ms: 12 }],
    });
    expect(reads).toEqual([`${WORKSPACE}|${WORKSPACE}/bench/results.json`]);
  });

  it("reads $BB_THREAD_STORAGE paths from the thread storage root", async () => {
    const bb = fakeBb({ [`${STORAGE}/sizes.csv`]: "file,lines\ncore.ts,652\n" });
    expect(await loadThreadFile(bb, "thr_1", "$BB_THREAD_STORAGE/sizes.csv")).toEqual({
      ok: true,
      value: [{ file: "core.ts", lines: 652 }],
    });
  });

  it("accepts absolute paths only inside the workspace, thread storage or /tmp", async () => {
    const bb = fakeBb({ [`${STORAGE}/a.json`]: "1", "/tmp/report.json": "2", "/etc/passwd": "root" });
    expect(await loadThreadFile(bb, "thr_1", `${STORAGE}/a.json`)).toEqual({ ok: true, value: 1 });
    expect(await loadThreadFile(bb, "thr_1", "/tmp/report.json")).toEqual({ ok: true, value: 2 });
    expect(await loadThreadFile(bb, "thr_1", "/etc/passwd")).toMatchObject({ ok: false });
    expect(await loadThreadFile(bb, "thr_1", "/tmp/../etc/passwd")).toMatchObject({ ok: false });
    expect(await loadThreadFile(bb, "thr_1", "/tmpfoo/x.json")).toMatchObject({ ok: false });
  });

  it("refuses paths that climb out of their root", async () => {
    const reads: string[] = [];
    const bb = fakeBb({ "/work/secrets.json": "{}" }, reads);
    expect(await loadThreadFile(bb, "thr_1", "../secrets.json")).toMatchObject({ ok: false });
    expect(await loadThreadFile(bb, "thr_1", "$BB_THREAD_STORAGE/../../secret.json")).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
  });

  it("reports a missing file as a value, not a throw", async () => {
    expect(await loadThreadFile(fakeBb({}), "thr_1", "nope.json")).toEqual({ ok: false, error: "file not found" });
  });
});

describe("loadThreadFile raw", () => {
  it("returns the text unparsed, without a byte-order mark", async () => {
    const bb = fakeBb({ [`${WORKSPACE}/cfg.json`]: '\uFEFF{"a": 1}\n' });
    expect(await loadThreadFile(bb, "thr_1", "cfg.json", { raw: true })).toEqual({ ok: true, value: '{"a": 1}\n' });
    expect(await loadThreadFile(bb, "thr_1", "cfg.json")).toEqual({ ok: true, value: { a: 1 } });
  });

  it("keeps the confinement, text-only rule and size cap", async () => {
    const reads: string[] = [];
    const bb = fakeBb(
      {
        [`${WORKSPACE}/logo.png`]: { content: "iVBORw0KGgo=", encoding: "base64" },
        [`${WORKSPACE}/huge.ts`]: { content: "x", sizeBytes: MAX_DATA_BYTES + 1 },
      },
      reads,
    );
    expect(await loadThreadFile(bb, "thr_1", "../secrets.ts", { raw: true })).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
    expect(await loadThreadFile(bb, "thr_1", "logo.png", { raw: true })).toEqual({ ok: false, error: "not a text file" });
    expect(await loadThreadFile(bb, "thr_1", "huge.ts", { raw: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
  });
});

describe("loadThreadImage", () => {
  it("returns workspace and thread-storage images as data URLs typed by extension", async () => {
    const bb = fakeBb({
      [`${WORKSPACE}/docs/shot.PNG`]: { content: "iVBORw0KGgo=", encoding: "base64" },
      [`${STORAGE}/chart.jpg`]: { content: "/9j/4AAQ", encoding: "base64" },
    });
    expect(await loadThreadImage(bb, "thr_1", "docs/shot.PNG")).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(await loadThreadImage(bb, "thr_1", "$BB_THREAD_STORAGE/chart.jpg")).toEqual({
      ok: true,
      dataUrl: "data:image/jpeg;base64,/9j/4AAQ",
    });
  });

  it("encodes SVG that arrives as text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const bb = fakeBb({ [`${WORKSPACE}/icon.svg`]: svg });
    expect(await loadThreadImage(bb, "thr_1", "icon.svg")).toEqual({
      ok: true,
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    });
  });

  it("refuses files outside the workspace and thread storage", async () => {
    const reads: string[] = [];
    const bb = fakeBb({ "/etc/logo.png": { content: "AA==", encoding: "base64" } }, reads);
    expect(await loadThreadImage(bb, "thr_1", "/etc/logo.png")).toMatchObject({ ok: false });
    expect(await loadThreadImage(bb, "thr_1", "../../etc/logo.png")).toMatchObject({ ok: false });
    expect(await loadThreadImage(bb, "thr_1", "$BB_THREAD_STORAGE/../../logo.png")).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
  });

  // Agents and their tools (Playwright, simulators) save screenshots to /tmp.
  // BB refuses a symlinked root, and macOS's /tmp links to /private/tmp.
  it("shows screenshots from /tmp through its real path on macOS", async () => {
    const reads: string[] = [];
    const bb = fakeBb({ "/private/tmp/rs/shot.png": { content: "AA==", encoding: "base64" } }, reads);
    const read = bb.sdk.files.read;
    bb.sdk.files.read = async (args) => {
      if (args.rootPath === "/tmp") throw Object.assign(new Error('Root path "/tmp" must not be a symlink'), { status: 400 });
      return read(args);
    };
    expect(await loadThreadImage(bb, "thr_1", "/tmp/rs/shot.png")).toEqual({ ok: true, dataUrl: "data:image/png;base64,AA==" });
    expect(await loadThreadImage(bb, "thr_1", "/tmp/rs/gone.png")).toEqual({ ok: false, error: "file not found" });
    expect(reads).toEqual(["/private/tmp|/private/tmp/rs/shot.png", "/private/tmp|/private/tmp/rs/gone.png"]);
  });

  it("falls back to /tmp as written where there is no /private/tmp", async () => {
    const reads: string[] = [];
    const bb = fakeBb({ "/tmp/rs/shot.png": { content: "AA==", encoding: "base64" } }, reads);
    expect(await loadThreadImage(bb, "thr_1", "/tmp/rs/shot.png")).toMatchObject({ ok: true });
    expect(reads).toEqual(["/private/tmp|/private/tmp/rs/shot.png", "/tmp|/tmp/rs/shot.png"]);
  });

  it("only reads allowed image types", async () => {
    const reads: string[] = [];
    const bb = fakeBb({ [`${WORKSPACE}/page.html`]: "<script></script>", [`${WORKSPACE}/x.bmp`]: "BM" }, reads);
    for (const path of ["page.html", "x.bmp", "logo"]) {
      expect(await loadThreadImage(bb, "thr_1", path)).toMatchObject({ ok: false, error: expect.stringContaining("png") });
    }
    expect(reads).toEqual([]);
  });

  it("caps images at 5 MB and reports missing files", async () => {
    const bb = fakeBb({ [`${WORKSPACE}/big.webp`]: { content: "AA==", encoding: "base64", sizeBytes: MAX_IMAGE_BYTES + 1 } });
    expect(await loadThreadImage(bb, "thr_1", "big.webp")).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
    expect(await loadThreadImage(bb, "thr_1", "gone.avif")).toEqual({ ok: false, error: "file not found" });
  });
});

describe("loadThreadAudio", () => {
  it("reads recordings typed by extension, refuses other files without reading them, and caps at 25 MB", async () => {
    const reads: string[] = [];
    const bb = fakeBb(
      {
        [`${STORAGE}/take.wav`]: { content: "UklGRg==", encoding: "base64" },
        [`${WORKSPACE}/long.m4a`]: { content: "AA==", encoding: "base64", sizeBytes: MAX_AUDIO_BYTES + 1 },
      },
      reads,
    );
    expect(await loadThreadAudio(bb, "thr_1", "$BB_THREAD_STORAGE/take.wav")).toEqual({ ok: true, dataUrl: "data:audio/wav;base64,UklGRg==" });
    expect(await loadThreadAudio(bb, "thr_1", "long.m4a")).toMatchObject({ ok: false, error: expect.stringContaining("limit") });
    const before = reads.length;
    expect(await loadThreadAudio(bb, "thr_1", "clip.png")).toMatchObject({ ok: false, error: expect.stringContaining("wav") });
    expect(reads.length).toBe(before);
  });
});

describe("loadGalleryAsset", () => {
  it("returns a model's and an environment's bytes unchanged", async () => {
    for (const [file, type] of [["3d/pawn.glb", "model/gltf-binary"], ["3d/studio.hdr", "image/vnd.radiance"]]) {
      const loaded = await loadGalleryAsset(file);
      expect(loaded).toEqual({ ok: true, dataUrl: `data:${type};base64,${readFileSync(`gallery/${file}`).toString("base64")}` });
    }
  });
});
