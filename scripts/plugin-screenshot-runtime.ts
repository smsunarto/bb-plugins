import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { workspacePlugins } from "./plugin-package";

export const SCREENSHOT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SIDEBAR_PROVIDER_KEY = "bb.sidebar.threadListProvider";
export const SIDEBAR_PROVIDER = "gtd-sidebar/inbox";
export const SCREENSHOT_PLUGINS = workspacePlugins(SCREENSHOT_ROOT);

const BROWSER_LAUNCH_ARGS = [
  "--disable-gpu",
  "--disable-lcd-text",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
] as const;

export interface ScreenshotOptions {
  plugins: string[];
  outputDir: string | null;
  help: boolean;
  list: boolean;
}

export interface ScreenshotSize {
  width: number;
  height: number;
}

export interface ScreenshotClip extends ScreenshotSize {
  x: number;
  y: number;
}

export interface ScreenshotCaptureRequest {
  id: string;
  output: string;
  expected: ScreenshotSize;
  clip?: ScreenshotClip;
}

export interface ScreenshotCaptureResult extends ScreenshotSize {
  id: string;
  output: string;
}

export interface ScreenshotBatch {
  capture(page: Pick<Page, "screenshot">, request: ScreenshotCaptureRequest): Promise<void>;
}

export function parseScreenshotArguments(args: readonly string[]): ScreenshotOptions {
  const plugins: string[] = [];
  let outputDir: string | null = null;
  let help = false;
  let list = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--list") {
      list = true;
    } else if (argument === "--plugin") {
      const plugin = args[++index];
      if (!plugin) throw new Error("--plugin needs an id");
      plugins.push(plugin);
    } else if (argument.startsWith("--plugin=")) {
      const plugin = argument.slice("--plugin=".length);
      if (!plugin) throw new Error("--plugin needs an id");
      plugins.push(plugin);
    } else if (argument === "--output-dir") {
      outputDir = args[++index] ?? null;
      if (!outputDir) throw new Error("--output-dir needs a path");
    } else if (argument.startsWith("--output-dir=")) {
      outputDir = argument.slice("--output-dir=".length);
      if (!outputDir) throw new Error("--output-dir needs a path");
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { plugins: [...new Set(plugins)], outputDir, help, list };
}

export async function launchScreenshotBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, args: [...BROWSER_LAUNCH_ARGS] });
}

export async function createScreenshotContext(
  browser: Browser,
  options: { viewport: ScreenshotSize; dpr: number },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.dpr,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  await context.addInitScript(
    ({ key, provider }) => localStorage.setItem(key, JSON.stringify(provider)),
    { key: SIDEBAR_PROVIDER_KEY, provider: SIDEBAR_PROVIDER },
  );
  return context;
}

export async function createScreenshotPage(
  context: BrowserContext,
  options: { fixedTime?: Date; timeoutMs?: number } = {},
): Promise<Page> {
  const page = await context.newPage();
  if (options.fixedTime) await page.clock.setFixedTime(options.fixedTime);
  if (options.timeoutMs) page.setDefaultTimeout(options.timeoutMs);
  return page;
}

function pngDimensions(bytes: Buffer): ScreenshotSize {
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Playwright did not produce a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

class StagedScreenshotBatch implements ScreenshotBatch {
  readonly #captures: Array<{
    temporary: string;
    result: ScreenshotCaptureResult;
  }> = [];
  readonly #outputs = new Set<string>();
  #sequence = 0;

  get results(): readonly ScreenshotCaptureResult[] {
    return this.#captures.map(({ result }) => result);
  }

  async capture(page: Pick<Page, "screenshot">, request: ScreenshotCaptureRequest): Promise<void> {
    const output = resolve(request.output);
    if (this.#outputs.has(output)) {
      throw new Error(`duplicate screenshot output: ${output}`);
    }
    this.#outputs.add(output);

    await mkdir(dirname(output), { recursive: true });
    const temporary = join(
      dirname(output),
      `.${basename(output)}-${process.pid}-${this.#sequence++}.png`,
    );
    try {
      await page.screenshot({
        path: temporary,
        type: "png",
        clip: request.clip,
        animations: "disabled",
        caret: "hide",
        scale: "device",
      });

      const dimensions = pngDimensions(await readFile(temporary));
      if (
        dimensions.width !== request.expected.width ||
        dimensions.height !== request.expected.height
      ) {
        throw new Error(
          `${request.id}: expected ${request.expected.width}×${request.expected.height}, got ${dimensions.width}×${dimensions.height}`,
        );
      }
      this.#captures.push({
        temporary,
        result: { id: request.id, output, ...dimensions },
      });
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async publish(): Promise<void> {
    for (const { result, temporary } of this.#captures) {
      await rename(temporary, result.output);
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.#captures.map(({ temporary }) => rm(temporary, { force: true })));
  }
}

/**
 * Capture and validate every requested PNG before publishing any of them.
 * Final renames are individually atomic; a capture failure leaves all existing
 * outputs unchanged.
 */
export async function withScreenshotBatch(
  run: (batch: ScreenshotBatch) => Promise<void>,
): Promise<readonly ScreenshotCaptureResult[]> {
  const batch = new StagedScreenshotBatch();
  try {
    await run(batch);
    await batch.publish();
    return batch.results;
  } finally {
    await batch.cleanup();
  }
}
