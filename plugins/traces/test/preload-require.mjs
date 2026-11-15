// @get-bb/plugin-sdk >= 0.4.50 ships dist/host.js with cross-spawn bundled as
// CommonJS behind an esbuild `__require` shim. bb's plugin build injects a
// createRequire banner, so the runtime is fine, but plain Node ESM (this test
// runner) has no `require` and the shim throws at import time. Define one.
import { createRequire, register } from "node:module";
globalThis.require ??= createRequire(import.meta.url);

// Shared UI primitives import their stylesheet for its side effect, which bb's
// bundler handles and plain Node ESM rejects. Load .css as an empty module.
register(
  "data:text/javascript,export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
);
