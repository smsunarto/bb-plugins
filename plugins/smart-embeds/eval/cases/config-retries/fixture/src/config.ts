import { fields, type FieldSpec } from "./fields.ts";

export type Protocol = "http" | "https";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  host: string;
  port: number;
  protocol?: Protocol;
  timeoutMs?: number;
  logLevel?: LogLevel;
  allowedOrigins?: string[];
  verifyTls?: boolean;
}

export type ValidationResult = { ok: true; config: Config } | { ok: false; errors: string[] };

export function validateConfig(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["config must be an object"] };
  }

  const source = input as Record<string, unknown>;
  const errors: string[] = [];
  const declared = new Set(fields.map((field) => field.name));

  for (const key of Object.keys(source)) {
    if (!declared.has(key)) errors.push(`unknown field "${key}"`);
  }

  const accepted: Record<string, unknown> = {};

  for (const field of fields) {
    const value = source[field.name];

    if (value === undefined) {
      if (field.required) errors.push(`missing required field "${field.name}"`);
      else if (field.default !== undefined) accepted[field.name] = copyDefault(field.default);
      continue;
    }

    const problem = checkField(field, value);
    if (problem) errors.push(problem);
    else accepted[field.name] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: accepted as unknown as Config };
}

export function loadConfig(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`config is not valid JSON: ${(error as Error).message}`] };
  }
  return validateConfig(parsed);
}

export function describeConfig(config: Config): string {
  const protocol = config.protocol ?? "https";
  return `${protocol}://${config.host}:${config.port}`;
}

function checkField(field: FieldSpec, value: unknown): string | null {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return `"${field.name}" must be a string`;
      if (field.values && !field.values.includes(value)) {
        return `"${field.name}" must be one of ${field.values.join(", ")}`;
      }
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `"${field.name}" must be a number`;
      }
      if (field.integer && !Number.isInteger(value)) {
        return `"${field.name}" must be a whole number`;
      }
      if (field.min !== undefined && value < field.min) {
        return `"${field.name}" must be at least ${field.min}`;
      }
      if (field.max !== undefined && value > field.max) {
        return `"${field.name}" must be at most ${field.max}`;
      }
      return null;
    }
    case "boolean": {
      if (typeof value !== "boolean") return `"${field.name}" must be true or false`;
      return null;
    }
    case "string[]": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return `"${field.name}" must be an array of strings`;
      }
      return null;
    }
  }
}

/** Defaults are shared across calls, so array defaults are handed out by copy. */
function copyDefault(value: NonNullable<FieldSpec["default"]>): unknown {
  return Array.isArray(value) ? [...value] : value;
}
