import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * The vendored no-input schema (§3), registered with the host for
 * procedures that declare no `input`. It accepts null (what the SDK
 * hooks and fake host deliver) and undefined (an empty POST body), and
 * rejects everything else. Internal — never exported from `./rpc`.
 */
export const noInputSchema: StandardSchemaV1<null | undefined, null | undefined> = {
  "~standard": {
    version: 1,
    vendor: "bb-kit",
    validate(value) {
      if (value === null || value === undefined) {
        return { value };
      }
      return { issues: [{ message: "this procedure takes no input" }] };
    },
  },
};
