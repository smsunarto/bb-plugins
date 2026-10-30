import type { ChildProcess, ExecFileException } from "node:child_process";
import { experimental_execHostFileCallback as execFile } from "@get-bb/plugin-sdk/process";
import { Cache, Clock, Duration, Effect, Exit, Option } from "effect";
import { accountSchema } from "../../shared/schema.ts";
import { type Run, type Share, runDetached, shareDetached } from "./run.ts";

/*
 * Every GitHub call goes through the `gh` CLI on the bb server's machine, so
 * the plugin stores no token. `gh` can be signed in to several github.com
 * accounts at once; a call acts as one of them by running `gh` with that
 * account's token in `GH_TOKEN`, which leaves gh's active account alone.
 * GraphQL bodies travel on stdin (`gh api graphql --input -`), which keeps
 * variable types intact and needs no flag escaping.
 *
 * Each call is an Effect underneath, so stopping a read stops its `gh`; a
 * write that has started runs to its end. Promise code calls the same
 * through `Gh` and `GitHub`.
 */

export type GhErrorCode =
  | "gh-missing"
  | "unauthenticated"
  | "not-found"
  | "forbidden"
  | "rate-limited"
  | "failed";

export class GhError extends Error {
  readonly code: GhErrorCode;
  constructor(code: GhErrorCode, message: string) {
    super(message);
    this.name = "GhError";
    this.code = code;
  }
}

/** The runner stopped `gh` at one of its own limits, so any output is partial. */
export type RunFailure = "timeout" | "too-large";

export type RunResult = { code: number; stdout: string; stderr: string; failure?: RunFailure };

/**
 * Runs `gh` with `args`, writing `stdin` when given and adding `env` to its
 * environment. Never fails for a non-zero exit. Interrupted, it stops `gh`
 * and waits for it to exit.
 */
export type GhRunner = (
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
) => Effect.Effect<RunResult, GhError>;

export type GraphqlOptions = {
  /**
   * Root fields that may come back null when GitHub hides or cannot find
   * them, such as one lookup among many. Any other missing root still fails.
   */
  optionalRoot?: (name: string) => boolean;
  /** Exact nullable fields whose NOT_FOUND errors mean optional data is absent. */
  optionalNotFoundPaths?: readonly (readonly (string | number)[])[];
};

export type RestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  paginate?: boolean;
};

/** `gh` acting as one account, as Effects: interrupting a read stops its `gh`, and a write's runs on. */
export type GhCalls = {
  /**
   * Runs a GraphQL query or mutation and returns its `data`. List items
   * GitHub hides from the viewer are dropped, so callers never see their null.
   */
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphqlOptions,
  ): Effect.Effect<unknown, GhError>;
  /**
   * Calls a REST endpoint. `paginate` follows every page and returns the
   * flattened array.
   */
  rest(path: string, options?: RestOptions): Effect.Effect<unknown, GhError>;
  /** Runs any other `gh` command and returns its stdout. */
  text(args: string[]): Effect.Effect<string, GhError>;
};

/** {@link GhCalls} for Promise code. */
export type Gh = {
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphqlOptions,
  ): Promise<unknown>;
  rest(path: string, options?: RestOptions): Promise<unknown>;
  text(args: string[]): Promise<string>;
};

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;
/** From SIGTERM to SIGKILL, and from SIGKILL to no longer waiting: how long a stopped `gh` gets to exit. */
const STOP_GRACE_MS = 2_000;

const LIMIT_MESSAGES: Record<RunFailure, string> = {
  timeout: `GitHub CLI timed out after ${TIMEOUT_MS / 1000}s.`,
  "too-large": `GitHub returned more than ${MAX_BUFFER / 1024 / 1024} MB.`,
};

const NO_CREDENTIALS =
  /no oauth token|not logged in|gh auth login|authentication required|bad credentials|HTTP 401/i;
const NOT_FOUND = /HTTP 404|could not resolve to a|not found/i;
const FORBIDDEN = /HTTP 403|resource not accessible|must have (?:push|admin|write)/i;
const RATE_LIMITED = /rate limit|HTTP 429|secondary rate/i;

/** Maps a failed `gh` invocation to a typed error with a message a person can act on. */
export function classifyFailure(stderr: string, stdout = ""): GhError {
  const text = `${stderr}\n${stdout}`.trim();
  const message = firstLine(stderr) || firstLine(stdout) || "gh failed with no output.";
  if (NO_CREDENTIALS.test(text)) {
    return new GhError("unauthenticated", "GitHub CLI is not signed in. Run `gh auth login`.");
  }
  if (RATE_LIMITED.test(text)) return new GhError("rate-limited", message);
  if (FORBIDDEN.test(text)) return new GhError("forbidden", message);
  if (NOT_FOUND.test(text)) return new GhError("not-found", message);
  return new GhError("failed", message);
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  ).replace(/^gh: /, "");
}

