// Home-relative paths for a setting that two different hosts must both honour.
//
// A review thread's worktree can be provisioned on a different machine than the
// one running the plugin backend, and those machines rarely share a home
// directory — `/home/sawyer` on the server, `/Users/sawyerhood` on a laptop. An
// absolute `botGhPath` can therefore only ever be right on one of them.
//
// A tilde path is right on both. The agent runs the command through a shell,
// which expands it on whichever host the agent landed on; the backend calls
// `execFile`, which does not expand anything, so it expands the value itself.
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~/` only. A bare `~`, a `~user` form, or any path that
 * merely contains a tilde is returned untouched — guessing at another user's
 * home would resolve a bot wrapper to somewhere its owner never put it.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (!path.startsWith("~/")) return path;
  return join(home, path.slice(2));
}
