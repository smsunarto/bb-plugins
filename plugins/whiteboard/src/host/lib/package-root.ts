import { existsSync } from "node:fs";
import path from "node:path";
import { findPackageRoot } from "../../shared/node/vendor/generated/trace-core-index.ts";

/** Where Whiteboard Desktop installs its runtime, which carries `bin/diffr`. */
export const WHITEBOARD_APP_RUNTIMES = [
  "/Applications/Whiteboard.app/Contents/Resources/app/review-runtime",
  path.join(
    process.env.HOME ?? "/nonexistent",
    "Applications/Whiteboard.app/Contents/Resources/app/review-runtime",
  ),
] as const;

/**
 * Host replacement for upstream `findReviewPackageRoot` (design §1.6). The
 * installed Whiteboard runtime when it carries a diffr binary, otherwise the
 * plugin root (`<root>/dist/host.js` or `<root>/src/host/...`). Upstream
 * `diffrExecutable` then checks `REVIEW_DIFFR_BINARY`, `<root>/bin/diffr` and
 * `diffr` on PATH, in that order.
 */
export function findReviewPackageRoot(
  moduleUrl: string = import.meta.url,
  runtimes: readonly string[] = WHITEBOARD_APP_RUNTIMES,
): string {
  const executable = process.platform === "win32" ? "diffr.exe" : "diffr";
  const runtime = runtimes.find((root) => existsSync(path.join(root, "bin", executable)));
  return runtime ?? findPackageRoot(moduleUrl);
}
