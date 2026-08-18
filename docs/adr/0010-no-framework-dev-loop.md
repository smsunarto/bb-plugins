# bb-kit does not own a dev loop

Decided 2026-08-17. The `bb-kit` bin ships `create`, `add`, and `check` — no
dev, build, test, or watch commands. The inner loop is `node --test --watch`
over the three headless tiers (ADR-0005). The live loop is the host's own
tooling: `bb plugin dev` (watch → rebuild → reload against a running
server), `bb plugin build`, `bb plugin types`.

bb-kit 0.1's worst scars came from owning this loop: its watcher
hard-required a live bb for routine verification. Wrapping the host's tools
would also mean chasing them release over release, while the host's versions
arrive with every bb upgrade for free.

## Consequences

- bb-kit has no daemon, watcher, or port; nothing to keep alive and nothing
  to go stale.
- Changes to bb's dev tooling reach plugin authors through the host upgrade,
  with no bb-kit release.
- None of `create`, `add`, `check` needs a running bb. If a future command
  shells out to bb, the env-strip and exact-SDK-version guard applies to it.
