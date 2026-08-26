import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  parseScreenshotArguments,
  prepareBbForScreenshots,
  SCREENSHOT_PREFLIGHT_PLUGINS,
  SCREENSHOT_ROOT,
  SCREENSHOT_THEME_ID,
  withScreenshotBatch,
} from "./plugin-screenshot-runtime";

function pluginList(
  options: {
    disabled?: string[];
    missing?: string[];
    notRunning?: string[];
    wrongSource?: string;
  } = {},
): string {
  const disabled = new Set(options.disabled ?? []);
  const missing = new Set(options.missing ?? []);
  const notRunning = new Set(options.notRunning ?? []);
  return JSON.stringify({
    plugins: SCREENSHOT_PREFLIGHT_PLUGINS.filter((plugin) => !missing.has(plugin.id)).map(
      (plugin) => ({
        id: plugin.id,
        enabled: !disabled.has(plugin.id),
        rootDir:
          plugin.id === options.wrongSource
            ? `/tmp/other/${plugin.directory}`
            : join(SCREENSHOT_ROOT, "plugins", plugin.directory),
        status: disabled.has(plugin.id) || notRunning.has(plugin.id) ? "disabled" : "running",
      }),
    ),
  });
}

function theme(themeId = SCREENSHOT_THEME_ID): string {
  return JSON.stringify({ themeId });
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function screenshotPage(result: Buffer | Error): Pick<Page, "screenshot"> {
  return {
    async screenshot(options) {
      if (result instanceof Error) throw result;
      if (!options.path) throw new Error("test screenshot has no output path");
      await writeFile(options.path, result);
      return result;
    },
  } as Pick<Page, "screenshot">;
}

async function stagedFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((filename) => filename.startsWith("."));
}

describe("plugin screenshot arguments", () => {
  test("deduplicates selected plugins and accepts an output directory", () => {
    expect(
      parseScreenshotArguments([
        "--plugin",
        "amp",
        "--plugin=amp",
        "--plugin",
        "gh-stack",
        "--output-dir",
        "/tmp/heroes",
      ]),
    ).toEqual({
      plugins: ["amp", "gh-stack"],
      outputDir: "/tmp/heroes",
      help: false,
      list: false,
    });
  });

  test("rejects missing, empty, and unknown options", () => {
    expect(() => parseScreenshotArguments(["--plugin"])).toThrow("--plugin needs an id");
    expect(() => parseScreenshotArguments(["--plugin="])).toThrow("--plugin needs an id");
    expect(() => parseScreenshotArguments(["--output-dir="])).toThrow("--output-dir needs a path");
    expect(() => parseScreenshotArguments(["--unknown"])).toThrow("unknown argument");
  });
});

describe("bb screenshot preflight", () => {
  test("does not mutate an already-correct bb", async () => {
    const calls: string[][] = [];
    const runCommand = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      return args[0] === "plugin" ? pluginList() : theme();
    };

    await prepareBbForScreenshots(runCommand);

    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["theme", "show", "--json"],
      ["plugin", "list", "--json"],
      ["theme", "show", "--json"],
    ]);
  });

  test("enables disabled plugins sequentially", async () => {
    const calls: string[][] = [];
    let listReads = 0;
    const runCommand = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args.join(" ") === "plugin list --json") {
        return listReads++ === 0
          ? pluginList({ disabled: ["agentation", "notify"] })
          : pluginList();
      }
      if (args.join(" ") === "theme show --json") return theme();
      return "{}";
    };

    await prepareBbForScreenshots(runCommand);

    expect(calls.filter((args) => args[1] === "enable")).toEqual([
      ["plugin", "enable", "agentation", "--json"],
      ["plugin", "enable", "notify", "--json"],
    ]);
  });

  test("fails before mutation when a workspace plugin is not installed", async () => {
    const calls: string[][] = [];
    const runCommand = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      return pluginList({ missing: ["gtd-sidebar"] });
    };

    await expect(prepareBbForScreenshots(runCommand)).rejects.toThrow(
      "gtd-sidebar: bb plugin install ./plugins/gtd-sidebar",
    );
    expect(calls).toEqual([["plugin", "list", "--json"]]);
  });

  test("fails before mutation when bb has another copy of a workspace plugin", async () => {
    const calls: string[][] = [];
    const runCommand = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      return pluginList({ wrongSource: "monokai" });
    };

    await expect(prepareBbForScreenshots(runCommand)).rejects.toThrow("monokai: expected");
    expect(calls).toEqual([["plugin", "list", "--json"]]);
  });

  test("selects Monokai only when another theme is active", async () => {
    const calls: string[][] = [];
    let themeReads = 0;
    const runCommand = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args.join(" ") === "plugin list --json") return pluginList();
      if (args.join(" ") === "theme show --json") {
        return theme(themeReads++ === 0 ? "default" : SCREENSHOT_THEME_ID);
      }
      return "{}";
    };

    await prepareBbForScreenshots(runCommand);

    expect(calls).toContainEqual(["theme", "set", SCREENSHOT_THEME_ID, "--json"]);
  });

  test("fails when final plugin verification does not converge", async () => {
    const runCommand = async (args: readonly string[]): Promise<string> => {
      if (args.join(" ") === "plugin list --json") {
        return pluginList({ disabled: ["dotfiles"] });
      }
      if (args.join(" ") === "theme show --json") return theme();
      return "{}";
    };

    await expect(prepareBbForScreenshots(runCommand)).rejects.toThrow("not enabled: dotfiles");
  });

  test("fails when a workspace plugin is enabled but not running", async () => {
    const runCommand = async (args: readonly string[]): Promise<string> => {
      if (args.join(" ") === "plugin list --json") {
        return pluginList({ notRunning: ["agent-proxy"] });
      }
      if (args.join(" ") === "theme show --json") return theme();
      return "{}";
    };

    await expect(prepareBbForScreenshots(runCommand)).rejects.toThrow("not running: agent-proxy");
  });

  test("fails when final theme verification does not converge", async () => {
    const runCommand = async (args: readonly string[]): Promise<string> => {
      if (args.join(" ") === "plugin list --json") return pluginList();
      if (args.join(" ") === "theme show --json") return theme("default");
      return "{}";
    };

    await expect(prepareBbForScreenshots(runCommand)).rejects.toThrow(
      `active theme is default; expected ${SCREENSHOT_THEME_ID}`,
    );
  });
});

