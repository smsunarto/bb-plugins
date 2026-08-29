/**
 * `src/bridge/maintenance.ts` — health and installation, without a session.
 *
 * Both answers are one short child invocation each, so there is no pooling and
 * no cached connection: the machinery provider-codex needs to amortize
 * app-server startup has nothing to amortize here.
 */

import { execFile } from "node:child_process";
import {
  experimental_compareVersions as compareVersions,
  experimental_formatCommand as formatCommand,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import { MINIMUM_NANOCODEX_VERSION } from "../catalog.ts";

const AUTH_PROBE_TIMEOUT_MS = 10_000;

interface AuthProbe {
  readonly ok: boolean;
  readonly stdout: string;
}

function authStatus(command: string): Promise<AuthProbe> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["auth", "status"],
      { timeout: AUTH_PROBE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        resolve({ ok: error === null, stdout: stdout ?? "" });
      },
    );
  });
}

/** `Email: a@b.c` / `Plan: Pro` lines from `nanocodex auth status` stdout. */
function labeledLine(stdout: string, label: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(`${label.toLowerCase()}:`)) {
      const value = trimmed.slice(label.length + 1).trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

/**
 * Health, in probe order — cheapest disqualifier first.
 *
 *   `experimental_resolveExecutablePath` miss           -> not_installed
 *   `experimental_readCliVersion` below 0.5.0           -> unsupported_version
 *   `nanocodex auth status` exit 0                      -> ready, parsing the
 *       labeled stdout lines (`Email: ...`, `Plan: ...`)
 *   exit 1                                              -> unauthenticated
 *
 * `nanocodex auth status` is the cheapest reliable signed-in probe. Two traps
 * it carries:
 *
 *  - A present-but-CORRUPT `$CODEX_HOME/auth.json` fails auth even when
 *    `OPENAI_API_KEY` is set, because auth precedence stops at an existing
 *    default auth file and does not fall through. The `unauthenticated`
 *    message therefore names the file, not just the login step.
 *  - CODEX_HOME defaults to `~/.codex`, SHARED with Codex including
 *    `auth.json`. A user already signed in to Codex is already signed in here,
 *    and `codex login` genuinely repairs this provider.
 *
 * `loginCommand` is left null until the v0.5.0 `auth` subcommands beyond
 * `auth status` are enumerated on a real install. A wrong command in a
 * user-facing hint is worse than no command; `strings.installUrl` covers the
 * gap. See the open questions in rationale.md.
 */
export async function probeHealth(args: { command: string | null }): Promise<ProviderHealthResult> {
  const base = {
    accountEmail: null,
    canInstall: false,
    canUpdate: false,
    installedVersion: null,
    loginCommand: null,
    minimumSupportedVersion: MINIMUM_NANOCODEX_VERSION,
    planLabel: null,
    statusMessage: null,
  };
  const resolved = args.command === null ? null : await resolveExecutablePath(args.command);
  if (resolved === null) {
    return {
      supported: true,
      health: {
        ...base,
        status: "not_installed",
        statusMessage: "The nanocodex CLI was not found on this host.",
      },
    };
  }
  const installedVersion = versionFrom(await readCliVersion(resolved));
  if (installedVersion !== null && compareVersions(installedVersion, MINIMUM_NANOCODEX_VERSION) < 0) {
    return {
      supported: true,
      health: {
        ...base,
        canUpdate: true,
        installedVersion,
        status: "unsupported_version",
        statusMessage: `nanocodex ${installedVersion} is below the minimum ${MINIMUM_NANOCODEX_VERSION}; run \`nanocodex update\`.`,
      },
    };
  }
  const auth = await authStatus(resolved);
  if (!auth.ok) {
    return {
      supported: true,
      health: {
        ...base,
        canUpdate: true,
        installedVersion,
        status: "unauthenticated",
        statusMessage:
          "nanocodex is not signed in. It shares ~/.codex/auth.json with Codex, so `codex login` also signs it in; a corrupt auth.json fails auth even with OPENAI_API_KEY set.",
      },
    };
  }
  return {
    supported: true,
    health: {
      ...base,
      accountEmail: labeledLine(auth.stdout, "Email"),
      canUpdate: true,
      installedVersion,
      planLabel: labeledLine(auth.stdout, "Plan"),
      status: "ready",
    },
  };
}

/**
 * Installation status. `installSource: "external"` — nanocodex is not on npm
 * (it installs under `~/.local/share/nanocodex/bin`), so there is nothing for
 * the npm helpers to probe.
 */
export async function probeInstallation(args: { command: string | null }): Promise<ProviderInstallationStatus> {
  const resolved = args.command === null ? null : await resolveExecutablePath(args.command);
  const currentVersion = resolved === null ? null : versionFrom(await readCliVersion(resolved));
  const versionUnsupported =
    currentVersion !== null && compareVersions(currentVersion, MINIMUM_NANOCODEX_VERSION) < 0;
  return {
    currentVersion,
    executableName: "nanocodex",
    executablePath: resolved,
    installAction:
      resolved === null
        ? null
        : { kind: "update", label: "Update", command: formatCommand(resolved, ["update"]) },
    installSource: resolved === null ? "notInstalled" : "external",
    installed: resolved !== null,
    latestVersion: null,
    minimumSupportedVersion: MINIMUM_NANOCODEX_VERSION,
    needsUpdate: versionUnsupported,
    npmGlobalPackageVersion: null,
    npmPackageName: null,
    versionUnsupported,
  };
}

/**
 * Run an installation action.
 *
 *   install -> {available: false, message}  (no scriptable installer)
 *   update  -> {available: true, command: {command: <resolved path>, args: ["update"]},
 *               verification: "version_changed"}  (`nanocodex update` exists)
 */
export async function runInstallation(args: {
  action: "install" | "update";
  command: string | null;
}): Promise<ProviderInstallationRunResult> {
  if (args.action === "install") {
    return {
      available: false,
      message:
        "nanocodex has no scriptable installer; install it manually, then set NANOCODEX_CLI_PATH if it is off PATH.",
    };
  }
  const resolved = args.command === null ? null : await resolveExecutablePath(args.command);
  if (resolved === null) {
    return { available: false, message: "The nanocodex CLI was not found, so there is nothing to update." };
  }
  const previousVersion = versionFrom(await readCliVersion(resolved));
  return {
    available: true,
    command: {
      command: resolved,
      args: ["update"],
      displayCommand: formatCommand(resolved, ["update"]),
    },
    verification:
      previousVersion === null ? { kind: "installed" } : { kind: "version_changed", previousVersion },
  };
}
