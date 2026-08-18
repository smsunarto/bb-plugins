# One definePlugin composition; the router stays a separate line

Decided 2026-08-17. The composition root collapses from four calls plus
a hand-written factory (`defineRouter`, `defineCLI`, and a
`plugin(bb)` default export calling `registerRouter` and `registerCLI`)
into two: `defineRouter` at module scope, and a
`definePlugin({ router, cli, context, setup? })` default export whose
returned factory does all host wiring. `defineCLI`, `registerRouter`,
and `registerCLI` leave the public API; `definePlugin` ships from a new
`./plugin` subpath, amending ADR-0004's subpath partition. The fused
call also gains checks the split never had: each CLI command's
dependency annotation is validated against the router at compile time
(an error on the offending command's key, naming the missing
procedure), and the `context` callback's return is validated against
`RouterContext`.

`defineRouter` cannot fuse in, and the reason is measured, not
aesthetic. If `Router` and `Caller` derive from the `definePlugin`
result, every CLI unit's `Pick<Caller, …>` annotation closes a type
cycle through the plugin value, which tsc rejects outright
(TS7022/TS2502/TS2456 on 5.9.3). The two known escapes both fail the
design: per-unit interface-extends wrappers defer the cycle but become
impossible the moment definePlugin validates dependencies (TS2615) —
dependency checking and Caller-from-the-plugin-value are architecturally
incompatible — and hoisting a procedures const to derive types from is
this split re-invented. `const router = defineRouter(…)` is the type
anchor, not ceremony, and the two scaffolded aliases
(`export type Router = typeof router; export type Caller =
CallerFor<Router>`) — written once by `create`, self-updating, never
touched by `add` — are the entire price of end-to-end inference.

Rejected: CLI units restating their dependencies structurally instead
of importing `Caller` (cycle-free, but ~3.3× the annotation length per
unit plus a method-syntax bivariance hole in the restated deps); a
TanStack Router–style `Register` interface merge in place of the
aliases (silently loses key-level dependency checking in any typecheck
program that omits `server.ts` — exactly the browser-bundle case — and
collides across two plugins compiled in one program, first declaration
winning). All verified in throwaway compile labs: fusion and aliases on
tsc 5.9.3, the Register degradation on 7.0.2.

## Consequences

- There is no separate CLI name. The CLI mounts as the router
  namespace, which is already the plugin id; a plugin id that collides
  with a host-reserved name cannot mount a CLI at all.
- `invokeCLI` takes the plain command map; tier-1 CLI tests never build
  the plugin value.
- Registration lives inside the returned factory, so it cannot drift
  into timers or request handlers unless `setup` puts it there.
- ADR-0009 is untouched: `add` still prints one import and one map key,
  now into `definePlugin`'s `commands`.

## Amended 2026-08-17

Renames, same shape: `defineRouter` is now `defineRPC` and takes one
object — `defineRPC({ namespace, procedures })` — the `definePlugin`
key is `rpc`, and `Caller`/`CallerFor`/`createCaller` are now
`Client`/`ClientFor`/`createClient`. The scaffolded aliases read
`export type RPC = typeof rpc; export type Client = ClientFor<RPC>`.

The per-command dependency check this ADR introduced is dropped.
Commands no longer annotate `Pick<Caller, …>` subsets; each command
takes the full `Client` via a type-only import from `server.ts`, so a
missing procedure is an ordinary TS property error at the call site
rather than an error on the command's key. `Pick<Client, …>` stays
legal for a command that wants a minimal fake in its unit test — it is
just no longer scaffolded. A command that hand-annotates a demand the
RPC cannot meet still errors on its own key in `commands`: the plain
constraint `C extends Record<string, CLICommand<ClientFor<R>>>` does
that with no branded helper, verified in a fresh compile lab (tsc
5.9.3 and 7.0.2, identical diagnostics). The cycle finding is
unchanged and name-independent — any type derived from the
`definePlugin` value still cycles — so the RPC stays a separate line
for the same measured reason; the aliases are no longer "the entire
price of end-to-end inference" but the price of breaking that cycle.

One new pin from that lab: `CLICommand` must declare `run` as a
function property (`run: (rpc: D, …) => Promise<…>`), never method
syntax. Method syntax makes the dependency parameter bivariant, and a
command demanding Client-plus-extra procedures then compiles silently.
Only the type's syntax matters — command object literals may still
write `async run(…) {…}`. `definePlugin`'s own `context`/`setup` seam
keeps method syntax on purpose: bivariance is wanted there.
