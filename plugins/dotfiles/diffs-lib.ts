// The bb host runtime-shims "@pierre/diffs" and "@pierre/diffs/react", but its
// shim whitelist predates the edit surface (no EditProvider/Editor). This
// plugin therefore depends on the package under the alias "pierre-diffs"
// (see package.json), which the whitelist does not match, so esbuild bundles
// the full local 1.3.x copy. React stays shimmed to the host runtime, so
// context and reconciler are still shared. Keep every diffs import in this
// file: mixing shimmed and bundled copies would split their internal state.
export {
  parseDiffFromFile,
  processFile,
  type FileContents,
  type FileDiffMetadata,
} from "pierre-diffs";
export { EditProvider, FileDiff } from "pierre-diffs/react";
export { Editor, type EditorOptions } from "pierre-diffs/edit";
