import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from "./standard-schema.js";

export type OperationRisk = "safe" | "mutating" | "destructive";

export type OperationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OperationJsonValue[]
  | { readonly [key: string]: OperationJsonValue };

declare const noInputBrand: unique symbol;

type NoInputSchema = StandardSchemaV1<null, null> & {
  readonly [noInputBrand]: true;
};

export const noInput: NoInputSchema = Object.freeze({
  "~standard": Object.freeze({
    version: 1 as const,
    vendor: "bb-kit",
    validate(value: unknown) {
      return value === null ? { value: null } : { issues: [{ message: "expected no input" }] };
    },
    types: undefined as unknown as { readonly input: null; readonly output: null },
  }),
}) as unknown as NoInputSchema;

type OperationKind =
  | { readonly kind: "query" }
  | { readonly kind: "command"; readonly risk: OperationRisk };

type RequiredInputSchema = StandardSchemaV1 & {
  readonly [noInputBrand]?: never;
};

type OperationInput<Input extends StandardSchemaV1> = Input extends NoInputSchema
  ? {
      readonly input: NoInputSchema;
      readonly exampleInput?: never;
    }
  : {
      readonly input: Input & RequiredInputSchema;
      readonly exampleInput: SchemaInput<Input> & OperationJsonValue;
    };

export type OperationDescriptor<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1 = StandardSchemaV1,
> = OperationInput<Input> & {
  readonly output: Output;
} & OperationKind;

export type AnyOperationDescriptor = OperationKind & {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly exampleInput?: OperationJsonValue;
};

type DescriptorShape = OperationKind & {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
};

type ValidDescriptor<Descriptor extends DescriptorShape> = Descriptor["input"] extends NoInputSchema
  ? { readonly input: NoInputSchema; readonly exampleInput?: never }
  : {
      readonly input: Descriptor["input"] & RequiredInputSchema;
      readonly exampleInput: SchemaInput<Descriptor["input"]> & OperationJsonValue;
    };

export function defineOperation<const Descriptor extends DescriptorShape>(
  descriptor: Descriptor & ValidDescriptor<Descriptor>,
): Descriptor {
  assertSchema(descriptor.input, "operation input");
  assertSchema(descriptor.output, "operation output");
  if (descriptor.input === noInput) {
    if (Object.hasOwn(descriptor, "exampleInput")) {
      throw new TypeError("no-input operations must not declare exampleInput");
    }
  } else {
    if (!Object.hasOwn(descriptor, "exampleInput")) {
      throw new TypeError("required-input operations must declare exampleInput");
    }
    assertJsonValue(descriptor.exampleInput, "operation exampleInput", new Set());
  }
  return descriptor;
}

export interface OperationBinding<
  Identity extends string = string,
  WireMethod extends string = string,
  Descriptor extends AnyOperationDescriptor = AnyOperationDescriptor,
> {
  readonly identity: Identity;
  readonly wireMethod: WireMethod;
  readonly operation: Descriptor;
}

export type OperationBindings = Readonly<
  Record<string, OperationBinding<string, string, AnyOperationDescriptor>>
>;

export type BoundOperation<Binding extends OperationBinding> = Binding["operation"] & {
  readonly identity: Binding["identity"];
  readonly wireMethod: Binding["wireMethod"];
};

export interface RpcMethodContract<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly input: Input;
  readonly output: Output;
}

export type RpcContract = Readonly<Record<string, RpcMethodContract>>;

export type RpcHandlers<Contract extends RpcContract> = {
  [Method in keyof Contract]: (
    input: SchemaOutput<Contract[Method]["input"]>,
  ) => SchemaInput<Contract[Method]["output"]> | Promise<SchemaInput<Contract[Method]["output"]>>;
};

export interface OperationHost {
  readonly rpc: {
    /** Kept opaque so native bb's generic register method remains structural. */
    readonly register: unknown;
  };
}

export type RpcContractFor<Bindings extends OperationBindings> = {
  readonly [Key in keyof Bindings as Bindings[Key]["wireMethod"]]: {
    readonly input: Bindings[Key]["operation"]["input"];
    readonly output: Bindings[Key]["operation"]["output"];
  };
};

export type OperationHandlers<Bindings extends OperationBindings> = {
  readonly [Key in keyof Bindings]: (
    input: SchemaOutput<Bindings[Key]["operation"]["input"]>,
  ) =>
    | SchemaInput<Bindings[Key]["operation"]["output"]>
    | Promise<SchemaInput<Bindings[Key]["operation"]["output"]>>;
};

export type OperationCatalog<Bindings extends OperationBindings> = {
  readonly [Key in keyof Bindings]: BoundOperation<Bindings[Key]>;
} & {
  readonly rpcContract: RpcContractFor<Bindings>;
};

export type OperationHandlersFor<
  Catalog extends Record<string, unknown> & { readonly rpcContract: RpcContract },
