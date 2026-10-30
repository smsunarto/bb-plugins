import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../../shared/json/index.ts";
import { readBlockFixtures } from "../../shared/review/fixtures/blocks/fixtures.ts";
import { whiteboardTools } from "./catalog.ts";
import { CUT_DESCRIPTION, flattenSchema, UNROLL_LEVELS } from "./flatten-schema.ts";

const tools = whiteboardTools(false);
const tool = (name: string) => tools.find((entry) => entry.name === name)!;
/** A tool's zod schema as JSON Schema, recursion and all. */
const raw = (name: string) => z.toJSONSchema(tool(name).schema, { io: "input" }) as JsonObject;
const advertised = (name: string) => tool(name).advertised!;
const RECURSIVE = ["whiteboard_session_edit", "whiteboard_session_upload"];

const register = (name: string, parameters: JsonObject) => {
  const host = createFakePluginHost({ pluginId: "whiteboard" });
  host.bb.agents.registerTool({ name, description: "x", parameters, execute: () => "" });
};

const bytes = (value: JsonValue) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("bb's recursive-$ref rule", () => {
  test("only session_edit and session_upload advertise flattened JSON Schema", () => {
    expect(tools.filter((entry) => entry.advertised).map((entry) => entry.name)).toEqual(RECURSIVE);
  });

  test("bb refuses their zod schemas' JSON as it is", () => {
    for (const name of RECURSIVE)
      expect(() => register(name, raw(name))).toThrow(/recursive JSON Schema \$ref/);
  });

  test.each(RECURSIVE)("bb accepts the flattened %s schema, whose root is an object", (name) => {
    expect(() => register(name, advertised(name))).not.toThrow();
    expect(advertised(name).type).toBe("object");
  });
});

/**
 * Inline every `$ref`. `cutAt(def, depth)` decides when a recursive def stops
 * expanding: the depth is how many times that def is already open on the path.
 */
function expand(
  schema: JsonObject,
  cutAt: (def: string, depth: number) => JsonValue | undefined,
): JsonValue {
  const defs = (schema.$defs ?? {}) as JsonObject;
  const walk = (node: JsonValue, open: string[]): JsonValue => {
    if (Array.isArray(node)) return node.map((item) => walk(item, open));
    if (node === null || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const name = node.$ref.slice("#/$defs/".length);
      const cut = cutAt(name, open.filter((entry) => entry === name).length);
      return cut ?? walk(defs[name]!, [...open, name]);
    }
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node))
      if (key !== "$defs") out[key] = walk(value, open);
    return out;
  };
  return walk(schema, []);
}

const JSON_VALUE_DEFS: Record<string, string[]> = {
  whiteboard_session_edit: ["__schema2", "__schema3"],
  whiteboard_session_upload: [],
};

describe("flattening changes the zod schemas only at the cut points", () => {
  test.each(RECURSIVE)(
    "%s: fully inlined, the flattened schema equals the zod schema cut at the same depth",
    (name) => {
      const jsonDefs = JSON_VALUE_DEFS[name]!;
      const cutAtDepth = expand(raw(name), (def, depth): JsonValue | undefined => {
        if (jsonDefs.includes(def)) return depth >= 1 ? {} : undefined;
        return depth > UNROLL_LEVELS ? { type: "object", description: CUT_DESCRIPTION } : undefined;
      });
      const ours = expand(advertised(name), (_def, depth) => {
        // Flattened schemas are acyclic: nothing should ever re-enter a def.
        if (depth > 0) throw new Error(`flattened ${name} still recurses`);
        return undefined;
      });
      // bb needs a root object, so flattening types a root union as one.
      expect(ours).toEqual({ ...(cutAtDepth as JsonObject), type: "object" });
    },
  );

  test("JSON values (update.changes, field examples) still accept any JSON", () => {
    const defs = advertised("whiteboard_session_edit").$defs as JsonObject;
    expect(defs.__schema2).toEqual({
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: {} },
        { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
      ],
    });
  });

  test("the block union keeps three levels; level 3 children are cut objects", () => {
    const defs = advertised("whiteboard_session_edit").$defs as JsonObject;
    const children = (def: string) =>
      ((defs[def] as { anyOf: JsonObject[] }).anyOf[1]!.properties as JsonObject).children;
    expect(children("__schema0")).toEqual({
      type: "array",
      items: { $ref: "#/$defs/__schema0_depth1" },
    });
    expect(children("__schema0_depth1")).toEqual({
      type: "array",
      items: { $ref: "#/$defs/__schema0_depth2" },
    });
    expect(children("__schema0_depth2")).toEqual({
      type: "array",
      items: { type: "object", description: CUT_DESCRIPTION },
    });
  });
});