/**
 * What a finished `execFile` call means as a `RunResult`. When the runner
 * killed `gh` itself, the output is cut short, and classifying it could
 * report a 404 from the middle of a job log, so it is dropped.
 */
export function runResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): RunResult {
  if (error?.code === "ENOENT") return { code: 127, stdout: "", stderr: "ENOENT: gh not found" };
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { code: 1, stdout: "", stderr: "", failure: "too-large" };
  }
  // Past the buffer check, only the timeout kills `gh` from this side.
  if (error?.killed) return { code: 1, stdout: "", stderr: "", failure: "timeout" };
  const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
  return { code, stdout, stderr };
}

/** The real runner: `execFile` with stdin, a timeout, and a large buffer. */
export const execGh: GhRunner = (args, stdin, env = {}) =>
  Effect.callback<RunResult>((resume) => {
    const child = execFile(
      "gh",
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
          ...env,
        },
      },
      (error, stdout, stderr) =>
        resume(Effect.succeed(runResult(error, String(stdout), String(stderr)))),
    );
    // `gh` can exit before reading stdin (a bad flag, a missing binary). The
    // write then fails with EPIPE, and an 'error' event nobody listens to
    // would crash the bb server. The exit code already reports the failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    // A call that is stopped waits for its `gh` to go, so a slot the call
    // holds frees only once the process it counts has.
    return stop(child);
  });

/** Stops `child` and waits for it to exit: SIGTERM, then SIGKILL past a grace. */
function stop(child: ChildProcess): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      if (Option.isSome(yield* Effect.timeoutOption(exited(child), STOP_GRACE_MS))) return;
    }
  });
}

const exited = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void);
    child.once("exit", done);
    return Effect.sync(() => child.off("exit", done));
  });

type GraphQlError = { message?: string; type?: string; path?: (string | number)[] };
type GraphQlResponse = { data?: unknown; errors?: GraphQlError[] };

/** Where GitHub put the null an error left: a list item, or a field the caller allows. */
type Hole = { list: unknown[]; index: number } | { field: string | number };

/**
 * GitHub answers null for a node the viewer may not see (a search hit in an
 * org that enforces SAML, a cross-reference from a private repository, a
 * node deleted mid-query) and still answers the rest. The null bubbles up to
 * the nearest nullable field, so the first null along the error's path is
 * where it landed. Only a list item or an allowed field is a hole the answer
 * survives: a root lookup like `repository(...)` that is missing or
 * forbidden keeps failing with its type.
 */
function holeFor(data: unknown, error: GraphQlError, options: GraphqlOptions): Hole | null {
  if (error.type !== "FORBIDDEN" && error.type !== "NOT_FOUND") return null;
  const path = error.path ?? [];
  const optionalNotFound =
    error.type === "NOT_FOUND" &&
    options.optionalNotFoundPaths?.some(
      (allowed) => allowed.length === path.length && allowed.every((part, i) => part === path[i]),
    );
  let node = data;
  for (const [depth, segment] of path.entries()) {
    if (node === null || typeof node !== "object") return null;
    const next = (node as Record<string | number, unknown>)[segment];
    if (next !== null) {
      node = next;
      continue;
    }
    if (Array.isArray(node) && typeof segment === "number") return { list: node, index: segment };
    if (depth === 0 && typeof segment === "string" && options.optionalRoot?.(segment)) {
      return { field: segment };
    }
    // Require the null at the exact path, not an ancestor that failed to load.
    if (optionalNotFound && depth === path.length - 1) return { field: segment };
    return null;
  }
  return null;
}

/** Drops the nulled list items, last first so earlier indexes stay put. */
function dropListHoles(holes: readonly Hole[]): void {
  const items = holes.flatMap((hole) => ("list" in hole ? [hole] : []));
  for (const { list, index } of items.toSorted((a, b) => b.index - a.index)) {
    if (list[index] === null) list.splice(index, 1);
  }
}

/**
 * Runs `gh` for one call. `write` says the call may change GitHub: once its
 * `gh` starts, nothing stops it short of its own time limit, not even
 * unloading the plugin, since a write stopped midway may have landed with no
 * answer to say so. Until then, a call can still be stopped.
 */
