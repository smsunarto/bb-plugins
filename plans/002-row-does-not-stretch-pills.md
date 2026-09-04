# Plan 002: Stop `Row` from stretching `Pill` children across the full width

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7f273313..HEAD -- plugins/canvas/src/app/components.tsx`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition. HEAD is a GitButler workspace commit that moves with other
> branches; diffs in other files are expected.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (touches the same file as 001, different functions)
- **Category**: bug
- **Planned at**: commit `7f273313`, 2026-09-04

## Why this matters

`Row` is the only horizontal layout primitive, and its children get
`flex-1 min-w-32`, which is right for `Stat` and `Card` but wrong for `Pill`.
The plugin's own `github-style` example puts two pills in a `Row`, and they
render one at the left edge and one starting at the 50% mark, with the second
pill's text far from the first (verified on screen in the dev instance). Authors
reach for `Row` because the SKILL tells them to use `Pill` for status, and the
docs give no other inline grouping. After this plan, pills inside a `Row` sit
side by side at their natural width and wrap, while stats and cards keep
filling the row.

## Current state

`plugins/canvas/src/app/components.tsx:72-93`:

```tsx
function Row(props: CanvasComponentProps): ReactElement {
  const {
    gap = "md",
    align = "stretch",
    wrap = true,
  } = typed<{
    gap?: "sm" | "md" | "lg";
    align?: "start" | "center" | "end" | "stretch";
    wrap?: boolean;
  }>(props.props);
  const alignClass = {
    start: "items-start",
    center: "items-center",
    end: "items-end",
    stretch: "items-stretch",
  }[align];
  return (
    <div
      className={`canvas-block flex ${wrap ? "flex-wrap" : ""} ${gapClass[gap]} ${alignClass} [&>*]:min-w-32 [&>*]:flex-1 [&>*]:[overflow-wrap:anywhere]`}
    >
      {props.renderNodes(props.nodes)}
    </div>
  );
}
```

`plugins/canvas/src/app/components.tsx:235-245`:

```tsx
function Pill(props: CanvasComponentProps): ReactElement {
  const { label, tone = "neutral" } = typed<{ label: string; tone?: Tone }>(props.props);
  return (
    <span
      className={`canvas-pill my-1 inline-block rounded-full border px-2 py-0.5 text-[0.75em] ${toneSurface[tone]} ${toneText[tone]}`}
      data-tone={tone}
    >
      {label}
    </span>
  );
}
```

The example that shows the bug, `plugins/canvas/examples/github-style.canvas.mdx:35-38`:

```mdx
<Row gap="sm">
  <Pill label="style: github" tone="info" />
  <Pill label="frontmatter parsed" tone="success" />
