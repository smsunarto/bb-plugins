# Tool parameters are zod object schemas

Decided 2026-08-22. `defineTool`'s `parameters` must be a zod object
schema — parsed output extends `Record<string, unknown>`, the same
object-only rule as procedure I/O (ADR-0014) — and bb-kit hands it to
the host's validating `registerTool` overload unchanged. This is
narrower than Procedures, which accept any Standard Schema: the host
must advertise a JSON schema for every tool, and its zod overload is
the only path that both converts (the server's own `z.toJSONSchema`)
and validates before `execute` runs. Standard Schema has no
JSON-schema export, so library-generic tool parameters cannot exist.

Passing the schema through also inherits the host's parse-first
contract: invalid arguments return `Invalid arguments for tool
"<name>": …` to the model without running plugin code, and `execute`
receives the parsed `z.output<Schema>` value typed. bb-kit never
validates a tool call itself.

The host's raw JSON-schema overload goes unmodeled: it validates
nothing, types `execute`'s input as `unknown`, and no plugin uses it.
Results pass through as the host's full result type — a plain string
or content parts with `isError`. Every existing tool returns plain
strings, but admitting the rich form costs nothing.

One dependency to note: the host converts with its own zod 4, so a
plugin zod copy incompatible with `z.toJSONSchema` fails registration
with a clear error. All bb-plugins ship zod 4.

Rejected: accepting any Standard Schema, converting framework-side,
and validating over the raw overload (bb-kit would own conversion,
validation, and error formatting the host already does — and the
conversion needs zod anyway); modeling the raw overload (unvalidated,
untyped, unused); allowing non-object roots (tool parameters are
object-rooted everywhere a model sees them, and ADR-0014's add-a-key
evolution argument applies unchanged).

## Consequences

- `defineTool` constrains `parameters` with a zod-bound form of the
  `JSONObjectSchema` rule; a non-zod or non-object schema is a
  define-time type error.
- Validation and the invalid-arguments reply stay host-owned.
- The return type is the host's result type, passed through.
