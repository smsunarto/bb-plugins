import type { SudoRunResult } from "../shared/schema.ts";
import { PasswordCache, type WorkerLease } from "./cache.ts";
import type { SudoRunner } from "./sudo.ts";

export interface SudoRunInput {
  threadId: string;
  argv: string[];
  cwd: string;
  password?: string | undefined;
  cacheMs: number;
  timeoutMs: number;
}

export interface SudoHandlerContext {
  signal: AbortSignal;
  retain: () => WorkerLease;
}

export function createSudoHandlers(runner: SudoRunner, cache = new PasswordCache()) {
  return {
    cache,
    forget: (threadId: string) => ({ forgotten: cache.clear(threadId) }),
    async run(input: SudoRunInput, context: SudoHandlerContext): Promise<SudoRunResult> {
      if (process.platform === "win32") {
        return { outcome: "unsupported", detail: "sudo is not available on Windows hosts." };
      }
      // A private copy for this call: a concurrent forget, expiry, or new
      // password zero-fills the cache's Buffer, which must not turn into a
      // NUL password (and a faillock strike) halfway through this call.
      let password: Buffer;
      if (input.password !== undefined) {
        password = Buffer.from(input.password, "utf8");
        const check = await runner.validate(password, context.signal);
        if (!check.ok) {
          password.fill(0);
          return { outcome: "auth_failed", detail: check.detail };
        }
        cache.set(input.threadId, Buffer.from(password), input.cacheMs, context.retain);
      } else {
        const cached = cache.get(input.threadId);
        if (cached === null) return { outcome: "needs_password" };
        password = Buffer.from(cached);
        // Re-check before every use: a password changed since it was cached
        // fails here once and is dropped, instead of failing the command with
        // an exit code that looks like the command's own.
        const check = await runner.validate(password, context.signal);
        if (!check.ok) {
          password.fill(0);
          cache.clear(input.threadId);
          return { outcome: "auth_failed", detail: check.detail };
        }
      }
      try {
        const output = await runner.run({
          argv: input.argv,
          cwd: input.cwd,
          password,
          timeoutMs: input.timeoutMs,
          signal: context.signal,
        });
        return { outcome: "ran", ...output };
      } finally {
        password.fill(0);
      }
    },
  };
}
