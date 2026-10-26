import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Finds a Chrome the bb server can run headless. Snap wrappers are skipped:
 * they cannot use a temporary profile and break pipe-based automation.
 */

const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
];
const PATH_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome",
  "chrome-headless-shell",
  "microsoft-edge",
  "brave-browser",
];

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function playwrightBrowsers(): Promise<string[]> {
  const cache =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright");
  const entries = await readdir(cache).catch(() => [] as string[]);
  const platform = process.platform === "darwin" ? "mac" : "linux";
  return entries
    .filter((entry) => /^chromium(?:_headless_shell)?-\d+$/.test(entry))
    .sort()
    .reverse()
    .flatMap((entry) =>
      entry.startsWith("chromium_headless_shell")
        ? [
            join(cache, entry, `chrome-headless-shell-${platform}64`, "chrome-headless-shell"),
            join(cache, entry, `chrome-${platform}`, "headless_shell"),
          ]
        : [
            join(cache, entry, `chrome-${platform}`, "chrome"),
            join(cache, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
          ],
    );
}

export async function findChrome(configured: string): Promise<string | undefined> {
  if (configured) return (await executable(configured)) ? configured : undefined;
  const candidates =
    process.platform === "darwin"
      ? [
          ...MAC_APPS.map((app) => join("/Applications", app)),
          ...MAC_APPS.map((app) => join(homedir(), "Applications", app)),
        ]
      : [];
  const pathDirectories = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory && !directory.startsWith("/snap"));
  for (const name of PATH_NAMES) {
    for (const directory of pathDirectories) candidates.push(join(directory, name));
  }
  candidates.push(...(await playwrightBrowsers()));
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export function chromeMissingMessage(configured: string): string {
  return configured
    ? `The configured Chrome path ${configured} is not an executable on the bb server. Fix it with \`bb plugin config html set chromePath <path>\`, or unset it to search for Chrome.`
    : "No Chrome or Chromium was found on the bb server. Install Google Chrome there, or point the plugin at one with `bb plugin config html set chromePath <path>`.";
}

/** Turns a launch failure Chrome explains on stderr into the step that fixes it. */
export function chromeLaunchHint(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  if (/No usable sandbox|setuid sandbox|sandbox_host_linux/i.test(output)) {
    return "Chrome's sandbox is unavailable on the bb server, which is common when it runs as root or AppArmor blocks user namespaces. Allow Chrome's sandbox on that machine, or turn it off with `bb plugin config html set chromeNoSandbox true`.";
  }
  if (/error while loading shared libraries/i.test(output)) {
    return `Chrome is missing system libraries on the bb server: ${output.trim().split("\n").pop()}. Install them, for example with \`npx playwright install-deps chromium\`.`;
  }
  return undefined;
}
