import { z } from "zod";

/** Renderer ids: `secret-request` keeps the builtin's id so its form is unchanged. */
export const SECRET_REQUEST_RENDERER = "secret-request";
export const SUDO_REQUEST_RENDERER = "sudo-request";

const SECRET_VALUE_MAX_BYTES = 16 * 1024;

export const variableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const secretRequestPayloadSchema = z.object({
  purpose: z.string().min(1).nullable(),
  destination: z.object({ kind: z.literal("dotenv"), path: z.string().min(1) }),
  fields: z
    .array(z.object({ name: variableNameSchema, description: z.string().min(1).nullable() }))
    .min(1),
});
export type SecretRequestPayload = z.infer<typeof secretRequestPayloadSchema>;

const singleLineSecret = z
  .string()
  .min(1)
  .max(SECRET_VALUE_MAX_BYTES)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), {
    message: "Secret values must be single-line strings",
  })
  .refine((value) => !value.includes("\0"), { message: "Secret values must not contain NUL" });

export const secretRequestResponseSchema = z.object({
  values: z.record(variableNameSchema, singleLineSecret),
});

/** The password form for a thread with no cached password. Never carries the password. */
export const sudoRequestPayloadSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  host: z.string().min(1),
  purpose: z.string().min(1).nullable(),
  cacheMinutes: z.number().int().positive(),
});
export type SudoRequestPayload = z.infer<typeof sudoRequestPayloadSchema>;

export const sudoRequestResponseSchema = z.object({
  approved: z.literal(true),
  password: singleLineSecret,
});

/** Bound on each captured stream; a sudo command is not a file transfer. */
export const SUDO_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

export const sudoRunResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ran"),
    exitCode: z.number().int(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
  }),
  /** No password cached (never entered, expired, or evicted). */
  z.object({ outcome: z.literal("needs_password") }),
  /** sudo rejected the password; it has been dropped and must be typed again. */
  z.object({ outcome: z.literal("auth_failed"), detail: z.string() }),
  z.object({ outcome: z.literal("unsupported"), detail: z.string() }),
]);
export type SudoRunResult = z.infer<typeof sudoRunResultSchema>;
