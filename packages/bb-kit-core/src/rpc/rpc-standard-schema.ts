// ── Standard Schema v1 (vendored) ────────────────────────────────────

/**
 * Vendored Standard Schema v1 (https://standardschema.dev) — the
 * validator-neutral interface zod 4 schemas implement directly. A ~30-line
 * type interface, not a dependency (§1): bb-kit never depends on zod, and
 * the emitted declarations never reference SDK types (§7).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: PropertyKey | readonly (PropertyKey | { readonly key: PropertyKey })[];
}

/** The schema's declared input type — what a caller passes. */
export type SchemaInput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];

/** The schema's parsed output type — what validation produces. */
export type SchemaOutput<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["output"];

// ── No-input schema (vendored) ───────────────────────────────────────

/**
 * The vendored no-input schema (§3), registered with the host for
 * RPCs that declare no `input`. It accepts null (what the SDK
 * hooks and fake host deliver) and undefined (an empty POST body), and
 * rejects everything else.
 */
export const noInputSchema: StandardSchemaV1<null | undefined, null | undefined> = {
  "~standard": {
    version: 1,
    vendor: "bb-kit",
    validate(value) {
      if (value === null || value === undefined) {
        return { value };
      }
      return { issues: [{ message: "this RPC takes no input" }] };
    },
  },
};
