# Dotfiles

- Keep `src/shared/domain.ts` browser-safe: import only `zod`, so `src/app/` and `src/host/` can value-import it.
- RPC map keys are a public contract. Do not rename them.
- Repo work runs in `src/host/host.ts` on the target machine, never in the server process. The server's machine is only the default target.
- Parse git output from `execFile("git", ...)` only. The login shell merges stderr into its output, so it is for display-only task runs.
