import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// The bridge ships no bundled Amp CLI: the SDK must resolve the binary from
// AMP_CLI_PATH, set by the managed provider entry. This matters more than it
// looks, because @ampcode/sdk's findAmpCommand() checks its own bundled
// @ampcode/cli FIRST and only falls back to AMP_CLI_PATH:
//
//   const localAmpCommand = resolveLocalAmpPackageCommand();  // @ampcode/cli
//   if (localAmpCommand) return localAmpCommand;
//   for (const resolver of [resolveCliFromEnvironment, ...])  // AMP_CLI_PATH
//
// So a real @ampcode/cli silently outranks the CLI this plugin provisions, and
// the bridge would drive a different Amp build than the user configured. The
// workspace root overrides it with vendor/ampcode-cli-stub, which declares no
// bin.amp -- resolveLocalAmpPackageCommand() returns null and AMP_CLI_PATH
// wins. It also keeps the ~69MiB @ampcode/cli-<platform> binary out of the
// install.
//
// That override has two sharp edges, and both fail silently at install time:
// Bun only honours overrides declared in the workspace root, and it ignores
// scoped/nested override syntax. Either mistake just pulls the real CLI. These
// tests turn that into a loud failure.
//
// @ampcode/cli is a dependency of @ampcode/sdk, not of this plugin, so under
// Bun's isolated linker it is only reachable from inside the SDK. Resolve it
// the way the SDK does rather than from this file.
// The SDK is ESM-only and its `exports` map does not expose ./package.json, so
// resolve its main entry with import.meta.resolve (ESM conditions) and anchor a
// require on that file -- it still sits inside the SDK directory.
const requireFromSdk = createRequire(import.meta.resolve("@ampcode/sdk"));

function stubManifest() {
  return requireFromSdk("@ampcode/cli/package.json") as {
    name: string;
    version: string;
    bin?: unknown;
    optionalDependencies?: Record<string, string>;
  };
}

test("@ampcode/sdk resolves @ampcode/cli to the vendored stub", () => {
  const manifest = stubManifest();

  assert.equal(manifest.name, "@ampcode/cli");
  assert.equal(
    manifest.version,
    "0.0.0-stub",
    "@ampcode/sdk resolved the real @ampcode/cli. The workspace-root " +
      "`overrides` entry in the top-level package.json is missing, was moved " +
      "into a leaf package.json, or was written with scoped/nested syntax -- " +
      "Bun honours none of those. Restore the flat root override and reinstall.",
  );
});

test("the stub carries no platform binary payload", () => {
  const manifest = stubManifest();

  assert.equal(manifest.bin, undefined, "stub must not expose a bin entry");
  assert.deepEqual(
    Object.keys(manifest.optionalDependencies ?? {}),
    [],
    "stub must not pull @ampcode/cli-<platform> binaries",
  );
});
