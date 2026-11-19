// Local (bb-plugins): a mirror of the one Source Control read GenUI uses,
// `statusForThread` (plugin id "source-control"): each thread's Change as a
// small row, keyed by thread id. Watching it from the app makes Source
// Control read a thread it hasn't read lately; its rows are parsed leniently
// in core/sourceControl.ts, so this mirror checks nothing and pulls no zod
// into the app bundle.
import { defineRpcContract, type StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { threadTag } from "./core/sourceControl";

/** Passes the value through; core/sourceControl.ts parses what it reads. */
function unchecked<T>(): StandardSchemaV1<T, T> {
  return {
    "~standard": { version: 1, vendor: "genui", validate: (value) => ({ value: value as T }) },
  };
}

export const sourceControlContract = defineRpcContract({
  statusForThread: {
    input: unchecked<{ keys: string[] }>(),
    output: unchecked<Record<string, unknown>>(),
    keyTags: (key: string) => [threadTag(key)],
  },
});
