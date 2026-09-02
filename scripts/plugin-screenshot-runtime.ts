import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { workspacePlugins } from "./plugin-package";

export const SCREENSHOT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SCREENSHOT_THEME_ID = "plugin:monokai:bb-monokai";
export const SCREENSHOT_PREFLIGHT_PLUGINS = workspacePlugins(SCREENSHOT_ROOT).map(
  ({ id, directory }) => ({ id, directory }),
);

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

export type BbCommandRunner = (args: readonly string[]) => Promise<string>;

export function routedBbCli(environment: NodeJS.ProcessEnv = process.env): string {
  const executable = environment.BB_CLI;
  if (!executable) {
    throw new Error(
      "BB_CLI is not set. Run this command through bun run dev:instance and bb-kit dev-instance run.",
    );
  }
  return executable;
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

function parseBbJson(output: string, args: readonly string[]): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`bb ${args.join(" ")} returned invalid JSON`);
  }
}

interface PluginState {
  enabled: boolean;
  rootDir: string;
  status: string;
}

function pluginStates(output: string, args: readonly string[]): Map<string, PluginState> {
  const value = parseBbJson(output, args);
  if (
    typeof value !== "object" ||
    value === null ||
    !("plugins" in value) ||
    !Array.isArray(value.plugins)
  ) {
    throw new Error(`bb ${args.join(" ")} returned no plugin list`);
  }

  const states = new Map<string, PluginState>();
  for (const plugin of value.plugins) {
    if (
      typeof plugin !== "object" ||
      plugin === null ||
      !("id" in plugin) ||
      typeof plugin.id !== "string" ||
      !("enabled" in plugin) ||
      typeof plugin.enabled !== "boolean" ||
      !("rootDir" in plugin) ||
      typeof plugin.rootDir !== "string" ||
      !("status" in plugin) ||
      typeof plugin.status !== "string"
    ) {
      throw new Error(`bb ${args.join(" ")} returned an invalid plugin entry`);
    }
    states.set(plugin.id, {
      enabled: plugin.enabled,
      rootDir: resolve(plugin.rootDir),
      status: plugin.status,
    });
  }
  return states;
}

function activeTheme(output: string, args: readonly string[]): string {
  const value = parseBbJson(output, args);
  if (
    typeof value !== "object" ||
    value === null ||
    !("themeId" in value) ||
    typeof value.themeId !== "string"
  ) {
    throw new Error(`bb ${args.join(" ")} returned no active theme`);
  }
  return value.themeId;
}

export async function runBbCommand(args: readonly string[]): Promise<string> {
  const executable = routedBbCli();
  const child = Bun.spawn([executable, ...args], {
    cwd: SCREENSHOT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`bb ${args.join(" ")} failed: ${detail}`);
  }
  return stdout;
}

/**
 * Enable every workspace plugin from this checkout and select bb Monokai.
 * One independent final read is the readiness barrier. Invalid installations
 * fail before any mutation.
 */
export async function prepareBbForScreenshots(
  runCommand: BbCommandRunner = runBbCommand,
): Promise<void> {
  const plugins = SCREENSHOT_PREFLIGHT_PLUGINS;
  const listArgs = ["plugin", "list", "--json"] as const;
  const initialPlugins = pluginStates(await runCommand(listArgs), listArgs);
  const missing = plugins.filter((plugin) => !initialPlugins.has(plugin.id));
  const wrongSources = plugins.filter((plugin) => {
    const state = initialPlugins.get(plugin.id);
    return state && state.rootDir !== join(SCREENSHOT_ROOT, "plugins", plugin.directory);
  });
  if (missing.length > 0 || wrongSources.length > 0) {
    throw new Error(
      [
        "workspace plugins are not installed from this checkout:",
        ...missing.map(
          (plugin) => `  ${plugin.id}: bb plugin install ./plugins/${plugin.directory}`,
        ),
        ...wrongSources.map(
          (plugin) =>
            `  ${plugin.id}: expected ${join(SCREENSHOT_ROOT, "plugins", plugin.directory)}, found ${initialPlugins.get(plugin.id)!.rootDir}`,
        ),
        "Install or reinstall them from this checkout, then run the screenshot command again.",
      ].join("\n"),
    );
  }

  for (const plugin of plugins) {
    if (initialPlugins.get(plugin.id)?.enabled === false) {
      await runCommand(["plugin", "enable", plugin.id, "--json"]);
    }
  }

  const themeArgs = ["theme", "show", "--json"] as const;
  if (activeTheme(await runCommand(themeArgs), themeArgs) !== SCREENSHOT_THEME_ID) {
    await runCommand(["theme", "set", SCREENSHOT_THEME_ID, "--json"]);
  }

  const finalPlugins = pluginStates(await runCommand(listArgs), listArgs);
  const finalTheme = activeTheme(await runCommand(themeArgs), themeArgs);
  const finalMissing = plugins.filter((plugin) => !finalPlugins.has(plugin.id));
  const finalDisabled = plugins.filter(
    (plugin) => finalPlugins.has(plugin.id) && finalPlugins.get(plugin.id)?.enabled !== true,
  );
  const finalWrongSources = plugins.filter((plugin) => {
    const state = finalPlugins.get(plugin.id);
    return state && state.rootDir !== join(SCREENSHOT_ROOT, "plugins", plugin.directory);
  });
  const finalNotRunning = plugins.filter(
    (plugin) => finalPlugins.get(plugin.id)?.status !== "running",
  );
  const failures = [
    finalMissing.length > 0
      ? `not installed: ${finalMissing.map((plugin) => plugin.id).join(", ")}`
      : "",
    finalDisabled.length > 0
      ? `not enabled: ${finalDisabled.map((plugin) => plugin.id).join(", ")}`
      : "",
    finalWrongSources.length > 0
      ? `wrong source: ${finalWrongSources.map((plugin) => plugin.id).join(", ")}`
      : "",
    finalNotRunning.length > 0
      ? `not running: ${finalNotRunning.map((plugin) => plugin.id).join(", ")}`
      : "",
    finalTheme !== SCREENSHOT_THEME_ID
      ? `active theme is ${finalTheme}; expected ${SCREENSHOT_THEME_ID}`
      : "",
  ].filter(Boolean);
  if (failures.length > 0) {
    throw new Error(`bb screenshot preflight did not converge:\n  ${failures.join("\n  ")}`);
  }
}

export async function launchScreenshotBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, args: [...BROWSER_LAUNCH_ARGS] });
}

export async function createScreenshotContext(
  browser: Browser,
  options: { viewport: ScreenshotSize; dpr: number },
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.dpr,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
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
