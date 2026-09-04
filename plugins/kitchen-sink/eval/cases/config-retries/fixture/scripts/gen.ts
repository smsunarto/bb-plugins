import { fields, type FieldSpec } from "../src/fields.ts";

const SCHEMA_URL = "http://json-schema.org/draft-07/schema#";
const SCHEMA_ID = "https://schemas.internal/config-schema/config.json";
const OUTPUT = new URL("../generated/schema.json", import.meta.url);

function propertyFor(field: FieldSpec): Record<string, unknown> {
  const property: Record<string, unknown> = {};

  switch (field.type) {
    case "string": {
      property.type = "string";
      if (field.values) property.enum = [...field.values];
      break;
    }
    case "number": {
      property.type = field.integer ? "integer" : "number";
      if (field.min !== undefined) property.minimum = field.min;
      if (field.max !== undefined) property.maximum = field.max;
      break;
    }
    case "boolean": {
      property.type = "boolean";
      break;
    }
    case "string[]": {
      property.type = "array";
      property.items = { type: "string" };
      break;
    }
  }

  property.description = field.description;
  if (field.default !== undefined) property.default = field.default;

  return property;
}

const schema = {
  $schema: SCHEMA_URL,
  $id: SCHEMA_ID,
  title: "Config",
  description: "Runtime configuration for the service.",
  type: "object",
  additionalProperties: false,
  required: fields.filter((field) => field.required).map((field) => field.name),
  properties: Object.fromEntries(fields.map((field) => [field.name, propertyFor(field)])),
};

await Bun.write(OUTPUT, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`generated/schema.json written from ${fields.length} fields`);
