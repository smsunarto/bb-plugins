// The bb host runtime-shims "@pierre/diffs" and "@pierre/diffs/react", but its
// shim whitelist predates the edit surface (no EditProvider/Editor). Import
// through relative paths so esbuild bundles the full local 1.3.x copy instead
// of the shim. React stays shimmed to the host runtime, so context and
// reconciler are still shared. Keep every diffs import in this file: mixing
// shimmed and bundled copies would split their internal state.
//
// The paths reach the workspace root because this is a Bun monorepo and
// bunfig.toml pins the hoisted linker, so @pierre/diffs installs once at
// <repo>/node_modules instead of per plugin.
export {
  parseDiffFromFile,
  processFile,
  type FileContents,
  type FileDiffMetadata,
} from "../../node_modules/@pierre/diffs/dist/index.js";
export {
  EditProvider,
  FileDiff,
} from "../../node_modules/@pierre/diffs/dist/react/index.js";
export {
  Editor,
  type EditorOptions,
} from "../../node_modules/@pierre/diffs/dist/edit/index.js";
