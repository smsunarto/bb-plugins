import { isPayloadTooLarge } from "./client.ts";

type ChangedFile = { path: string; previousPath?: string };

/**
 * Re-read a patch that was too large for one hop as per-path batches, halving
 * a batch until it fits, and concatenate the parts in the files' order
 * (design §3.1). A rename keeps both paths in one batch so it still reads as
 * a rename. Upstream byte budgets apply to the concatenated text, as before.
 * Call it only after a read of all `files` at once was too large.
 */
export async function concatenateByPaths(
  files: readonly ChangedFile[],
  read: (paths: string[]) => Promise<string>,
): Promise<string> {
  const units = files.map((file) =>
    file.previousPath && file.previousPath !== file.path
      ? [file.previousPath, file.path]
      : [file.path],
  );
  if (!units.length)
    throw Object.assign(
      new Error("whiteboard: the patch is above the host transfer limit and lists no files."),
      { name: "PayloadTooLarge" },
    );
  const parts: string[] = [];
  // The caller's read of the whole set already failed, so start by halving it.
  const split = async (group: string[][]): Promise<void> => {
    if (group.length === 1)
      throw Object.assign(
        new Error(
          `whiteboard: the patch for ${group[0]!.at(-1)} alone is above the host transfer limit.`,
        ),
        { name: "PayloadTooLarge" },
      );
    const middle = Math.ceil(group.length / 2);
    await readGroup(group.slice(0, middle));
    await readGroup(group.slice(middle));
  };
  const readGroup = async (group: string[][]): Promise<void> => {
    try {
      parts.push(await read(group.flat()));
    } catch (error) {
      if (!isPayloadTooLarge(error)) throw error;
      await split(group);
    }
  };
  await split(units);
  return parts.join("");
}