</Row>
```

Why a class on `Pill` alone is not enough: Tailwind compiles `[&>*]:flex-1` to
`.\[\&\>\*\]\:flex-1 > *`, specificity (0,1,0), the same as a `flex-none` on the
pill. Which one wins then depends on stylesheet order, which is not something
to rely on. Excluding pills in the `Row` selector gives (0,2,0) and wins
deterministically.

Conventions: Tailwind utility classes with arbitrary variants are the norm in
this file (see `[&>*]:min-w-32` already there). Tests use `bun:test`,
`node:assert/strict`, and `renderSlot` from `@get-bb/plugin-sdk/testing/app`;
`plugins/canvas/src/app/canvas.test.tsx:1-40` has the setup boilerplate.

## Commands you will need

Run from the repository root `~/git/bb-plugins`.

| Purpose          | Command                                  | Expected on success |
| ---------------- | ---------------------------------------- | ------------------- |
| Typecheck plugin | `bun run --cwd plugins/canvas typecheck` | exit 0              |
| Tests (plugin)   | `bun run --cwd plugins/canvas test`      | 0 fail              |
| Build plugin     | `bun run --cwd plugins/canvas build`     | exit 0              |
| Lint / format    | `bun run lint && bun run fmt`            | exit 0              |
| Dev instance     | `bun run dev:instance`                   | prints a local URL  |

`bun run dev` must already be running (repo `CLAUDE.md`).

## Scope

**In scope**:

- `plugins/canvas/src/app/components.tsx` (the `Row` function only)
- `plugins/canvas/src/app/components.test.tsx` (create, or extend if plan 001
  already created it)

**Out of scope**:

- `Pill` itself, `Stat`, `Card`, `Grid` — behaviour for those stays as is.
- `plugins/canvas/src/app/app.css` and `styles/github.css`.
- The examples and README. The existing example is the regression fixture; do
  not rewrite it to avoid the bug.
- Adding a new `Pills` / `Inline` component. One selector change fixes the
  observed problem; a new component is a product decision.

## Git workflow

- GitButler branch `scott/canvas-row-pills` (or the same branch as plan 001 if
  executing both in one session). Use `but diff` then
  `but commit -b <branch> -m "fix(canvas): keep pills at natural width inside Row" <ids>`.
- Do NOT push or open a PR.

## Steps

### Step 1: Exclude pills from the stretch rules in `Row`

Change the `className` template in `Row` (line 91) from:

```
[&>*]:min-w-32 [&>*]:flex-1 [&>*]:[overflow-wrap:anywhere]
```

to:

```
[&>:not(.canvas-pill)]:min-w-32 [&>:not(.canvas-pill)]:flex-1 [&>.canvas-pill]:flex-none [&>*]:[overflow-wrap:anywhere]
```

Add a one-line comment above the `return` explaining that pills keep their
natural width while stats and cards fill the row.

**Verify**: `grep -n "not(.canvas-pill)" plugins/canvas/src/app/components.tsx`
→ 2 matches on the `Row` className line.
`bun run --cwd plugins/canvas typecheck` → exit 0.

### Step 2: Regression test

In `plugins/canvas/src/app/components.test.tsx` (create with the setup block
copied from `canvas.test.tsx:1-30` if plan 001 has not created it), render a
canvas whose source is the three-line `Row` + two `Pill` snippet from the
example above, and assert:

- The pills' parent element has the class string containing
  `[&>:not(.canvas-pill)]:flex-1` and `[&>.canvas-pill]:flex-none`.
- A `Row` containing two `Stat` blocks still has `[&>:not(.canvas-pill)]:flex-1`
  (i.e. the class is unconditional, stats still stretch).

happy-dom does not compute Tailwind layout, so class assertions are the
machine-checkable proxy; the visual check is step 3.

**Verify**: `bun run --cwd plugins/canvas test` → 0 fail, new test included.

### Step 3: Build and eyeball

1. `bun run --cwd plugins/canvas build && bun run lint && bun run fmt` → exit 0.
2. In `bun run dev:instance`, open `plugins/canvas/examples/github-style.canvas.mdx`.
   Expected: the two pills sit next to each other at the left with a small gap.
   Open `plugins/canvas/examples/flaky-test-triage.canvas.mdx`. Expected: the
   `Row` of `Stat` blocks near the top still spans the full width in equal columns.

**Verify**: a one-line note of what you saw for both examples.

## Test plan

- New/extended `plugins/canvas/src/app/components.test.tsx`: pills-in-Row
  emits the exclusion classes; stats-in-Row unchanged. Model after
  `plugins/canvas/src/app/canvas.test.tsx`.
- Verification: `bun run --cwd plugins/canvas test` → 0 fail.

## Done criteria

- [ ] `grep -c "not(.canvas-pill)" plugins/canvas/src/app/components.tsx` → 2
- [ ] `bun run --cwd plugins/canvas typecheck` exits 0
- [ ] `bun run --cwd plugins/canvas test` exits 0 with the new assertions
- [ ] `bun run --cwd plugins/canvas build` exits 0
- [ ] `bun run lint && bun run fmt:check` exit 0
- [ ] Only `components.tsx` and `components.test.tsx` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `Row` is not at `components.tsx:72-93` or its className differs from the
  excerpt.
- `Pill` no longer carries the `canvas-pill` class (the selector would match
  nothing).
- The Tailwind build rejects the `[&>:not(.canvas-pill)]:` variant (the build
  step fails mentioning that class). Report the error; do not fall back to
  inline styles.
- The dev-instance check shows stats no longer filling the row.

## Maintenance notes

- Any future inline-sized child of `Row` (a badge, a small button) needs the
  same exclusion or a shared marker class. If a second such component appears,
  switch the selector to a marker class like `canvas-inline` and add it to both.
- A reviewer should confirm the `github-style` example renders pills inline
  and that nothing else in `Row` changed.
