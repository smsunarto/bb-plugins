import {
  parseDiffFromFile,
  processFile,
  type FileContents,
  type FileDiffMetadata,
} from "./diffs-lib.ts";

const languageOverrides: Readonly<Record<string, string>> = {
  ".gitconfig": "ini",
};

function languageFor(path: string): string | undefined {
  return languageOverrides[path.split("/").at(-1) ?? ""];
}

export function contentKey(content: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${content.length}:${hash >>> 0}`;
}

export function buildDiff(
  path: string,
  headContent: string | null,
  workingContent: string,
): FileDiffMetadata | null {
  const language = languageFor(path);
  const workingKey = contentKey(workingContent);
  const newFile: FileContents = {
    name: path,
    contents: workingContent,
    cacheKey: `${path}:working:${workingKey}`,
    ...(language ? { lang: language } : {}),
  };
  if (headContent === null) return parseDiffFromFile(null, newFile);

  const oldFile: FileContents = {
    name: path,
    contents: headContent,
    cacheKey: `${path}:head:${contentKey(headContent)}`,
    ...(language ? { lang: language } : {}),
  };
  if (headContent !== workingContent) {
    return parseDiffFromFile(oldFile, newFile, { context: 1_000_000_000 });
  }

  let lines = workingContent.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines = lines.slice(0, -1);
  const count = lines.length;
  const patch =
    `--- ${path}\n+++ ${path}\n@@ -1,${count} +1,${count} @@\n` +
    `${lines.map((line) => ` ${line}`).join("\n")}\n`;
  const metadata =
    processFile(patch, {
      cacheKey: `${path}:unchanged:${workingKey}`,
      oldFile,
      newFile,
    }) ?? null;
  if (metadata && language) metadata.lang = language;
  return metadata;
}

export type { FileContents, FileDiffMetadata };
