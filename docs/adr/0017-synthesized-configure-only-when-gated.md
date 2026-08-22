# bb-kit synthesizes configure only when gating is declared

Decided 2026-08-22. A tool opts into gating with an optional
`enabled(context, session)` predicate; a plugin narrows skills with
`agents.skills` — a static name list or a `(context, session) =>
string[]` selector. When either appears, bb-kit synthesizes the
plugin's single `configure` call: it lists every ungated tool, every
gated tool whose predicate passed, and the declared skill names. When
neither appears, bb-kit registers no configure at all, so the host's
all-on default stays in force. `session` is the host's configure
context, passed through typed and unwrapped.

The skill names must be declared because the host gives no other
option: `skills` is a required field of every configure result, and
an unknown name rejects the plugin's whole selection — tools
included, fail-closed. There is no "omit to keep skills on", and the
framework cannot know the manifest names without reading the
filesystem. `agents.skills` absent means the plugin has no manifest
skills, and the synthesized configure emits an empty list. The
checker closes the drift hole: it already parses `bb.skills` manifest
roots, so it requires `agents.skills` whenever a gated plugin has
manifest skills, and pins a static list to the manifest enumeration
(the host requires a skill's frontmatter name to equal its directory
name).

Two neighbouring host features stay unmodeled behind the `bb` escape
hatch: the configure result's own per-resolution `instructions` field
(`agents.instructions` is the one instructions path, and already runs
per session and may return null) and per-call parameter narrowing
(`PluginAgentToolSelection.parameters`; no plugin narrows). Host
fail-closed semantics pass through unchanged: a throwing predicate or
selector rejects the plugin's whole selection, exactly as a
hand-written configure would.

Rejected: enumerating skill names at runtime from package.json and
the skill roots (bb-kit's runtime does no filesystem work today, and
a read hiccup would fail the plugin's entire selection closed at
runtime — drift caught by the checker is the better failure mode);
always registering a configure (forces every agents-using plugin to
declare skills, and replaces the host's default with a copy the
framework must keep faithful); modeling the second instructions path
(two ways to say the same thing).

## Consequences

- `definePlugin`'s agents key carries tools plus optional
  `instructions` and `skills`; gating lives on the tool as `enabled`.
- A plugin using gating must not also call `bb.agents.configure` in
  `setup` — the host rejects the repeat registration.
- The checker gains two manifest-coupled rules: `agents.skills`
  required when a gated plugin has manifest skills, and a static list
  must equal the manifest enumeration.
- Ungated, undeclared plugins register no configure and cannot hit
  this concern's failure modes.
