# The bb plugin development workflow

This is the workflow the bb-kit rewrite is designed around (2026-08-17,
ADRs 0005–0011). The framework contract — including the authoritative
scaffold manifest — lives in `docs/bb-kit-spec.md`; this document is the
workflow view of it. Nothing in the framework may add a step to this
loop. All host-facing commands are verified against bb 0.38 source.

## Three loops, by frequency

| Loop | Needs | When |
|---|---|---|
| Inner: `node --test --watch` | Node ≥ 22.19 + dev dependencies | every edit |
| Live: `bb plugin dev` | running bb + installed plugin | host-visible behaviour |
| Release QA: browser ritual | release build in a real bb | before each release |

The framework's job is to make the inner loop good enough that the other
two stay rare. No agent-browser, no Playwright, no running bb in the
routine loop.

## Start a plugin

```sh
npx @bb-kit/core create my-plugin
cd my-plugin
```

`create` writes the tree and runs the install, so the first `npm test`
already passes. The prerequisites are Node ≥ 22.19 (bb's own engines
floor; type-stripping is on by default from 22.18, so `.ts` runs directly
with no build step and no other runtime, ADR-0006) — and npm. The scaffold
is a working plugin, not
a stub: a `defineQuery` procedure, a `defineCommand`, and a minimal
app each arrive with a passing sibling test. The tree is the flat layout
(ADR-0007):

```
my-plugin/
  package.json     # "test": "node --test --import tsx"; "typecheck": "tsc";
                   # bb.app → ./ui/app.tsx; bb.branding.icon → ./assets/icon.svg;
                   # exact @get-bb/plugin-sdk + @bb-kit/core devDependencies
  tsconfig.json    # nodenext + allowImportingTsExtensions + noEmit —
                   # .ts-suffixed imports typecheck; nothing ever emits
  server.ts        # composition root — the only wiring file
  server.test.ts   # tier-2: the default-export factory against the fake host
  rpc/
    ping.ts        # a defineQuery
    ping.test.ts
  cli/
    status.ts      # a defineCommand over the typed RPC client
    status.test.ts
  server/
    context.ts     # createContext(bb) assembles the one Context handlers
                   # annotate — `{}` until the plugin grows dependencies
  ui/
    app.tsx        # the app entry (bb.app)
    app.test.ts    # tier-3: renderSlot under jsdom
    rpc.ts         # the RPC hooks, bound once via createRPC — the only
                   # place the namespace is written
  assets/
    icon.svg       # the bb.branding icon — the host manifest requires one
  README.md
```

`server/` ships with `context.ts` alone — `definePlugin`'s required
`context` entry is `createContext`, passed point-free — and grows only
when you need more. The UI ships by default;
CLI-first is a testing order — prove behaviour through RPC and CLI before
wrestling with UI correctness — not an omission. Because `create` pins
`@bb-kit/core` as a devDependency, every later framework command is
`npx bb-kit …`.

## The inner loop

```sh
npm test -- --watch
```

`scripts.test` is `node --test --import tsx`. Discovery is Node's own
default — every `**/*.test.ts`, subdirectories included, no globs, no
config. The tsx loader is there for one reason: Node strips types but
does not transform JSX, so it carries any import that reaches `ui/`.
Test files stay `.ts` — a `.test.tsx` is never discovered. Three
headless tiers, none needing a bb instance (ADR-0005):

1. **Unit** — logic behind injected plain-object fakes; no SDK import.
2. **Integration** — the entrypoint, procedures, and CLI commands against
   `createFakePluginHost` from `@get-bb/plugin-sdk/testing`.
3. **UI component** — app slots rendered with `renderSlot` from
   `@get-bb/plugin-sdk/testing/app` under jsdom.

The scaffold pins the harnesses' peers (tsx, react, react-dom,
@tanstack/react-query, @testing-library/react, jsdom, better-sqlite3,
hono, cron-parser) as devDependencies — and `zod` as a runtime
dependency — so tiers 2 and 3 run on the first `npm test` too; the
spec's §7 owns the authoritative manifest. Write the test in the
sibling file, watch it go green, move on.

## Growing the surface

```sh
npx bb-kit add query <name>      # a read procedure, in rpc/
npx bb-kit add mutation <name>   # a write procedure, in rpc/
npx bb-kit add command <name>    # a CLI command, in cli/
```

`add` writes the new file and its sibling test, then prints the exact
wiring lines — the import plus the map key, into `defineRPC`'s
procedures or `definePlugin`'s commands — for you (or your agent) to
paste into `server.ts`. It never edits your files (ADR-0009).

```sh
npx bb-kit check
```

`check` fails until the wiring exists, so a forgotten paste cannot ship.
It also catches manifest breakage (entry targets, engines pins) and
duplicate wire names. Wire names derive from the RPC namespace and
procedure key and are public API — renaming one is a breaking change
(ADR-0008).

## The live loop

When you need the plugin inside bb — panel rendering against real data,
settings UI, skill behaviour — install it once into your dev instance,
then let the host watch:

```sh
bb plugin install /path/to/my-plugin --yes
bb plugin dev
```

`bb plugin dev` takes the plugin directory as an optional argument and
defaults to the current one; it needs the plugin installed and the server
running. On change it rebuilds the frontend bundle (when the manifest
declares `bb.app`) after a 300 ms debounce and asks the server to reload;
the backend is re-imported from source on reload, so server edits need no
build at all. bb-kit adds nothing here on purpose (ADR-0010): the host's
own loop arrives with every bb upgrade, for free.

Once installed, every procedure is also a terminal command — the RPC
subtree (ADR-0013) mounts `bb <plugin-id> rpc <procedure> '<json>'`
automatically, with no CLI command written. Smoke-test a procedure from
the shell before it has a curated command or a UI.

## Release

Run the release QA ritual first — open the plugin in a real browser
inside bb, take the screenshots, check the visuals. That is the only
place a browser appears in this document. Then:

```sh
git tag v1.2.0 && git push --tags
```

The leading `v` is required: bb's resolver lists only `v*` tags.
Consumers install straight from the tags, with semver resolution
(ADR-0011):

```sh
bb plugin install git:github.com/you/my-plugin@semver:^1
```

The `git:` prefix matters — a bare `github.com/…` is read as a local
path. A full `https://` URL also works. bb clones, resolves the best
matching tag, and builds the server bundle — plus the frontend when the
plugin declares one — against the installing host's SDK, with lifecycle
scripts disabled, so a git release never goes stale when the SDK bumps.
Monorepo plugins add `--subdirectory` (or `--plugin`) and `--tag-prefix`.

## Never in the loop

- No agent-browser or Playwright for routine verification.
- No generated catalogs, no lock file, nothing to regenerate.
- No committed `dist/`; building is the host's job at install.
- No `npm publish` while the plugin SDK's major is 0.
