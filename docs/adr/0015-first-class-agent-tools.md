# Agent tools are a first-class bb-kit concern

Decided 2026-08-22. bb-kit models the host's agent-tool API — tool
registration, tool and skill enablement (`configure`), and
thread-instructions contribution (`contributeInstructions`) — as a
first-class `definePlugin` concern with the same treatment RPC and CLI
get: one unit per file, derived public names, checker enforcement. The
concern ships inside 0.1.0, before the first npm publish.

Tool names are a real public contract: the host registers them
verbatim (no per-plugin prefixing), requires uniqueness across every
installed plugin, and on a collision silently drops the later
registration to a status detail. That is exactly the class of contract
the checker exists to print and pin, and today it cannot see that a
plugin has tools at all. The usage census (2 of 9 plugins, 10 tools)
shows the same boilerplate hand-repeated everywhere: hand-written
`<pluginId>_<key>` name prefixes on all 10 tools, identical
statusLabel shapes, zod-parameters-plus-typed-execute mirroring
`defineRPC`, and plain-string returns. Every existing tool name
already equals `wireName(namespace, key)` — the derivation machinery
is built.

Full parity, rather than tool units alone, is deliberate: a framework
that models registration but leaves `configure` and
`contributeInstructions` as raw `bb.agents` calls forces plugins to
straddle the framework and the SDK for one concern. The framework
exposes the SDK's API so a plugin never has to bypass it.

Rejected: documenting the registrar pattern and stopping (the checker
stays blind, the name contract stays unenforced, the boilerplate stays
hand-rolled); modeling tool units only (splits one concern across
framework and raw SDK calls); deferring past 0.1.0 (additive later,
but 0.1.0 is still unpublished, so shipping first avoids an immediate
0.2.0 and lets notify finish its migration in one pass).

The experimental provider-registration API
(`experimental_registerProvider`) is not part of this decision.

## Consequences

- `HostSeam` gains a third member for agent-tool registration.
- The checker learns a new unit directory and prints tool names as
  public contract, like wire names.
- The spec's API-surface list grows by one subpath export.
- The 0.1.0 publish (already waiting on npm login) also waits on this
  work.
- notify's `server/agent-tool.ts` registrar migrates onto the new
  concern.
