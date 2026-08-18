# Procedure input and output are JSON objects

Decided 2026-08-17. A procedure's declared input schema and its output
schema must both parse to a JSON object — never a bare string, number,
array, or null. Enforced at define time by a vendored type constraint,
`JSONObjectSchema`: a Standard Schema whose parsed (output) type
extends `Record<string, unknown>`. The no-input convention is exempt
and unchanged — omitting `input` is not a non-object input; the
vendored no-input schema still accepts null and undefined, and the CLI
subtree still passes null when the positional is omitted. The subtree
(ADR-0013) enforces the same shape at runtime: a supplied positional
must parse to a JSON object or the call fails before dispatch.

Objects are the only shape that evolves without breaking: extending a
procedure is always "add a key", never "wrap the old value", and the
wire never carries an invented wrapper key. They are also what the
subtree's contract needs — every subcommand takes one JSON object and
prints one.

The constraint was verified in a compile lab against real zod 4.4.3 on
tsc 5.9.3 and 7.0.2 (identical verdicts). `z.object(…)` passes,
including optional properties, unions of objects, and
`z.record(z.string(), z.unknown())`. Rejected as intended: primitives,
arrays, dates, void, null, `.nullable()`, and top-level `.optional()`
— optionality must live inside the object, not on it. One asymmetry to
document, not fix: `z.ZodType<SomeInterface>` fails the constraint
because interfaces get no implicit index signature — annotate schemas
with type aliases, not interfaces (both the type-alias and plain
z.object-inference forms compile). Violations surface as a TS2769 with
two nested error blocks; the named helper keeps the first line
self-describing and gives one place to widen the rule later. The
constraint structurally matches zod v4's `_zod.output`, so zod 3 root
schemas never satisfy it — acceptable, since bb and bb-plugins ship
zod 4 and zod 3.25+ users can `import "zod/v4"`.

Rejected: runtime-only enforcement (fails at call time, after ship,
instead of under the author's cursor); accepting any JSON value and
auto-wrapping primitives (invents a permanent wire key); constraining
input but not output (breaks the subtree's print contract and the
add-a-key evolution property exactly where results live longest).

## Consequences

- `defineQuery`/`defineMutation` constrain both schemas with
  `JSONObjectSchema`; a primitive schema is a define-time type error.
- Scaffold and docs annotate schema types with type aliases, never
  interfaces.
- The subtree can rely on object-in, object-out without a wrapper
  protocol.