describe("screenshot batch publication", () => {
  test("publishes every validated capture and removes staged files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-screenshot-success-"));
    try {
      const first = join(directory, "first.png");
      const second = join(directory, "second.png");
      await Promise.all([writeFile(first, "old first"), writeFile(second, "old second")]);

      const results = await withScreenshotBatch(async (batch) => {
        await batch.capture(screenshotPage(png(20, 10)), {
          id: "first",
          output: first,
          expected: { width: 20, height: 10 },
        });
        await batch.capture(screenshotPage(png(30, 15)), {
          id: "second",
          output: second,
          expected: { width: 30, height: 15 },
        });
      });

      expect(results.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
        { id: "first", width: 20, height: 10 },
        { id: "second", width: 30, height: 15 },
      ]);
      expect(await readFile(first)).toEqual(png(20, 10));
      expect(await readFile(second)).toEqual(png(30, 15));
      expect(await stagedFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a later capture failure leaves every existing output unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-screenshot-failure-"));
    try {
      const first = join(directory, "first.png");
      const second = join(directory, "second.png");
      await Promise.all([writeFile(first, "old first"), writeFile(second, "old second")]);

      await expect(
        withScreenshotBatch(async (batch) => {
          await batch.capture(screenshotPage(png(20, 10)), {
            id: "first",
            output: first,
            expected: { width: 20, height: 10 },
          });
          await batch.capture(screenshotPage(new Error("capture failed")), {
            id: "second",
            output: second,
            expected: { width: 30, height: 15 },
          });
        }),
      ).rejects.toThrow("capture failed");

      expect(await readFile(first, "utf8")).toBe("old first");
      expect(await readFile(second, "utf8")).toBe("old second");
      expect(await stagedFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("invalid PNG data or dimensions publish nothing", async () => {
    for (const [name, result, expectedError] of [
      ["invalid", Buffer.from("not a png"), "Playwright did not produce a PNG"],
      ["dimensions", png(19, 10), "expected 20×10, got 19×10"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), `bb-screenshot-${name}-`));
      try {
        const output = join(directory, "output.png");
        await writeFile(output, "old output");

        await expect(
          withScreenshotBatch((batch) =>
            batch.capture(screenshotPage(result), {
              id: name,
              output,
              expected: { width: 20, height: 10 },
            }),
          ),
        ).rejects.toThrow(expectedError);

        expect(await readFile(output, "utf8")).toBe("old output");
        expect(await stagedFiles(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("rejects duplicate outputs before publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-screenshot-duplicate-"));
    try {
      const output = join(directory, "output.png");
      await writeFile(output, "old output");

      await expect(
        withScreenshotBatch(async (batch) => {
          await batch.capture(screenshotPage(png(20, 10)), {
            id: "first",
            output,
            expected: { width: 20, height: 10 },
          });
          await batch.capture(screenshotPage(png(20, 10)), {
            id: "second",
            output,
            expected: { width: 20, height: 10 },
          });
        }),
      ).rejects.toThrow("duplicate screenshot output");

      expect(await readFile(output, "utf8")).toBe("old output");
      expect(await stagedFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
