# bb-kit plugin conventions

- Organize behavior under `plugin/modules/<name>/`.
- Keep `contract.ts` and `model.ts` browser-safe.
- Frontend code must not import `server.ts` or `repository.ts`.
- Implement business behavior as headless operations.
- RPC is authoritative; realtime signals only invalidate queries.
- Expected domain outcomes use discriminated unions.
- Create host resources inside the plugin generation.
- Import `noInput` directly for no-input operations; give every other input a literal JSON `exampleInput`.
- Run `bun run typecheck` while editing and `bun run verify` before handoff.
