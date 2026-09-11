// @get-bb/plugin-sdk >= 0.4.50 ships dist/host.js with cross-spawn bundled as
// CommonJS behind an esbuild `__require` shim. bb's plugin build injects a
// createRequire banner, so the runtime is fine, but Vitest evaluates the SDK
// as plain ESM with no `require` and the shim throws at import time.
import { createRequire } from "node:module";
globalThis.require ??= createRequire(import.meta.url);
