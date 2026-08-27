// The SDK ships ESM-only bundles; dist/provider-bridge.js carries esbuild's
// dynamic-require shim for its bundled cross-spawn dependency, which throws
// under plain Node ESM (the bridge runtime never sees this: dist/host.js is
// bundled). Defining a global require before that module evaluates satisfies
// the shim's `typeof require !== "undefined"` guard.
import { createRequire } from "node:module";

const globals = globalThis as { require?: unknown };
if (typeof globals.require === "undefined") {
  globals.require = createRequire(import.meta.url);
}
