import { createTwoFilesPatch } from "diff";
import type { DiffProps } from "@get-bb/plugin-sdk/app";

export function buildDiff(
  path: string,
  headContent: string | null,
  workingContent: string,
): Pick<DiffProps, "patch" | "experimental_fullFileContents"> | null {
  if (headContent === workingContent) return null;
  const oldPath = headContent === null ? "/dev/null" : path;
  return {
    patch: createTwoFilesPatch(oldPath, path, headContent ?? "", workingContent),
    experimental_fullFileContents: {
      old: { path: oldPath, content: headContent ?? "" },
      new: { path, content: workingContent },
    },
  };
}
