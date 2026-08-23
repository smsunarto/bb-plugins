import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  createClient,
  defineMutation,
  defineQuery,
  defineRPC,
  kebabName,
  noInputSchema,
  RPCValidationError,
  runtimeProcedures,
  wireName,
} from "./rpc.ts";
import type {
  AnyProcedure,
  ClientFor,
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

type Ctx = { prefix: string };
type Fs = { root: string };

const echo = defineQuery({
  input: z.object({ path: z.string() }),
  output: z.object({ ok: z.boolean(), path: z.string() }),
  handler: (context: Ctx, input) => ({ ok: true, path: context.prefix + input.path }),
});

const ping = defineQuery({
  output: z.object({ pong: z.boolean() }),
  handler: (context: Fs) => ({ pong: context.root.length >= 0 }),
});

const bump = defineMutation({
  input: z.object({ by: z.number().default(2) }),
  output: z.object({ value: z.number() }),
  handler: (_context, input) => ({ value: input.by }),
});

const broken = defineQuery({
  output: z.object({ n: z.number() }),
  handler: () => ({ n: "nope" as unknown as number }),
});

const demo = defineRPC({
  namespace: "demo",
  procedures: { echo, ping, bump, broken },
});
type Demo = typeof demo;
type Client = ClientFor<Demo>;

// ---- type-level pins ------------------------------------------------

// kinds
type _queryKind = Expect<Equal<(typeof echo)["kind"], "query">>;
type _mutationKind = Expect<Equal<(typeof bump)["kind"], "mutation">>;

// `input` is required-or-absent, never optional (§3).
type _hasInput = Expect<Equal<"input" extends keyof typeof echo ? true : false, true>>;
type _lacksInput = Expect<Equal<"input" extends keyof typeof ping ? true : false, false>>;

// namespace stays literal-typed.
type _namespace = Expect<Equal<Demo["namespace"], "demo">>;

// ClientFor: with-input takes the input schema's INPUT type, no-input
// takes nothing; results are the output schema's OUTPUT type.
type _withInputParams = Expect<Equal<Parameters<Client["echo"]>, [{ path: string }]>>;
type _noInputParams = Expect<Equal<Parameters<Client["ping"]>, []>>;
type _result = Expect<Equal<Awaited<ReturnType<Client["echo"]>>, { ok: boolean; path: string }>>;

// A defaulted field is optional on the CLIENT side (schema input type).
function inputDirection(client: Client) {
  void client.bump({});
  void client.bump({ by: 5 });
}
void inputDirection;

// RPCContext: intersection of annotated demands; an unannotated handler
// (bump, broken) demands nothing and is filtered out.
type _context = Expect<MutuallyAssignable<RPCContext<Demo>, Ctx & Fs>>;

// The {} floor when nothing demands anything.
const bare = defineRPC({ namespace: "bare", procedures: { bump } });
type _floor = Expect<MutuallyAssignable<RPCContext<typeof bare>, {}>>;

function typeOnly(client: Client) {
  // @ts-expect-error a with-input procedure requires its input
  void client.echo();
  // @ts-expect-error a no-input procedure takes no argument
  void client.ping({});
  // @ts-expect-error a non-object schema violates JSONObjectSchema (ADR-0014)
  void defineQuery({ output: z.string(), handler: () => "x" });
  // @ts-expect-error input schemas must be object schemas too
  void defineQuery({ input: z.number(), output: z.object({}), handler: () => ({}) });
}
void typeOnly;

// ---- Standard Schema v1 (vendored) ----------------------------------

const schema = z.object({ path: z.string() });

// zod 4 schemas satisfy the vendored interface directly, no adapter.
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

// ---- no-input schema (vendored) -------------------------------------

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
    assert.equal(result.issues[0]?.message, "this procedure takes no input");
  }
});

test("noInputSchema vendor is bb-kit", () => {
  assert.equal(noInputSchema["~standard"].vendor, "bb-kit");
});

// ---- wire-name derivation -------------------------------------------

test("wire names: pinned derivations", () => {
  assert.equal(wireName("audit-log", "readEntry"), "audit_log_read_entry");
  assert.equal(wireName("audit-log", "readURL"), "audit_log_read_url");
  // Acronym-unaware on purpose: URLPath does NOT split.
  assert.equal(wireName("audit-log", "readURLPath"), "audit_log_read_urlpath");
  assert.equal(wireName("dotfiles", "overview"), "dotfiles_overview");
});

test("wire names: digit boundaries", () => {
  // lower/digit followed by upper gets an underscore.
  assert.equal(wireName("vault", "save2FA"), "vault_save2_fa");
});

