import { type ExecFileException, execFile } from "node:child_process";
import { accountSchema } from "../../shared/schema.ts";

/*
 * Every GitHub call goes through the `gh` CLI on the bb server's machine, so
 * the plugin stores no token. `gh` can be signed in to several github.com
 * accounts at once; a call acts as one of them by running `gh` with that
 * account's token in `GH_TOKEN`, which leaves gh's active account alone.
 * GraphQL bodies travel on stdin (`gh api graphql --input -`), which keeps
 * variable types intact and needs no flag escaping.
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
 * environment. Never throws for a non-zero exit.
 */
export type GhRunner = (
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
) => Promise<RunResult>;

export type GraphqlOptions = {
  /**
   * Root fields that may come back null when GitHub hides or cannot find
   * them, such as one lookup among many. Any other missing root still fails.
   */
  optionalRoot?: (name: string) => boolean;
};

export type Gh = {
  /**
   * Runs a GraphQL query or mutation and returns its `data`. List items
   * GitHub hides from the viewer are dropped, so callers never see their null.
   */
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphqlOptions,
  ): Promise<unknown>;
  /**
   * Calls a REST endpoint. `paginate` follows every page and returns the
   * flattened array.
   */
  rest(
    path: string,
    options?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      paginate?: boolean;
    },
  ): Promise<unknown>;
  /** Runs any other `gh` command and returns its stdout. */
  text(args: string[]): Promise<string>;
};

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

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
  new Promise((resolve) => {
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
      (error, stdout, stderr) => resolve(runResult(error, String(stdout), String(stderr))),
    );
    // `gh` can exit before reading stdin (a bad flag, a missing binary). The
    // write then fails with EPIPE, and an 'error' event nobody listens to
    // would crash the bb server. The exit code already reports the failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });

type GraphQlError = { message?: string; type?: string; path?: (string | number)[] };
type GraphQlResponse = { data?: unknown; errors?: GraphQlError[] };

/** Where GitHub put the null an error left: a list item, or a root field the caller allows. */
type Hole = { list: unknown[]; index: number } | { root: string };

/**
 * GitHub answers null for a node the viewer may not see (a search hit in an
 * org that enforces SAML, a cross-reference from a private repository, a
 * node deleted mid-query) and still answers the rest. The null bubbles up to
 * the nearest nullable field, so the first null along the error's path is
 * where it landed. Only a list item or an allowed root is a hole the answer
 * survives: a root lookup like `repository(...)` that is missing or
 * forbidden keeps failing with its type.
 */
function holeFor(data: unknown, error: GraphQlError, options: GraphqlOptions): Hole | null {
  if (error.type !== "FORBIDDEN" && error.type !== "NOT_FOUND") return null;
  let node = data;
  for (const [depth, segment] of (error.path ?? []).entries()) {
    if (node === null || typeof node !== "object") return null;
    const next = (node as Record<string | number, unknown>)[segment];
    if (next === null) {
      if (Array.isArray(node) && typeof segment === "number") return { list: node, index: segment };
      if (depth === 0 && typeof segment === "string" && options.optionalRoot?.(segment)) {
        return { root: segment };
      }
      return null;
    }
    node = next;
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

/** The result, unless `gh` is missing or the runner cut it short. */
function checked(result: RunResult): RunResult {
  if (result.code === 127 && /ENOENT/.test(result.stderr)) {
    throw new GhError(
      "gh-missing",
      "GitHub CLI (gh) is not installed on the bb server's machine. Install it from https://cli.github.com.",
    );
  }
  if (result.failure) throw new GhError("failed", LIMIT_MESSAGES[result.failure]);
  return result;
}

export function createGh(run: GhRunner = execGh): Gh {
  const call = async (args: string[], stdin?: string) => checked(await run(args, stdin));

  return {
    async graphql(query, variables = {}, options = {}) {
      const result = await call(
        ["api", "graphql", "--input", "-"],
        JSON.stringify({ query, variables }),
      );
      // On partial failure gh prints the JSON body and still exits non-zero,
      // so read stdout before trusting the exit code.
      const body = parseJson<GraphQlResponse>(result.stdout);
      const errors = body?.errors ?? [];
      const data = body?.data;
      const holes = data == null ? [] : errors.map((error) => holeFor(data, error, options));
      if (data != null && errors.length > 0 && holes.every((hole) => hole !== null)) {
        dropListHoles(holes);
        return data;
      }
      // Report the error that sank the request, not a hidden item beside it.
      const fatal = errors.find((_, i) => !holes[i]) ?? errors[0];
      if (fatal) {
        const message = fatal.message ?? "GitHub GraphQL request failed.";
        if (fatal.type === "NOT_FOUND") throw new GhError("not-found", message);
        if (fatal.type === "FORBIDDEN") throw new GhError("forbidden", message);
        if (fatal.type === "RATE_LIMITED") throw new GhError("rate-limited", message);
        throw new GhError("failed", message);
      }
      if (result.code !== 0 || !body || body.data === undefined) {
        throw classifyFailure(result.stderr, result.stdout);
      }
      return body.data;
    },

    async rest(path, options = {}) {
      const args = ["api", path.replace(/^\//, ""), "--method", options.method ?? "GET"];
      // gh 2.46 has no `--slurp`, and plain `--paginate` prints pages back to
      // back (`[…][…]`). One compact element per line parses unambiguously.
      if (options.paginate) args.push("--paginate", "--jq", ".[]");
      let stdin: string | undefined;
      if (options.body !== undefined) {
        args.push("--input", "-");
        stdin = JSON.stringify(options.body);
      }
      const result = await call(args, stdin);
      if (result.code !== 0) throw classifyFailure(result.stderr, result.stdout);
      if (options.paginate) {
        const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
        return lines.map((line) => {
          const item = parseJson<unknown>(line);
          if (item === undefined) {
            throw new GhError("failed", "GitHub returned a response that is not JSON.");
          }
          return item;
        });
      }
      if (result.stdout.trim() === "") return null;
      const body = parseJson<unknown>(result.stdout);
      if (body === undefined) {
        throw new GhError("failed", "GitHub returned a response that is not JSON.");
      }
      return body;
    },

    async text(args) {
      const result = await call(args);
      if (result.code !== 0) throw classifyFailure(result.stderr, result.stdout);
      return result.stdout;
    },
  };
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

export type GitHub = {
  /** The signed-in github.com accounts, the active one first. */
  accounts(): Promise<string[]>;
  /** gh acting as `login`, one of `accounts()`. */
  as(login: string): Gh;
};

/**
 * Every signed-in `gh` account, each reached with its own token in
 * `GH_TOKEN`, so one bb server reads and writes as several people. A call
 * checks its account is still signed in first, so a token read before a
 * logout is never used after it.
 */
export function createGitHub(run: GhRunner = execGh, now = Date.now): GitHub {
  let accounts: { at: number; read: Promise<GhAccount[]> } | null = null;
  const tokens = new Map<string, Promise<string>>();

  async function readAccounts(): Promise<GhAccount[]> {
    const result = checked(await run(["auth", "status", "--hostname", "github.com"]));
    // gh exits non-zero when any account fails, and older versions print to stderr.
    const found = parseAuthStatus(`${result.stdout}\n${result.stderr}`);
    // Tokens are read again with the accounts: one that signed out goes, and
    // one signed in again with a new token is used from then on.
    tokens.clear();
    if (found.length > 0) return found;
    if (result.code !== 0 && !NO_CREDENTIALS.test(`${result.stderr}\n${result.stdout}`)) {
      throw classifyFailure(result.stderr, result.stdout);
    }
    throw new GhError("unauthenticated", "GitHub CLI is not signed in. Run `gh auth login`.");
  }

  function listAccounts(): Promise<GhAccount[]> {
    if (!accounts || now() - accounts.at >= ACCOUNTS_TTL_MS) {
      const read = readAccounts();
      accounts = { at: now(), read };
      read.catch(() => {
        if (accounts?.read === read) accounts = null;
      });
    }
    return accounts.read;
  }

  /** The signed-in account `login` names, in gh's spelling: GitHub logins ignore case. */
  async function account(login: string): Promise<GhAccount> {
    const key = login.toLowerCase();
    const signedIn = (await listAccounts()).find((a) => a.login.toLowerCase() === key);
    if (signedIn) return signedIn;
    accounts = null;
    tokens.delete(key);
    throw new GhError(
      "unauthenticated",
      `@${login} is not signed in to GitHub CLI on the bb server. Run \`gh auth login\`.`,
    );
  }

  async function readToken(name: string): Promise<string> {
    const result = checked(
      await run(["auth", "token", "--hostname", "github.com", "--user", name]),
    );
    const token = result.stdout.trim();
    if (result.code !== 0 || token === "") {
      throw new GhError(
        "unauthenticated",
        `GitHub CLI has no token for @${name}. Run \`gh auth login\`.`,
      );
    }
    return token;
  }

  /** What a call as `login` adds to gh's environment. Nothing for the server's own `GH_TOKEN`. */
  async function environment(login: string): Promise<Record<string, string>> {
    const signedIn = await account(login);
    if (signedIn.env) return {};
    const key = signedIn.login.toLowerCase();
    let read = tokens.get(key);
    if (!read) {
      read = readToken(signedIn.login);
      tokens.set(key, read);
      read.catch(() => {
        if (tokens.get(key) === read) tokens.delete(key);
      });
    }
    return { GH_TOKEN: await read };
  }

  return {
    accounts: async () => (await listAccounts()).map((a) => a.login),
    as(login) {
      // A login reaches `gh auth token --user`: one that could read as a flag stops here.
      if (!accountSchema.safeParse(login).success) {
        throw new GhError("failed", `${login} is not a GitHub login.`);
      }
      return createGh(async (args, stdin) => {
        const result = await run(args, stdin, await environment(login));
        if (result.code !== 0 && NO_CREDENTIALS.test(`${result.stderr}\n${result.stdout}`)) {
          tokens.delete(login.toLowerCase());
        }
        return result;
      });
    },
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