type Invoke = (
  args: string[],
  stdin: string | undefined,
  write: boolean,
) => Effect.Effect<RunResult, GhError>;

/** `gh` once it runs: a write is not interrupted, so `runner` never stops its `gh`. */
const spawned = (write: boolean, gh: Effect.Effect<RunResult, GhError>) =>
  write ? Effect.uninterruptible(gh) : gh;

/** A GraphQL document whose operation changes GitHub. */
const MUTATION = /^\s*mutation\b/;

/** Whether `gh args` may change GitHub: any command but `gh api`, which reads unless its method says otherwise. */
function textWrites(args: string[]): boolean {
  if (args[0] !== "api") return true;
  const at = args.findIndex((arg) => arg === "--method" || arg === "-X");
  return at >= 0 && args[at + 1]?.toUpperCase() !== "GET";
}

/** The result, unless `gh` is missing or the runner cut it short. */
function checked(result: RunResult): Effect.Effect<RunResult, GhError> {
  if (result.code === 127 && /ENOENT/.test(result.stderr)) {
    return Effect.fail(
      new GhError(
        "gh-missing",
        "GitHub CLI (gh) is not installed on the bb server's machine. Install it from https://cli.github.com.",
      ),
    );
  }
  if (result.failure) return Effect.fail(new GhError("failed", LIMIT_MESSAGES[result.failure]));
  return Effect.succeed(result);
}

const GRAPHQL_CODES: Record<string, GhErrorCode> = {
  NOT_FOUND: "not-found",
  FORBIDDEN: "forbidden",
  RATE_LIMITED: "rate-limited",
};

/**
 * A GraphQL answer's `data`. On partial failure gh prints the JSON body and
 * still exits non-zero, so stdout is read before the exit code is trusted.
 */
function graphqlData(result: RunResult, options: GraphqlOptions): Effect.Effect<unknown, GhError> {
  const body = parseJson<GraphQlResponse>(result.stdout);
  const errors = body?.errors ?? [];
  const data = body?.data;
  const holes = data == null ? [] : errors.map((error) => holeFor(data, error, options));
  if (data != null && errors.length > 0 && holes.every((hole) => hole !== null)) {
    dropListHoles(holes);
    return Effect.succeed(data);
  }
  // Report the error that sank the request, not a hidden item beside it.
  const fatal = errors.find((_, i) => !holes[i]) ?? errors[0];
  if (fatal) {
    const message = fatal.message ?? "GitHub GraphQL request failed.";
    return Effect.fail(new GhError(GRAPHQL_CODES[fatal.type ?? ""] ?? "failed", message));
  }
  if (result.code !== 0 || !body || body.data === undefined) {
    return Effect.fail(classifyFailure(result.stderr, result.stdout));
  }
  return Effect.succeed(body.data);
}

/** A REST answer's body: null when empty, and every page's items when paginated. */
function restBody(result: RunResult, paginate: boolean): Effect.Effect<unknown, GhError> {
  if (result.code !== 0) return Effect.fail(classifyFailure(result.stderr, result.stdout));
  const notJson = () => new GhError("failed", "GitHub returned a response that is not JSON.");
  if (paginate) {
    const items = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => parseJson<unknown>(line));
    return items.includes(undefined) ? Effect.fail(notJson()) : Effect.succeed(items);
  }
  if (result.stdout.trim() === "") return Effect.succeed(null);
  const body = parseJson<unknown>(result.stdout);
  return body === undefined ? Effect.fail(notJson()) : Effect.succeed(body);
}

