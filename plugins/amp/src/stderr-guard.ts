// stdout is the ACP JSON-RPC channel. Replace the global console with one
// bound entirely to stderr before any other module can log, so that every
// console method (log, dir, table, group, count, time*, ...) is safe and
// none can corrupt the stream. This module must stay the FIRST import of
// the bridge entry.
import { Console } from "node:console";

const errConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
// Keep the Console constructor property the global console carries.
(errConsole as unknown as { Console: typeof Console }).Console = Console;
globalThis.console = errConsole as unknown as typeof console;
