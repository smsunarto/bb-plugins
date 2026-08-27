import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { assertToolKeys, defineTool, runtimeTools, TOOL_KEY_PATTERN, toolName } from "./tools.ts";
import type { AnyTool, ToolContext, ToolInvocation, ToolMap, ToolsContext } from "./tools.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Ctx = { prefix: string };
type Fs = { root: string };

const user = defineTool({
  description: "Post a notification",
  instructions: "One line the user will act on.",
  presentation: { label: { pending: "Notifying", completed: "Notified" } },
  parameters: z.object({ message: z.string() }),
  execute(context: ToolContext<Ctx>, input) {
    return `${context.prefix}${input.message}`;
  },
});

const snapshot = defineTool({
  description: "Read a path",
  parameters: z.object({ path: z.string() }),
  execute(context: ToolContext<Fs>, input) {
    return context.root + input.path;
  },
});

const gated = defineTool({
  description: "Gated by an enabled predicate",
  parameters: z.object({}),
  enabled: (context: Ctx) => context.prefix.length > 0,
  execute: () => "ran",
});

const plain = defineTool({
  description: "Demands nothing",
  parameters: z.object({}),
  execute: () => "ok",
});

// ---- type-level pins ------------------------------------------------

// execute's input is typed from the parameters schema.
type _input = Expect<Equal<Parameters<(typeof user)["execute"]>[1], { message: string }>>;

// The overlay folds the per-call host facts under one key.
function overlayFields(context: ToolContext<Ctx>): void {
  void context.prefix;
  void context.tool.threadId;
  void context.tool.projectId;
  void context.tool.signal;
}
void overlayFields;

// ToolsContext: intersection of the tools' demands, overlay included.
type Demanding = { user: typeof user; snapshot: typeof snapshot };
type _demand = Expect<
  MutuallyAssignable<ToolsContext<Demanding>, Ctx & Fs & { tool: ToolInvocation }>
>;

// The {} floor when nothing demands anything.
type _floor = Expect<MutuallyAssignable<ToolsContext<{ plain: typeof plain }>, {}>>;

// A demand annotated only on `enabled` still surfaces — one Context
// parameter ties both callbacks.
type _enabledArm = Expect<
  MutuallyAssignable<ToolsContext<{ gated: typeof gated }>, Ctx & { tool: ToolInvocation }>
>;

// A concrete tool satisfies the loose AnyTool shape (method-syntax
// bivariance) without a cast.
const asAny: AnyTool = user;
void asAny;
const asMap: ToolMap = { user, snapshot, gated, plain };
void asMap;

function typeOnly() {
  // @ts-expect-error a non-object schema violates JSONObjectSchema (ADR-0016)
  void defineTool({ description: "x", parameters: z.string(), execute: () => "ok" });
}
void typeOnly;

// ---- defineTool -----------------------------------------------------

test("defineTool returns the definition by identity, without a kind", () => {
  const definition = {
    description: "d",
    parameters: z.object({ message: z.string() }),
    execute: () => "ok",
  };
  const tool = defineTool(definition);
  assert.equal(tool, definition);
  assert.equal("kind" in tool, false);
});

test("runtimeTools is a view over the same tool objects", () => {
  const runtime = runtimeTools({ user });
  assert.deepEqual(Object.keys(runtime), ["user"]);
  assert.equal(runtime.user, user as unknown);
});

// ---- key validation and name derivation -----------------------------

test("assertToolKeys accepts lower_snake keys", () => {
  assertToolKeys({ user, snapshot_v2: snapshot });
});

test("assertToolKeys rejects keys outside the grammar", () => {
  for (const key of ["User", "9user", "with-dash", ""]) {
    assert.throws(() => assertToolKeys({ [key]: user }), new RegExp(`invalid tool key "${key}"`));
  }
});

test("TOOL_KEY_PATTERN is anchored to the whole key", () => {
  assert.equal(TOOL_KEY_PATTERN.test("user_v2"), true);
  assert.equal(TOOL_KEY_PATTERN.test("user!"), false);
});

test("toolName underscores the plugin id and appends the key", () => {
  assert.equal(toolName("notify", "user"), "notify_user");
  assert.equal(toolName("bb-kit-demo", "run"), "bb_kit_demo_run");
});