function ghCalls(run: Invoke): GhCalls {
  const call = (args: string[], stdin: string | undefined, write: boolean) =>
    Effect.flatMap(run(args, stdin, write), checked);
  return {
    graphql: (query, variables = {}, options = {}) =>
      Effect.flatMap(
        call(
          ["api", "graphql", "--input", "-"],
          JSON.stringify({ query, variables }),
          MUTATION.test(query),
        ),
        (result) => graphqlData(result, options),
      ),
    rest(path, options = {}) {
      const method = options.method ?? "GET";
      const args = ["api", path.replace(/^\//, ""), "--method", method];
      // gh 2.46 has no `--slurp`, and plain `--paginate` prints pages back to
      // back (`[…][…]`). One compact element per line parses unambiguously.
      if (options.paginate) args.push("--paginate", "--jq", ".[]");
      let stdin: string | undefined;
      if (options.body !== undefined) {
        args.push("--input", "-");
        stdin = JSON.stringify(options.body);
      }
      return Effect.flatMap(call(args, stdin, method !== "GET"), (result) =>
        restBody(result, options.paginate === true),
      );
    },
    text: (args) =>
      Effect.flatMap(call(args, undefined, textWrites(args)), (result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(classifyFailure(result.stderr, result.stdout)),
      ),
  };
}

/** `calls` for Promise code, each run by `run` and stopped once `signal` aborts. */
function promised(calls: GhCalls, run: Run, signal?: AbortSignal): Gh {
  // A caller that has already left starts no `gh`.
  const call = <A>(effect: Effect.Effect<A, GhError>) =>
    signal?.aborted ? Promise.reject(signal.reason) : run(effect, signal);
  return {
    graphql: (query, variables, options) => call(calls.graphql(query, variables, options)),
    rest: (path, options) => call(calls.rest(path, options)),
    text: (args) => call(calls.text(args)),
  };
}

export function createGh(runner: GhRunner = execGh, run: Run = runDetached): Gh {
  return promised(
    ghCalls((args, stdin, write) => spawned(write, runner(args, stdin))),
    run,
  );
}

/** How long a read of the signed-in accounts holds. `gh auth status` asks GitHub about each. */
const ACCOUNTS_TTL_MS = 60_000;

/** The line that opens each account's block, whether its token works or not. */
const ACCOUNT =
  /(Logged|Failed to log) in to github\.com (?:account|as) ([A-Za-z0-9][A-Za-z0-9_-]*)(?: \(([^)]*)\))?/;
const ACTIVE = /Active account: (true|false)/;
/** gh reads a token from these variables before any account it stores. */
const ENV_TOKEN = /^(?:GH_TOKEN|GITHUB_TOKEN)$/;

/**
 * A signed-in github.com account. `env` when its token is the bb server's
 * own `GH_TOKEN`: gh stores nothing for it, so it has no `--user` token.
 */
export type GhAccount = { login: string; env: boolean };

/**
 * The github.com accounts in `gh auth status` output, the active one first.
 * gh before 2.40 knew one account and printed no "Active account" line, and
 * an account whose token stopped working is "Failed to log in", not listed.
 */
export function parseAuthStatus(text: string): GhAccount[] {
  const accounts: (GhAccount & { active: boolean })[] = [];
  // The account the following detail lines belong to. Null under a failed one.
  let current: (GhAccount & { active: boolean }) | null = null;
  for (const line of text.split("\n")) {
    const opened = ACCOUNT.exec(line);
    if (opened) {
      current =
        opened[1] === "Logged"
          ? { login: opened[2] ?? "", env: ENV_TOKEN.test(opened[3] ?? ""), active: true }
          : null;
      if (current) accounts.push(current);
    }
    const active = ACTIVE.exec(line)?.[1];
    if (active && current) current.active = active === "true";
  }
  return accounts
    .toSorted((a, b) => Number(b.active) - Number(a.active))
    .map(({ login, env }) => ({ login, env }));
}

/** The signed-in accounts and `gh` as each of them, as Effects. */
export type GitHubCalls = {
  /** The signed-in github.com accounts, the active one first. */
  accounts: Effect.Effect<string[], GhError>;
  /** gh acting as `login`, one of `accounts`. */
  as(login: string): GhCalls;
  /**
   * `login`'s token, for the reads `gh` cannot carry: file bytes, which its
   * output decodes as text, and Git LFS downloads, which are not GitHub's API.
   * Held only in memory, like the tokens every call passes to `gh`.
   */
  token(login: string): Effect.Effect<string, GhError>;
};

/** {@link GitHubCalls} for Promise code, with the Effects themselves as `effects`. */
export type GitHub = {
  accounts(): Promise<string[]>;
  /** gh acting as `login`. Once `signal` aborts, its calls stop and start no `gh`. */
  as(login: string, signal?: AbortSignal): Gh;
  token(login: string): Promise<string>;
  effects: GitHubCalls;
};

const NOT_SIGNED_IN = "GitHub CLI is not signed in. Run `gh auth login`.";
const noToken = (login: string) => `GitHub CLI has no token for @${login}. Run \`gh auth login\`.`;

/**
 * Every signed-in `gh` account, each reached with its own token in
 * `GH_TOKEN`, so one bb server reads and writes as several people. A call
 * checks its account is still signed in first, so a token read before a
 * logout is never used after it. The accounts and tokens are read through
 * `share`, so a call that stops waiting leaves the read to finish, within
 * gh's own time limit, and be kept for the next call.
 */
export function createGitHub(
  runner: GhRunner = execGh,
  now: () => number = Date.now,
  run: Run = runDetached,
  share: Share = shareDetached,
): GitHub {
  // Read again a minute after each read, and at once after one that failed.
  const accounts = Effect.runSync(
    Cache.makeWith((_host: "github.com") => readAccounts, {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? ACCOUNTS_TTL_MS : 0),
    }),
  );
  // By gh's spelling of each login, until the accounts are read again.
  const tokens = Effect.runSync(
    Cache.makeWith((login: string) => readToken(login), {
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
  );
  const listAccounts = share(
    Cache.get(accounts, "github.com").pipe(Effect.provideService(Clock.Clock, clockAt(now))),
  );

  const readAccounts = Effect.gen(function* () {
    const result = yield* Effect.flatMap(
      runner(["auth", "status", "--hostname", "github.com"]),
      checked,
    );
    // gh exits non-zero when any account fails, and older versions print to stderr.
    const found = parseAuthStatus(`${result.stdout}\n${result.stderr}`);
    // Tokens are read again with the accounts: one that signed out goes, and
    // one signed in again with a new token is used from then on.
    yield* Cache.invalidateAll(tokens);
    if (found.length > 0) return found;
    if (result.code !== 0 && !NO_CREDENTIALS.test(`${result.stderr}\n${result.stdout}`)) {
      return yield* Effect.fail(classifyFailure(result.stderr, result.stdout));
    }
    return yield* Effect.fail(new GhError("unauthenticated", NOT_SIGNED_IN));
  });

  /** The signed-in account `login` names, in gh's spelling: GitHub logins ignore case. */
  const account = Effect.fnUntraced(function* (login: string) {
    const key = login.toLowerCase();
    const signedIn = (yield* listAccounts).find((each) => each.login.toLowerCase() === key);
    if (signedIn) return signedIn;
    yield* Cache.invalidate(accounts, "github.com");
    return yield* Effect.fail(
      new GhError(
        "unauthenticated",
        `@${login} is not signed in to GitHub CLI on the bb server. Run \`gh auth login\`.`,
      ),
    );
  });

  const readToken = Effect.fnUntraced(function* (name: string) {
    const result = yield* Effect.flatMap(
      runner(["auth", "token", "--hostname", "github.com", "--user", name]),
      checked,
    );
    const token = result.stdout.trim();
    if (result.code !== 0 || token === "") {
      return yield* Effect.fail(new GhError("unauthenticated", noToken(name)));
    }
    return token;
  });

  /** What a call as `signedIn` adds to gh's environment. Nothing for the server's own `GH_TOKEN`. */
  const environment = (signedIn: GhAccount): Effect.Effect<Record<string, string>, GhError> =>
    signedIn.env
      ? Effect.succeed({})
      : Effect.map(share(Cache.get(tokens, signedIn.login)), (token) => ({ GH_TOKEN: token }));

  const as = (login: string): GhCalls => {
    // A login reaches `gh auth token --user`: one that could read as a flag stops here.
    if (!accountSchema.safeParse(login).success) {
      throw new GhError("failed", `${login} is not a GitHub login.`);
    }
    return ghCalls((args, stdin, write) =>
      Effect.gen(function* () {
        const signedIn = yield* account(login);
        const env = yield* environment(signedIn);
        const result = yield* spawned(write, runner(args, stdin, env));
        if (result.code !== 0 && NO_CREDENTIALS.test(`${result.stderr}\n${result.stdout}`)) {
          yield* Cache.invalidate(tokens, signedIn.login);
        }
        return result;
      }),
    );
  };

  const effects: GitHubCalls = {
    accounts: Effect.map(listAccounts, (list) => list.map((each) => each.login)),
    as,
    token: Effect.fnUntraced(function* (login: string) {
      if (!accountSchema.safeParse(login).success) {
        return yield* Effect.fail(new GhError("failed", `${login} is not a GitHub login.`));
      }
      const env = yield* Effect.flatMap(account(login), environment);
      const token = env["GH_TOKEN"] ?? process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
      if (!token) return yield* Effect.fail(new GhError("unauthenticated", noToken(login)));
      return token;
    }),
  };

  return {
    accounts: () => run(effects.accounts),
    as: (login, signal) => promised(as(login), run, signal),
    token: (login) => run(effects.token(login)),
    effects,
  };
}

/** The clock the accounts' age is read on: `now`, which a test can move by hand. */
function clockAt(now: () => number): Clock.Clock {
  const real = Clock.Clock.defaultValue();
  const nanos = () => BigInt(now()) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) => real.sleep(duration),
  };
}

function parseJson<T>(text: string): T | undefined {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
