# Plugin tests run headless in three tiers; the browser is release QA only

Decided 2026-08-17. A bb-kit plugin has three test tiers, all runnable with no
bb instance, no agent-browser, and no Playwright:

1. **Unit** — business logic behind injected plain-object fakes. No SDK
   import at all.
2. **Integration** — the plugin entrypoint, RPC procedures, and CLI commands
   exercised against the fake plugin host from `@get-bb/plugin-sdk/testing`.
3. **UI component** — app slots rendered with `@get-bb/plugin-sdk/testing/app`
   under jsdom.

A live browser against a running bb is not a test tier. It is a release QA
ritual (screenshots, visual checks) done before publishing, outside the inner
loop and outside CI.

The 0.1-era loop needed a running bb plus agent-browser for routine
verification, which was the top stated pain of plugin development. The SDK now
ships both harnesses, and dotfiles already proved that DI'd services test
cleanly without a host.

## Consequences

- The framework API must make dependency injection the default shape (a
  context object assembled at the entrypoint); otherwise tier 1 cannot exist.
- The SDK harnesses become load-bearing. Drift between harness behaviour and
  the live host is an accepted risk, caught at release QA, not in CI.
- There is no visual-regression net in CI.
