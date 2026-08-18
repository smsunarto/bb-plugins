# Every plugin CLI mounts an always-on rpc subtree

Decided 2026-08-17. Every plugin's CLI mounts `bb <plugin-id> rpc` —
one subcommand per procedure, named by kebab-casing the procedure key
(`readURL` → `read-url`) — whether or not the plugin declares a `cli`
entry. With no `cli` entry the framework registers the CLI anyway,
with a default summary; a curated `cli` entry adds commands beside the
subtree, never instead of it. Each subcommand takes a single optional
positional that must parse to a JSON object (ADR-0014), prints the
result as compact JSON on stdout with exit 0, and reports validation
issues, thrown errors, and malformed input on stderr with exit 1.
Dispatch goes through the plugin's own validating Client, so both
directions are checked exactly as an in-process call would be, and
`--help` labels every procedure `(query)` or `(mutation)`.

The trade-off is real: a curated-only CLI keeps the command surface
minimal and intentional, but it makes every procedure unreachable from
the terminal until a human writes a command for it. Procedures are the
plugin's actual capability surface, and the dominant terminal user is
an agent that reads `--help` and speaks JSON natively — for that user
the subtree is the whole point of having a CLI. Curated commands
remain the place for human ergonomics (positional arguments, flags,
readable output); the subtree is deliberately uniform and boring.

Rejected: opt-in mounting via the `cli` entry (the CLI-less plugin —
the common early state — is exactly the one that benefits most);
per-procedure opt-out flags (surface area with no observed need — a
procedure too dangerous for the subtree is too dangerous for the wire,
which is the same access); flattening procedures into top-level
commands (collides with curated command names and erases the
curated/generated distinction).

## Consequences

- `rpc` and `help` are reserved `commands` keys: a define-time error
  and a check rule. The guard is framework-level because commander
  13.1.0 throws a cryptic plain `Error` on a duplicate command and
  silently lets an explicit `help` shadow the implicit help (both
  verified against commander 13.1.0).
- A procedure key that kebabs to `help` is a check failure. Post-kebab
  collisions between procedure keys coincide with wire-name
  collisions, which check already fails.
- A plugin id that collides with a host-reserved top-level name loses
  the whole CLI, subtree included (unchanged from ADR-0012).
- `invokeCLI` does not mount the subtree; tier-1 tests exercise
  curated commands only. Subtree behaviour is framework code, tested
  once in the framework, not per plugin.
- The host's 1 MiB combined stdout/stderr cap applies to subtree
  output like any plugin CLI output.
- The `kind` discriminant on procedures is now read by the subtree's
  help renderer, so "nothing on the server branches on it" no longer
  holds; the spec's §3 is amended accordingly.
