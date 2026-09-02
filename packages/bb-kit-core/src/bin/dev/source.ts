import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DevError } from "./error.ts";
import { expandHome } from "./model.ts";
import { runCommand } from "./process.ts";

export function resolveAttachedCheckout(input: string, cwd: string): string {
  const requested = resolve(cwd, expandHome(input));
  let checkoutPath: string;
  try {
    checkoutPath = realpathSync(requested);
  } catch {
    invalidAttach(`Attached checkout "${input}" does not exist.`);
  }
  if (!existsSync(join(checkoutPath, ".git"))) {
    invalidAttach(`Attached checkout ${checkoutPath} is not a Git checkout.`);
  }
  const root = runCommand("git", ["-C", checkoutPath, "rev-parse", "--show-toplevel"]);
  if (root.status !== 0 || realpathOrNull(root.stdout.trim()) !== checkoutPath) {
    invalidAttach(`Attached checkout ${checkoutPath} is not its Git workspace root.`);
  }
  const launcher = join(checkoutPath, "scripts", "bb-dev-app");
  if (!existsSync(launcher)) {
    invalidAttach(`Attached checkout ${checkoutPath} has no scripts/bb-dev-app.`);
  }
  return checkoutPath;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function invalidAttach(message: string): never {
  throw new DevError(
    "invalid_attach",
    message,
    "Pass the path to an existing bb checkout with scripts/bb-dev-app.",
  );
}
