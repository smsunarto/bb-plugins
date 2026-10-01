import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  assertRPCKeys,
  callProcedure,
  defineMutation,
  defineQuery,
  noInputSchema,
  RPCValidationError,
} from "./rpc.ts";
import type {
  AnyProcedure,
  Client,
  RPCContext,
  SchemaInput,
  SchemaOutput,
  StandardSchemaV1,
} from "./rpc.ts";
import type { UnionToIntersection } from "../utils/types.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const echo = defineQuery({
  input: z.object({ path: z.string() }),
  output: z.object({ ok: z.boolean(), path: z.string() }),
  execute(_ctx, { path }) {
    return { ok: true, path: `p:${path}` };
  },
});

const ping = defineQuery({
  output: z.object({ pong: z.boolean() }),
  execute() {
    return { pong: true };
  },
});

const bump = defineMutation({
  input: z.object({ by: z.number().default(2) }),
  output: z.object({ value: z.number() }),
  execute(_ctx, { by }) {
    return { value: by };
  },
});

const broken = defineQuery({
  output: z.object({ n: z.number() }),
  execute() {
    return { n: "nope" as unknown as number };
  },
});

const demo = { echo, ping, bump, broken };
type Demo = typeof demo;

const host = { bb: {} as BbPluginApi };

// ---- type-level pins ------------------------------------------------

// kinds
type _queryKind = Expect<Equal<(typeof echo)["kind"], "query">>;
type _mutationKind = Expect<Equal<(typeof bump)["kind"], "mutation">>;

// `input` is required-or-absent, never optional (§3).
type _hasInput = Expect<Equal<"input" extends keyof typeof echo ? true : false, true>>;
type _lacksInput = Expect<Equal<"input" extends keyof typeof ping ? true : false, false>>;

// Client: with-input takes the input schema's INPUT type, no-input
// takes nothing; results are the output schema's OUTPUT type.
type _withInputParams = Expect<Equal<Parameters<Client<Demo>["echo"]>, [{ path: string }]>>;
type _noInputParams = Expect<Equal<Parameters<Client<Demo>["ping"]>, []>>;
type _result = Expect<
  Equal<Awaited<ReturnType<Client<Demo>["echo"]>>, { ok: boolean; path: string }>
>;

// A defaulted field is optional on the CLIENT side (schema input type).
function inputDirection(client: Client<Demo>) {
  void client.bump({});
  void client.bump({ by: 5 });
}
void inputDirection;

// defineQuery pins `{ bb }`, so RPCContext of those maps is `{ bb }`.
type _ctx = Expect<MutuallyAssignable<RPCContext<Demo>, { readonly bb: BbPluginApi }>>;

const bare = { bump };
type _floor = Expect<MutuallyAssignable<RPCContext<typeof bare>, { readonly bb: BbPluginApi }>>;
void bare;

function typeOnly(client: Client<Demo>) {
  // @ts-expect-error a with-input procedure requires its input
  void client.echo();
  // @ts-expect-error a no-input procedure takes no argument
  void client.ping({});
  // @ts-expect-error a non-object schema violates JSONObjectSchema (ADR-0014)
  void defineQuery({ output: z.string(), execute: () => "x" });
  // @ts-expect-error input schemas must be object schemas too
  void defineQuery({ input: z.number(), output: z.object({}), execute: () => ({}) });
  defineQuery({
    output: z.object({ pong: z.boolean() }),
    // @ts-expect-error ctx must be a Context: services ride beside `bb`
    execute: (_ctx: { extra(): void }) => ({ pong: true }),
  });
}
void typeOnly;

// ---- Standard Schema v1 ---------------------------------------------

const schema = z.object({ path: z.string() });

// zod 4 schemas satisfy the SDK's interface directly, no adapter.
const asStandard: StandardSchemaV1<{ path: string }, { path: string }> = schema;
void asStandard;

type _input = Expect<Equal<SchemaInput<typeof schema>, { path: string }>>;
type _output = Expect<Equal<SchemaOutput<typeof schema>, { path: string }>>;

test("Standard Schema validate accepts a conforming value", async () => {
  const result = await schema["~standard"].validate({ path: "a.txt" });
  assert.ok(!result.issues);
  assert.deepEqual(result.value, { path: "a.txt" });
});

