import {
  experimental_resolveHostPath,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { assertReconcilable, reconcileDotenv } from "../shared/dotenv.ts";
import {
  SECRET_REQUEST_RENDERER,
  secretRequestResponseSchema,
  variableNameSchema,
} from "../shared/schema.ts";
import { clamp, cliError, threadTarget, type ServerContext } from "./shared.ts";

/** `bb secret request`, unchanged in behaviour from bb's builtin Secrets plugin. */

const PENDING_LABEL_MAX = 80;
const SUBMITTED_TITLE_MAX = 160;

const fileSnapshotSchema = z.object({
  content: z.string(),
  contentEncoding: z.enum(["utf8", "base64"]),
  sha256: z.string(),
});
const writeOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written") }),
  z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
]);

const DESCRIBE_FLAGS = new Set(["--describe", "--description", "--describe-variable"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface SecretRequest {
  names: string[];
  purpose: string | null;
  descriptions: Map<string, string>;
  writeEnv: string;
}

function parseName(name: string, label: string): string {
  const parsed = variableNameSchema.safeParse(name);
  if (!parsed.success) {
    cliError(
      `${label} must start with a letter or underscore and contain only letters, digits, and underscores.`,
      "invalid_variable_name",
    );
  }
  return parsed.data;
}

/** Fold the two-token `--describe NAME TEXT` form into `--describe=NAME=TEXT`. */
export function foldDescribePairs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const name = argv[index + 1];
    const text = argv[index + 2];
    if (
      !DESCRIBE_FLAGS.has(flag) ||
      name === undefined ||
      text === undefined ||
      !IDENTIFIER.test(name) ||
      text.startsWith("--")
    ) {
      out.push(flag);
      continue;
    }
    out.push(`--describe=${name}=${text}`);
    index += 2;
  }
  return out;
}

function parseDescriptions(
  entries: readonly string[],
  names: readonly string[],
): Map<string, string> {
  const descriptions = new Map<string, string>();
  const hint = "Write --describe NAME 'text' or --describe NAME=text.";
  for (const entry of entries) {
    const split = entry.indexOf("=");
    if (split <= 0) cliError("--describe requires NAME and DESCRIPTION.", "invalid_describe", hint);
    const name = parseName(entry.slice(0, split).trim(), "--describe NAME");
    const text = entry.slice(split + 1).trim();
    if (text.length === 0)
      cliError("--describe requires NAME and DESCRIPTION.", "invalid_describe", hint);
    if (descriptions.has(name)) cliError(`Duplicate --describe for ${name}.`, "duplicate_describe");
    if (!names.includes(name)) {
      cliError(`--describe references unrequested variable ${name}.`, "unrequested_describe");
    }
    descriptions.set(name, text);
  }
  return descriptions;
}

export function parseRequest(input: {
  names: readonly string[];
  purpose: string | undefined;
  describe: readonly string[];
  writeEnv: string;
}): SecretRequest {
  const names = input.names.map((name) => parseName(name, "Variable name"));
  if (new Set(names).size !== names.length) {
    cliError("Variable names must be unique.", "duplicate_variable_name");
  }
  const purpose = input.purpose?.trim();
  if (purpose !== undefined && purpose.length === 0) {
    cliError(
      "--purpose requires a non-empty description.",
      "invalid_purpose",
      "Write --purpose 'why these credentials are needed'.",
    );
  }
  const writeEnv = input.writeEnv.trim();
  if (writeEnv.length === 0) cliError("--write-env requires a path.", "invalid_write_env");
  return {
    names,
    purpose: purpose ?? null,
    descriptions: parseDescriptions(input.describe, names),
    writeEnv,
  };
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

async function readSnapshot(
  ctx: ServerContext,
  target: { hostId: string; path: string },
): Promise<{ content: string; sha256: string | null }> {
  try {
    const file = fileSnapshotSchema.parse(await ctx.bb.sdk.files.read(target));
    if (file.contentEncoding !== "utf8") throw new Error("Dotenv file is not valid UTF-8 text.");
    return { content: file.content, sha256: file.sha256 };
  } catch (error) {
    if (httpStatus(error) === 404) return { content: "", sha256: null };
    throw error;
  }
}

export async function runRequest(
  ctx: ServerContext,
  request: SecretRequest,
  context: PluginCliContext,
): Promise<PluginCliResult> {
  const target = await threadTarget(ctx.bb, "request", context);
  const path = experimental_resolveHostPath({ rootPath: target.cwd, path: request.writeEnv });
  if (path === null) cliError("Invalid host path for --write-env.", "invalid_write_env");
  const file = { hostId: target.hostId, path };
  let snapshot = await readSnapshot(ctx, file);
  assertReconcilable(snapshot.content, request.names);

  const label = `${request.names.join(", ")}`;
  const answer = await ctx.bb.ui.requestInput(
    {
      threadId: target.threadId,
      rendererId: SECRET_REQUEST_RENDERER,
      title: "Add secrets",
      payload: {
        purpose: request.purpose,
        destination: { kind: "dotenv", path },
        fields: request.names.map((name) => ({
          name,
          description: request.descriptions.get(name) ?? null,
        })),
      },
      presentation: {
        label: {
          pending: clamp(`Requesting ${label}`, PENDING_LABEL_MAX),
          completed: clamp(`Requested ${label}`, PENDING_LABEL_MAX),
        },
      },
      // Names only: the submitted values never reach the transcript.
      describeSubmission: (value) => {
        const parsed = secretRequestResponseSchema.safeParse(value);
        const names = parsed.success ? Object.keys(parsed.data.values).sort() : [];
        return {
          title: clamp(`Provided ${names.join(", ")}`, SUBMITTED_TITLE_MAX),
          detail: [path, ...names.map((name) => `- ${name}`)].join("\n"),
        };
      },
    },
    { signal: target.signal },
  );
  if (answer.outcome === "cancelled") {
    cliError(`Secret request cancelled (${answer.reason}).`, "secret_request_cancelled");
  }
  const { values } = secretRequestResponseSchema.parse(answer.value);
  if (Object.keys(values).sort().join("\0") !== [...request.names].sort().join("\0")) {
    cliError(
      "Secret response did not contain exactly the requested variables.",
      "unexpected_secret_response",
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = reconcileDotenv(snapshot.content, values);
    const written = writeOutcomeSchema.parse(
      await ctx.bb.sdk.files.write({
        ...file,
        content: next.content,
        contentEncoding: "utf8",
        createParents: true,
        expectedSha256: snapshot.sha256,
        mode: 0o600,
      }),
    );
    if (written.outcome === "written") {
      const summary = {
        path,
        names: request.names,
        added: next.added,
        updated: next.updated,
        unchanged: next.unchanged,
      };
      return { exitCode: 0, stdout: `${JSON.stringify(summary)}\n` };
    }
    if (attempt === 1) {
      cliError(
        "Dotenv file changed twice while secrets were being written; no write was applied.",
        "dotenv_write_conflict",
      );
    }
    snapshot = await readSnapshot(ctx, file);
    assertReconcilable(snapshot.content, request.names);
  }
  cliError("Unreachable dotenv write state.", "unreachable_write_state");
}