describe("every block fixture validates against the advertised session_edit schema", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  const validate = ajv.compile(advertised("whiteboard_session_edit"));
  const insert = (content: JsonValue) => ({
    sessionId: "session-1",
    commandId: "6f1c1c3e-3b2a-4c55-9a9e-6c2f1a3b4d5e",
    edit: { type: "insert", content },
  });
  const fixtures = await readBlockFixtures();

  test("there are 14 block kinds", () => {
    expect([...fixtures.keys()]).toEqual([
      "call_stack_diff",
      "callout",
      "code",
      "code_peek",
      "database_lens",
      "divider",
      "flow_diagram",
      "image",
      "markdown",
      "section",
      "sequence",
      "software_map",
      "trace_quote",
      "tutorial",
    ]);
  });

  test.each(
    [...fixtures].flatMap(([kind, blocks]) =>
      blocks.map((block, index) => [kind, index, block] as const),
    ),
  )("%s fixture %i", (_kind, _index, block) => {
    expect(validate(insert(block)), JSON.stringify(validate.errors)).toBe(true);
  });

  const markdown = { type: "markdown", markdown: "Hi" };
  const section = (children: JsonValue[]) => ({ type: "section", title: "S", children });

  test("children keep their shape two levels down", () => {
    expect(validate(insert(section([section([markdown])])))).toBe(true);
    expect(validate(insert(section([section([{ type: "markdown", text: "wrong key" }])])))).toBe(
      false,
    );
  });

  test("below the cut, children are only required to be objects", () => {
    const deep = (child: JsonValue) => insert(section([section([section([child])])]));
    expect(validate(deep({ type: "markdown", text: "not checked here" }))).toBe(true);
    expect(validate(deep("not an object"))).toBe(false);
  });
});

describe("schema size", () => {
  // bb sets no size limit on a registered tool's raw parameters (only on
  // configure() overrides, 128 KiB), so the 197 KB session_upload schema
  // stays whole.
  test("flattening adds at most 5 KiB to session_edit and 2 KiB to session_upload", () => {
    expect(
      bytes(advertised("whiteboard_session_edit")) - bytes(raw("whiteboard_session_edit")),
    ).toBeLessThanOrEqual(5 * 1024);
    expect(
      bytes(advertised("whiteboard_session_upload")) - bytes(raw("whiteboard_session_upload")),
    ).toBeLessThanOrEqual(2 * 1024);
  });

  test("every schema but session_upload is under 64 KiB", () => {
    const large = tools
      .filter((entry) => bytes(entry.advertised ?? raw(entry.name)) >= 64 * 1024)
      .map((entry) => entry.name);
    expect(large).toEqual(["whiteboard_session_upload"]);
  });
});

describe("flattenSchema on its own", () => {
  test("forces a root type of object and keeps a root union under it", () => {
    expect(
      flattenSchema({ oneOf: [{ type: "object" }, { type: "object", required: ["a"] }] }),
    ).toEqual({ oneOf: [{ type: "object" }, { type: "object", required: ["a"] }], type: "object" });
  });

  test("cuts a cycle through two defs, leaving the rest unchanged", () => {
    const flattened = flattenSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
      },
    });
    expect(flattened).toEqual({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { type: "object", properties: { a: { type: "object", description: CUT_DESCRIPTION } } },
      },
    });
    expect(() => register("cycle", flattened)).not.toThrow();
  });
});
