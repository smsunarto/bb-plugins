/**
 * Vendored Standard Schema v1 (https://standardschema.dev) — the
 * validator-neutral interface zod 4 schemas implement directly. A ~30-line
 * type interface, not a dependency (§1): bb-kit never depends on zod, and
 * the emitted declarations never reference SDK types (§6).
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
