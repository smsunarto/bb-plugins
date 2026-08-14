// BB runtime-shims these two public imports to one host-owned Pierre runtime.
// Keep them together: mixing host-shimmed rendering with a separately bundled
// edit runtime splits Pierre's internal state. The text editor is plugin-owned.
export {
  parseDiffFromFile,
  processFile,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
export {
  FileDiff,
} from "@pierre/diffs/react";
