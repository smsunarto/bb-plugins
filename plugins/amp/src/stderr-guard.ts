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
  globalThis.console = errConsole as unknown as typeof console;
}