> = {
  readonly [Key in Exclude<keyof Catalog, "rpcContract">]: Catalog[Key] extends {
    readonly input: infer Input extends StandardSchemaV1;
    readonly output: infer Output extends StandardSchemaV1;
  }
    ? (input: SchemaOutput<Input>) => SchemaInput<Output> | Promise<SchemaInput<Output>>
    : never;
};

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const RPC_METHOD_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_CATALOG_KEY = "rpcContract";

function assertSchema(value: unknown, label: string): asserts value is StandardSchemaV1 {
  if (typeof value !== "object" || value === null || !("~standard" in value)) {
    throw new TypeError(`${label} must implement Standard Schema v1`);
  }
  const standard = value["~standard"];
  if (
    typeof standard !== "object" ||
    standard === null ||
    !("version" in standard) ||
    standard.version !== 1 ||
    !("validate" in standard) ||
    typeof standard.validate !== "function"
  ) {
    throw new TypeError(`${label} must implement Standard Schema v1`);
  }
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): asserts value is OperationJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value !== "object") {
    throw new TypeError(`${label} must be finite, acyclic JSON`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} must be finite, acyclic JSON`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${label}[${index}]`, ancestors);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} must be finite, acyclic JSON`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${label}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/**
 * Bind path-derived operation identities to locked, bb-legal RPC methods.
 * Runtime checks deliberately duplicate generator checks so hand-authored
 * catalogs fail before bb sees a partial registration.
 */
export function defineOperationCatalog<const Bindings extends OperationBindings>(
  bindings: Bindings,
): OperationCatalog<Bindings> {
  const identities = new Set<string>();
  const methods = new Set<string>();
  const operations: Record<string, BoundOperation<OperationBinding>> = {};
  const rpcContract: Record<string, RpcMethodContract> = {};

  for (const [key, binding] of Object.entries(bindings)) {
    if (key === RESERVED_CATALOG_KEY) {
      throw new Error(`operation key "${RESERVED_CATALOG_KEY}" is reserved`);
    }
    if (!IDENTITY_PATTERN.test(binding.identity)) {
      throw new Error(`operation identity "${binding.identity}" must match module.operation`);
    }
    if (!RPC_METHOD_PATTERN.test(binding.wireMethod)) {
      throw new Error(`RPC method "${binding.wireMethod}" must match ${RPC_METHOD_PATTERN}`);
    }
    if (identities.has(binding.identity)) {
      throw new Error(`duplicate operation identity "${binding.identity}"`);
    }
    if (methods.has(binding.wireMethod)) {
      throw new Error(`duplicate RPC method "${binding.wireMethod}"`);
    }
    assertSchema(binding.operation.input, `${binding.identity} input`);
    assertSchema(binding.operation.output, `${binding.identity} output`);
    identities.add(binding.identity);
    methods.add(binding.wireMethod);

    operations[key] = {
      ...binding.operation,
      identity: binding.identity,
      wireMethod: binding.wireMethod,
    };
    rpcContract[binding.wireMethod] = {
      input: binding.operation.input,
      output: binding.operation.output,
    };
  }

  return Object.assign(operations, { rpcContract }) as OperationCatalog<Bindings>;
}

/** Register a catalog through bb's native Standard Schema RPC boundary. */
export function registerOperations<const Bindings extends OperationBindings>(
  host: OperationHost,
  catalog: OperationCatalog<Bindings>,
  handlers: OperationHandlers<Bindings>,
): void {
  if (typeof host.rpc.register !== "function") {
    throw new TypeError("operation host must provide rpc.register");
  }
  const rpcHandlers: Record<string, (input: unknown) => unknown> = {};
  const catalogKeys = Object.keys(catalog).filter((key) => key !== RESERVED_CATALOG_KEY);
  const handlerKeys = Object.keys(handlers);

  for (const key of handlerKeys) {
    if (!catalogKeys.includes(key)) {
      throw new Error(`handler "${key}" has no operation descriptor`);
    }
  }
  for (const key of catalogKeys) {
    const handler = handlers[key];
    if (typeof handler !== "function") {
      throw new Error(`operation "${key}" has no handler`);
    }
    const operation = catalog[key];
    if (operation === undefined) {
      throw new Error(`operation "${key}" is missing from its catalog`);
    }
    rpcHandlers[operation.wireMethod] = handler as (input: unknown) => unknown;
  }

  // The catalog construction above proves both maps have the same legal wire
  // keys. Keep the unavoidable host assertion private to this adapter: bb's
  // generic register signature cannot be structurally restated without making
  // the published operations declarations depend on the bb SDK package.
  const register = host.rpc.register as (
    contract: typeof catalog.rpcContract,
    registeredHandlers: RpcHandlers<typeof catalog.rpcContract>,
  ) => void;
  register(catalog.rpcContract, rpcHandlers as RpcHandlers<typeof catalog.rpcContract>);
}

export type {
  SchemaInput,
  SchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./standard-schema.js";
