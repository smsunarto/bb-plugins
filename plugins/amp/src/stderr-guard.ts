// stdout is the bridge's JSON-RPC channel. Rebind the global console entirely
// to stderr so that every console method (log, dir, table, group, count,
// time*, ...) is safe and none can corrupt the stream. The bridge entry calls
// this from start(), before any Amp code runs; importing this module does
// nothing on its own, so tests that import the entry keep their console.
import { Console } from "node:console";

export function installStderrGuard(): void {
  const errConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
  // Keep the Console constructor property the global console carries.
  (errConsole as unknown as { Console: typeof Console }).Console = Console;
  // node:console lacks some of the runtime's methods (timeStamp, profile, write, ...).
  // Code that saw them before the swap still calls them (React's dev build checks
  // timeStamp once at load), so keep each as a no-op instead of a TypeError.
  const guarded = errConsole as unknown as Record<string, unknown>;
  for (const [name, method] of Object.entries(globalThis.console)) {
    if (typeof method === "function" && typeof guarded[name] !== "function") {
      guarded[name] = () => {};
    }
  }
  globalThis.console = errConsole as unknown as typeof console;
}
