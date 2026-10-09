import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import type { CodeReviewContext } from "../src/server/lib/context.ts";
import { type GhRunner, type RunResult, createGh } from "../src/server/lib/gh.ts";
import { createStore } from "../src/server/lib/store.ts";

/*
 * A `gh` that answers from routes instead of GitHub, behind the real
 * `createGh`, so tests exercise the same argument building, stdin, and
 * output parsing the plugin runs with. Every call is recorded in order:
 * write paths assert the exact mutation sequence they send.
 */

type Variables = Record<string, unknown>;

/** A route answers with a value, or computes one from what was sent. */
type Answer = Record<string, unknown> | unknown[] | string | null;

export type FakeGhRoutes = {
  /** By operation name (`query Inbox(...)` → `Inbox`). Answers with the `data` object. */
  graphql?: Record<string, Answer | ((variables: Variables) => unknown)>;
  /**
   * By REST path (`repos/o/r/pulls/1/files?per_page=100`), for `gh.rest`
   * and `gh.text(["api", path])`. A string answers as raw stdout.
   */
  rest?: Record<string, Answer | ((body: unknown) => unknown)>;
};

export type GhCall =
  | { kind: "graphql"; operation: string; variables: Variables }
  | { kind: "rest"; method: string; path: string; body?: unknown };

/** Thrown from a route: GitHub answered with a GraphQL error of `type`. */
export class GraphqlFailure {
  readonly type: string;
  readonly message: string;
  constructor(type: string, message: string) {
    this.type = type;
    this.message = message;
  }
}

/** Thrown from a route: `gh` exited non-zero with `stderr`, or is not installed (code 127). */
export class GhFailure {
  readonly stderr: string;
  readonly code: number;
  constructor(stderr: string, code = 1) {
    this.stderr = stderr;
    this.code = code;
  }
}

export function fakeGh(routes: FakeGhRoutes = {}) {
  const calls: GhCall[] = [];

  const answer = (value: unknown, paginate: boolean): RunResult => {
    if (typeof value === "string") return { code: 0, stdout: value, stderr: "" };
    if (paginate && Array.isArray(value)) {
      return {
        code: 0,
        stdout: value.map((item) => `${JSON.stringify(item)}\n`).join(""),
        stderr: "",
      };
    }
    return { code: 0, stdout: value === undefined ? "" : JSON.stringify(value), stderr: "" };
  };

  const fail = (error: unknown): RunResult => {
    if (error instanceof GraphqlFailure) {
      const body = { errors: [{ type: error.type, message: error.message }] };
      return { code: 1, stdout: JSON.stringify(body), stderr: "" };
    }
    if (error instanceof GhFailure) return { code: error.code, stdout: "", stderr: error.stderr };
    throw error;
  };

  const run: GhRunner = async (args, stdin) => {
    if (args[0] === "--version" || args[0] !== "api") {
      return { code: 1, stdout: "", stderr: `fake gh: unexpected command ${args.join(" ")}` };
    }
    if (args[1] === "graphql") {
      const { query, variables } = JSON.parse(stdin ?? "{}") as {
        query: string;
        variables: Variables;
      };
      const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "(anonymous)";
      calls.push({ kind: "graphql", operation, variables });
      const route = routes.graphql?.[operation];
      if (route === undefined) {
        return { code: 1, stdout: "", stderr: `fake gh: no GraphQL route for ${operation}` };
      }
      try {
        const data = typeof route === "function" ? await route(variables) : route;
        return answer({ data }, false);
      } catch (error) {
        return fail(error);
      }
    }
    const path = args[1] ?? "";
    const method = args.includes("--method")
      ? (args[args.indexOf("--method") + 1] ?? "GET")
      : "GET";
    const body = stdin === undefined ? undefined : (JSON.parse(stdin) as unknown);
    calls.push({ kind: "rest", method, path, ...(body === undefined ? {} : { body }) });
    const route = routes.rest?.[path];
    if (route === undefined) {
      return { code: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) fake route ${path}` };
    }
    try {
      const value = typeof route === "function" ? await route(body) : route;
      return answer(value, args.includes("--paginate"));
    } catch (error) {
      return fail(error);
    }
  };

  return {
    gh: createGh(run),
    calls,
    /** The GraphQL operations sent, in order. */
    operations: () => calls.flatMap((call) => (call.kind === "graphql" ? [call.operation] : [])),
  };
}

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** A recorded GitHub response under `test/fixtures/`. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

/**
 * A handler `ctx` on a fake bb host, with the plugin's real KV store and
 * the fake `gh`. `sdk` stubs the bb calls a test needs.
 */
export function fakeContext(
  routes: FakeGhRoutes = {},
  sdk: CreateFakePluginHostOptions["sdk"] = {},
) {
  const host = createFakePluginHost({ pluginId: "code-review", sdk });
  const github = fakeGh(routes);
  const ctx: CodeReviewContext = {
    bb: host.bb,
    gh: github.gh,
    store: createStore(host.bb.storage.kv),
  };
  return { ctx, harness: host.harness, ...github };
}
