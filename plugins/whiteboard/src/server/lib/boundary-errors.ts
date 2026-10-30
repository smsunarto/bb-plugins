import { experimental_PluginRpcRefusal as PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import { HostUnavailableError } from "./host-io/client.ts";

/**
 * How an operation's failure reaches a caller. Expected failures carry a
 * message safe to show and an RPC refusal code; anything else is a crash,
 * reported only by its kind because provider errors may hold local paths or
 * subprocess output.
 */
type Failure =
  | {
      expected: true;
      code: PluginRpcRefusal["code"];
      message: string;
      issues?: { message: string; path: (string | number)[] }[];
    }
  | { expected: false; message: string };

const REFUSALS: Record<ReviewInputError["status"], PluginRpcRefusal["code"]> = {
  400: "invalid",
  401: "forbidden",
  404: "not_found",
  409: "conflict",
};

const systemErrorSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]+$/) });

/** A system error code such as EACCES, else the error's class; never its message. */
function failureKind(error: unknown): string {
  const system = systemErrorSchema.safeParse(error);
  if (system.success) return system.data.code;
  return error instanceof Error ? error.name : typeof error;
}

function classify(operation: string, error: unknown): Failure {
  if (error instanceof ReviewInputError)
    return { expected: true, code: REFUSALS[error.status], message: error.message };
  // The checkout's host is offline: routine under local-first use, and the
  // message names that machine so the reader can bring it back.
  if (error instanceof HostUnavailableError)
    return { expected: true, code: "conflict", message: error.message };
  if (error instanceof z.ZodError)
    return {
      expected: true,
      code: "invalid",
      message: z.prettifyError(error),
      issues: error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.filter((key) => typeof key !== "symbol"),
      })),
    };
  // The caller or its thread gave up; nothing failed.
  if (error instanceof Error && error.name === "AbortError")
    return { expected: true, code: "conflict", message: error.message };
  // The plugin runs inside the bb server, whose launcher appends stderr to
  // logs/server-stdio.log.
  console.error(`[Whiteboard] ${operation} failed:`, error);
  return {
    expected: false,
    message: `Whiteboard operation failed (${failureKind(error)}). The bb server logged the cause in server-stdio.log, in the bb server's logs folder.`,
  };
}

/** What an RPC handler throws: a refusal bb does not record as a plugin crash, or a crash. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Error boundary: anything an operation threw.
export function rpcError(operation: string, error: unknown): Error {
  const failure = classify(operation, error);
  if (!failure.expected) return new Error(failure.message);
  return new PluginRpcRefusal({
    code: failure.code,
    message: failure.message,
    ...(failure.issues && { issues: failure.issues }),
  });
}

/** The text an agent tool answers with `isError` for any failure. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Error boundary: anything an operation threw.
export function toolErrorText(operation: string, error: unknown): string {
  return classify(operation, error).message;
}