test("kebab names for the rpc subtree", () => {
  assert.equal(kebabName("overview"), "overview");
  assert.equal(kebabName("readFile"), "read-file");
  assert.equal(kebabName("readURL"), "read-url");
  assert.equal(kebabName("readURLPath"), "read-urlpath");
});

// ---- procedure shapes -----------------------------------------------

type _u2i = Expect<Equal<UnionToIntersection<{ a: 1 } | { b: 2 }>, { a: 1 } & { b: 2 }>>;

const overview = defineQuery({
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});

// A concrete procedure satisfies the loose AnyProcedure shape
// (method-syntax bivariance) without a cast.
const asAny: AnyProcedure = overview;
void asAny;

test("runtimeProcedures is a view over the same procedure objects", () => {
  const rpc = defineRPC({ namespace: "demo", procedures: { overview } });
  const runtime = runtimeProcedures(rpc);
  assert.deepEqual(Object.keys(runtime), ["overview"]);
  assert.equal(runtime.overview, overview as unknown);
});

// ---- defineRPC define-time validation -------------------------------

test("defineRPC rejects an invalid namespace", () => {
  assert.throws(
    () => defineRPC({ namespace: "Bad", procedures: {} }),
    /invalid RPC namespace "Bad"/,
  );
  assert.throws(() => defineRPC({ namespace: "-x", procedures: {} }), /invalid RPC namespace/);
});

test("defineRPC rejects an invalid procedure key", () => {
  assert.throws(
    () => defineRPC({ namespace: "ok", procedures: { ReadFile: ping } }),
    /invalid procedure key "ReadFile"/,
  );
  assert.throws(
    () => defineRPC({ namespace: "ok", procedures: { "read-file": ping } }),
    /invalid procedure key/,
  );
});

test("defineRPC rejects the reserved keys useClient and then", () => {
  assert.throws(
    () => defineRPC({ namespace: "ok", procedures: { useClient: ping } }),
    /"useClient" is a reserved procedure key/,
  );
  assert.throws(
    // oxlint-disable-next-line unicorn/no-thenable -- the thenable hazard is the point: defineRPC must reject this key
    () => defineRPC({ namespace: "ok", procedures: { then: ping } }),
    /"then" is a reserved procedure key/,
  );
});

test("defineRPC rejects duplicate wire names", () => {
  assert.throws(
    () => defineRPC({ namespace: "ok", procedures: { readUrl: ping, readURL: ping } }),
    /both derive the wire name "ok_read_url"/,
  );
});

test("defineRPC freezes the value", () => {
  assert.ok(Object.isFrozen(demo));
  assert.ok(Object.isFrozen(demo.procedures));
});

// ---- createClient ---------------------------------------------------

const client = createClient(demo, { prefix: "p:", root: "/" });

test("with-input call validates, runs the handler, returns the parsed output", async () => {
  assert.deepEqual(await client.echo({ path: "x" }), { ok: true, path: "p:x" });
});

test("input defaults apply before the handler sees the input", async () => {
  assert.deepEqual(await client.bump({}), { value: 2 });
  assert.deepEqual(await client.bump({ by: 7 }), { value: 7 });
});

test("no-input call passes only the context", async () => {
  assert.deepEqual(await client.ping(), { pong: true });
});

test("invalid input throws RPCValidationError at stage input", async () => {
  const loose = client.echo as unknown as (input: unknown) => Promise<unknown>;
  await assert.rejects(loose(5), (error: unknown) => {
    assert.ok(error instanceof RPCValidationError);
    assert.equal(error.name, "RPCValidationError");
    assert.equal(error.stage, "input");
    assert.ok(error.issues.length > 0);
    assert.match(error.message, /^invalid input: /);
    return true;
  });
});

test("input given to a no-input procedure is rejected by the vendored schema", async () => {
  const loose = client.ping as unknown as (input: unknown) => Promise<unknown>;
  await assert.rejects(loose({}), (error: unknown) => {
    assert.ok(error instanceof RPCValidationError);
    assert.equal(error.stage, "input");
    assert.equal(error.issues[0]?.message, "this procedure takes no input");
    return true;
  });
});

test("a handler result failing the output schema throws at stage output", async () => {
  await assert.rejects(client.broken(), (error: unknown) => {
    assert.ok(error instanceof RPCValidationError);
    assert.equal(error.stage, "output");
    assert.match(error.message, /^invalid output: /);
    return true;
  });
});

test("createClient accepts the {} floor for an undemanding RPC", async () => {
  const bareClient = createClient(bare, {});
  assert.deepEqual(await bareClient.bump({}), { value: 2 });
});
