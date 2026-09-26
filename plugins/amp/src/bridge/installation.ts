/**
 * `src/bridge/installation.ts` — `provider/installation/status` and `/run`.
 *
 * bb asks these when the declaration sets `maintenance.installation`; a
 * `not installed` answer is what puts the composer's Install banner up. The
 * install itself is Amp's documented one (https://ampcode.com/docs/cli):
 * the install.sh script, which puts the binary in `~/.amp/bin` and links it
 * onto PATH. That script is bash only, so Windows gets no action: Amp runs
 * there through WSL, installed inside WSL.
 *
 * There is no Update action. Amp updates itself in the background, and the
 * bridge pins no minimum Amp version.
 */
import {
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_installationVerification as installationVerification,
  experimental_readCliVersion as readCliVersion,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
} from "@get-bb/plugin-sdk/provider-bridge";

export const AMP_INSTALL_SCRIPT_URL = "https://ampcode.com/install.sh";

const WINDOWS_MESSAGE =
  "Amp runs on Windows through WSL. Install it inside WSL with Amp's install script.";

function installerSupported(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/** The shell line the Install button runs, shown to the user verbatim. */
export function ampInstallDisplayCommand(): string {
  return downloadedInstallerCommand(AMP_INSTALL_SCRIPT_URL).displayCommand;
}

/**
 * `cliPath` is the Amp CLI resolved the way sessions resolve it
 * (`resolveAmpCliLaunch`), or null when none was found. The SDK's
 * `resolveExecutablePath` is `which` on the daemon's PATH, which misses the
 * installer's `~/.amp/bin` under a GUI-launched daemon's minimal PATH.
 */
export async function getAmpInstallationStatus(
  cliPath: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<ProviderInstallationStatus> {
  const installed = cliPath !== null;
  const canInstall = !installed && installerSupported(platform);
  return {
    executableName: "amp",
    executablePath: cliPath,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion: installed ? await readCliVersion(cliPath) : null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: canInstall
      ? { kind: "install", label: "Install", command: ampInstallDisplayCommand() }
      : null,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

export async function runAmpInstallation(
  cliPath: string | null,
  action: "install" | "update",
  platform: NodeJS.Platform = process.platform,
): Promise<ProviderInstallationRunResult> {
  if (!installerSupported(platform)) return { available: false, message: WINDOWS_MESSAGE };
  const status = await getAmpInstallationStatus(cliPath, platform);
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message:
        action === "update"
          ? "Amp updates itself in the background; restart Amp threads to pick up a new version."
          : "Amp is already installed on this host.",
    };
  }
  return {
    available: true,
    command: downloadedInstallerCommand(AMP_INSTALL_SCRIPT_URL),
    verification: installationVerification(status, action),
  };
}