test("Standard Schema validate reports issues for a non-conforming value", async () => {
  const result = await schema["~standard"].validate(5);
  assert.ok(result.issues);
  assert.ok(result.issues.length > 0);
  assert.equal(typeof result.issues[0]?.message, "string");
});

// ---- no-input schema --------------------------------------------

test("noInputSchema accepts null (SDK hooks and fake host deliver null)", async () => {
  const result = await noInputSchema["~standard"].validate(null);
  assert.ok(!result.issues);
  assert.equal(result.value, null);
});

test("noInputSchema accepts undefined (empty POST body)", async () => {
  const result = await noInputSchema["~standard"].validate(undefined);
  assert.ok(!result.issues);
  assert.equal(result.value, undefined);
});

test("noInputSchema rejects everything else", async () => {
  for (const value of [{}, "", 0, false, []]) {
    const result = await noInputSchema["~standard"].validate(value);
    assert.ok(result.issues, `expected issues for ${JSON.stringify(value)}`);
    assert.equal(result.issues[0]?.message, "this RPC takes no input");
  }
});

test("noInputSchema vendor is bb-kit", () => {
  assert.equal(noInputSchema["~standard"].vendor, "bb-kit");
});

// ---- procedure shapes -----------------------------------------------

type _u2i = Expect<Equal<UnionToIntersection<{ a: 1 } | { b: 2 }>, { a: 1 } & { b: 2 }>>;

const overview = defineQuery({
  output: z.object({ ok: z.boolean() }),
  execute() {
    return { ok: true };
  },
});

// A concrete procedure satisfies the loose AnyProcedure shape
// (method-syntax bivariance) without a cast.
const asAny: AnyProcedure = overview;
void asAny;

test("assertRPCKeys rejects invalid and reserved keys", () => {
  assert.throws(() => assertRPCKeys({ ReadFile: ping }), /invalid RPC key "ReadFile"/);
  assert.throws(() => assertRPCKeys({ "read-file": ping }), /invalid RPC key/);
  assert.throws(() => assertRPCKeys({ useClient: ping }), /"useClient" is a reserved RPC key/);
  // oxlint-disable-next-line unicorn/no-thenable -- the thenable hazard is the point
  assert.throws(() => assertRPCKeys({ then: ping }), /"then" is a reserved RPC key/);
});

// ---- callProcedure --------------------------------------------------

const client = {
  echo: (input: unknown) => callProcedure(echo, host, input),
  ping: (input?: unknown) => callProcedure(ping, host, input),
  bump: (input: unknown) => callProcedure(bump, host, input),
  broken: () => callProcedure(broken, host, undefined),
};

test("with-input call validates, runs execute, returns the parsed output", async () => {
  assert.deepEqual(await client.echo({ path: "x" }), { ok: true, path: "p:x" });
});

test("input defaults apply before execute sees the input", async () => {
  assert.deepEqual(await client.bump({}), { value: 2 });
  assert.deepEqual(await client.bump({ by: 7 }), { value: 7 });
});

test("no-input call passes only the context", async () => {
  assert.deepEqual(await client.ping(), { pong: true });
});

test("invalid input throws RPCValidationError at stage input", async () => {
  await assert.rejects(client.echo(5), (error: unknown) => {
    assert.ok(error instanceof RPCValidationError);
    assert.equal(error.name, "RPCValidationError");
    assert.equal(error.stage, "input");
    assert.ok(error.issues.length > 0);
    assert.match(error.message, /^invalid input: /);
    return true;
  });
});

test("input given to a no-input procedure is rejected by noInputSchema", async () => {
  await assert.rejects(client.ping({}), (error: unknown) => {
    assert.ok(error instanceof RPCValidationError);
    assert.equal(error.stage, "input");
    assert.equal(error.issues[0]?.message, "this RPC takes no input");
    return true;
  });
});

test("an execute result failing the output schema throws at stage output", async () => {
  await assert.rejects(client.broken(), (error: unknown) => {
    assert.ok(error instanceof RPCValidationError);
    assert.equal(error.stage, "output");
    assert.match(error.message, /^invalid output: /);
    return true;
  });
});
