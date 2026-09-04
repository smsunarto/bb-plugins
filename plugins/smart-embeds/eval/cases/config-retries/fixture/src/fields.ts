export type FieldType = "string" | "number" | "boolean" | "string[]";

export interface FieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
  default?: string | number | boolean | readonly string[];
  /** Numbers only: rejects a fractional value and publishes as an integer. */
  integer?: boolean;
  min?: number;
  max?: number;
  /** Strings only: the closed set of accepted values. */
  values?: readonly string[];
}

/**
 * The field table is the one place a config field is declared. `validateConfig`
 * walks it at runtime and `scripts/gen.ts` turns it into schema.json, so a field
 * missing from here is neither checked nor published.
 */
export const fields: readonly FieldSpec[] = [
  {
    name: "host",
    type: "string",
    required: true,
    description: "Hostname the service binds to.",
  },
  {
    name: "port",
    type: "number",
    required: true,
    integer: true,
    min: 1,
    max: 65535,
    description: "TCP port the service binds to.",
  },
  {
    name: "protocol",
    type: "string",
    required: false,
    default: "https",
    values: ["http", "https"],
    description: "Scheme used when building absolute URLs.",
  },
  {
    name: "timeoutMs",
    type: "number",
    required: false,
    default: 5000,
    integer: true,
    min: 100,
    max: 120_000,
    description: "How long an upstream call may take before it is cut off.",
  },
  {
    name: "logLevel",
    type: "string",
    required: false,
    default: "info",
    values: ["debug", "info", "warn", "error"],
    description: "Lowest level written to the log stream.",
  },
  {
    name: "allowedOrigins",
    type: "string[]",
    required: false,
    default: [],
    description: "Origins the CORS handler accepts. Empty means same origin only.",
  },
  {
    name: "verifyTls",
    type: "boolean",
    required: false,
    default: true,
    description: "Whether upstream TLS certificates are checked.",
  },
];

export function findField(name: string): FieldSpec | undefined {
  return fields.find((field) => field.name === name);
}
