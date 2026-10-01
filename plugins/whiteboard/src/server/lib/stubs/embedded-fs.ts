import { readFile as readDiskFile } from "node:fs/promises";
import { INSTRUCTIONS } from "../vendor/generated/instructions.ts";
import { EMBEDDED_PACKAGE_ROOT } from "./package-paths.ts";

/**
 * The `node:fs/promises` surface `instructions.ts` uses (design §2.3 C).
 * `readFile("/whiteboard/instructions/<topic>.md", "utf8")` answers the
 * generated instruction text, so no runtime path resolution happens and a
 * path install and a packaged `dist/` behave the same. A path under that
 * virtual root with no topic fails like a missing file.
 *
 * Any other path reads the disk, as upstream does. The engine always passes
 * the virtual root; only callers that pass their own `root` to
 * `renderInstructions` (the vendored upstream spec) reach the disk.
 */
export async function readFile(path: string, encoding: BufferEncoding = "utf8"): Promise<string> {
  const prefix = `${EMBEDDED_PACKAGE_ROOT}/`;
  // `path.join` in instructions.ts uses backslashes on Windows.
  const posix = path.replaceAll("\\", "/");
  if (!posix.startsWith(prefix)) return readDiskFile(path, encoding);
  const topic = /^instructions\/([^/]+)\.md$/.exec(posix.slice(prefix.length))?.[1];
  const text =
    topic !== undefined && Object.hasOwn(INSTRUCTIONS, topic)
      ? (INSTRUCTIONS as Record<string, string>)[topic]
      : undefined;
  if (text === undefined) {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: "ENOENT",
    });
  }
  return text;
}
