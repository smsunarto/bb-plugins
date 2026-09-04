# Plan 001: Make the default canvas style follow the host theme for tones and the diff frame

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7f273313..HEAD -- plugins/canvas/src/app/components.tsx plugins/canvas/src/app/app.css plugins/canvas/src/app/styles/github.css`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
> Note: HEAD in this repo is a GitButler workspace commit that moves as other
> branches change. A non-empty diff in _out-of-scope_ files is normal.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `7f273313`, 2026-09-04

## Why this matters

The canvas plugin's default style is documented as "follows the host theme"
(see the github-style example: "The default style follows the host theme. The
github style does not"). Its prose, borders, and code blocks do follow the host
tokens, but every _tone_ (info / success / warning / danger on `Pill`,
`Callout`, `Stat`, and `Table` rows) is a raw Tailwind palette class:
`text-sky-600`, `text-emerald-600`, `bg-amber-500/10`, and so on. The bb host
ships per-theme status tokens (`--success`, `--warning`, `--destructive-text`,
`--diff-added`, `--diff-removed`), and themes such as Solarized and Dracula
override them. On those themes the canvas shows generic Tailwind green and amber
next to the host's own green and amber. The `DiffView` frame has the same
problem in miniature: a hard-coded `#e5e5e5` / `#262626` hairline instead of
`var(--border)`.

After this plan, tones in the default style are driven by four CSS custom
properties on `.canvas-prose` that default to the host tokens, and the github
style keeps its own Primer values untouched.

## Current state

Files:

- `plugins/canvas/src/app/components.tsx` — React components for canvas
  blocks. Holds the three tone maps (`toneText`, `toneRowText`, `toneSurface`)
  and the components that use them (`Callout`, `Stat`, `Pill`, `Table`).
- `plugins/canvas/src/app/app.css` — default style. Declares the
  `--canvas-prose-*` custom properties on `.canvas-prose` and the `.canvas-diff`
  frame.
- `plugins/canvas/src/app/styles/github.css` — github style. Already styles
  tones with CSS via `data-tone` selectors. **Read-only reference for this
  plan; do not edit it.**

Tone maps, `plugins/canvas/src/app/components.tsx:41-67`:

```ts
export const toneText: Readonly<Record<Tone, string>> = {
  neutral: "text-muted-foreground",
  info: "text-sky-600 dark:text-sky-400",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

/* Table rows carry a tone across a whole line of body text, so they use a
 * quieter tint than a Pill or Callout title. ... */
const toneRowText: Readonly<Record<Tone, string>> = {
  neutral: "",
  info: "text-sky-900 dark:text-sky-200/80",
  success: "text-emerald-900 dark:text-emerald-200/80",
  warning: "text-amber-900 dark:text-amber-200/80",
  danger: "text-red-900 dark:text-red-200/80",
};

const toneSurface: Readonly<Record<Tone, string>> = {
  neutral: "border-border bg-muted/40",
  info: "border-sky-500/40 bg-sky-500/10",
  success: "border-emerald-500/40 bg-emerald-500/10",
  warning: "border-amber-500/40 bg-amber-500/10",
  danger: "border-red-500/40 bg-red-500/10",
};
```

Usages (`components.tsx`):

- line 182: `Callout` aside → `${toneSurface[tone]} ${toneText[tone]}`, already
  has `data-tone={tone}`.
- line 188: `Callout` title `<p>` → `${toneText[tone]}`.
- line 217: `Stat` wrapper `<div className="canvas-stat ..." data-tone={tone}>`; line 225: its delta `<span className={\`canvas-stat-delta text-[0.75em] ${toneText[tone]}\`}>`. The wrapper already carries `data-tone`, the span does not.
- line 239: `Pill` span → `${toneSurface[tone]} ${toneText[tone]}`, already
  has `data-tone={tone}`.
- line 294: `Table` body `<tr>` → `${tone === null ? "" : toneRowText[tone]}`;
  the row has `data-tone` (see the github.css selectors below, which rely on it).

Check whether `toneText` is imported anywhere else before removing the export:

```
grep -rn "toneText\|toneSurface\|toneRowText" plugins/canvas/src
```

Expected today: matches only inside `components.tsx` (and `charts.tsx` does
**not** import them; it uses `usePalette()` from `theme.ts`). If another file
imports them, see STOP conditions.

Prose custom properties, `plugins/canvas/src/app/app.css:20-40` (excerpt):

```css
.canvas-prose {
  --canvas-prose-font:
    "SN Pro", var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  ...
  font-family: var(--canvas-prose-font);
```

Diff frame, `plugins/canvas/src/app/app.css:285-295`:

```css
.canvas-diff {
  --diffs-font-family: ...;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  overflow: hidden;
}

.dark .canvas-diff {
  border-color: #262626;
}
```

Leave the `.canvas-diff > diffs-container { --diffs-dark: ... }` block that
follows (lines 297-320) exactly as it is. Its comment records that pinning the
diffs.com palette is deliberate.

How the github style already does it, `plugins/canvas/src/app/styles/github.css:253-351`
(pattern to mirror, do not edit):

```css
.canvas-prose[data-canvas-style="github"] .canvas-table tr[data-tone="success"] {
  color: var(--gh-success);
}
.canvas-prose[data-canvas-style="github"] .canvas-pill[data-tone="success"] {
  background: var(--gh-success-emphasis);
  border-color: var(--gh-success-emphasis);
  color: #ffffff;
}
.canvas-prose[data-canvas-style="github"] .canvas-callout[data-tone="success"] {
  border-left-color: var(--gh-success);
}
.canvas-prose[data-canvas-style="github"]
  .canvas-callout[data-tone="success"]
  .canvas-callout-title {
  color: var(--gh-success);
}
```

Those selectors carry `[data-canvas-style="github"]`, so they are more specific
than anything this plan adds under bare `.canvas-prose`, and keep winning.

Host tokens available on `:root` / `.dark` in the bb app (from bb's
`apps/app/src/components/ui/theme.css`; per-theme files such as
`apps/app/src/lib/themes/solarized.ts` override them):

| Token                                         | Light                   | Dark                    |
| --------------------------------------------- | ----------------------- | ----------------------- |
| `--success`                                   | `oklch(0.7 0.15 155)`   | `oklch(0.74 0.15 155)`  |
| `--warning`                                   | `oklch(0.7 0.16 50)`    | `oklch(0.75 0.16 50)`   |
| `--warning-text`                              | `oklch(0.55 0.14 50)`   | `oklch(0.75 0.16 50)`   |
| `--destructive`                               | `oklch(0.45 0.19 25.8)` | `oklch(0.56 0.19 22.2)` |
| `--destructive-text`                          | `oklch(0.45 0.19 25.8)` | `oklch(0.65 0.16 22)`   |
| `--diff-added` / `--diff-removed`             | greens / reds           | greens / reds           |
| `--border`, `--primary`, `--muted-foreground` | present                 | present                 |

There is **no `--info` token** in the host. `--primary` is neutral gray in the
default theme, so `info` keeps a hand-set blue with light and dark values.

Conventions:

- Styling for the default style lives in `app.css`, keyed off class names
  (`.canvas-pill`, `.canvas-callout`, `.canvas-table`) and `data-tone`, exactly
  like `github.css`. Prefer CSS rules over new Tailwind arbitrary-value classes.
- Comments in this repo are terse and explain a non-obvious _why_. Keep the
  existing comment above `toneRowText` if the "quieter tint for rows" idea
  survives (it does, as the `color-mix` in step 2).
- Tests use `bun:test` with `node:assert/strict` and render through
  `@get-bb/plugin-sdk/testing/app`. See `plugins/canvas/src/app/canvas.test.tsx:1-40`
  for the setup boilerplate (installDom, mock Pierre, installTestPluginRuntime,
  `renderSlot`).

## Commands you will need

Run from the repository root `~/git/bb-plugins` unless stated.

| Purpose                       | Command                                  | Expected on success     |
| ----------------------------- | ---------------------------------------- | ----------------------- |
| Typecheck plugin              | `bun run --cwd plugins/canvas typecheck` | exit 0                  |
| Tests (plugin)                | `bun run --cwd plugins/canvas test`      | all pass, 0 fail        |
| Wiring check                  | `bun run --cwd plugins/canvas check`     | exit 0                  |
| Build plugin                  | `bun run --cwd plugins/canvas build`     | exit 0                  |
| Lint (repo)                   | `bun run lint`                           | exit 0                  |
| Format (repo)                 | `bun run fmt`                            | exit 0 (rewrites files) |
| Dev instance for visual check | `bun run dev:instance`                   | prints a local URL      |
| Reload in live bb             | `bb plugin reload canvas`                | reports running         |

Note: `bun run dev` must be running before the first plugin edit
(repo `CLAUDE.md`). If a sandbox blocks `ps` with EPERM, rerun bb / bb-kit
commands outside the sandbox.

## Scope

**In scope** (the only files you should modify):

- `plugins/canvas/src/app/components.tsx`
- `plugins/canvas/src/app/app.css`
- `plugins/canvas/src/app/components.test.tsx` (create)

**Out of scope** (do NOT touch):

- `plugins/canvas/src/app/styles/github.css` — the github style must keep its
  Primer tones. It already wins by specificity.
- `plugins/canvas/src/app/charts.tsx` and `theme.ts` — chart colours come from
  the code theme palette by design.
- The `.canvas-diff > diffs-container { --diffs-* }` block in `app.css`.
- Comment UI styles (`.canvas-comment-*`) in `app.css`.
- README / SKILL docs. Nothing user-facing changes in the authoring API.

## Git workflow

- Branch: a GitButler branch named `scott/canvas-tone-tokens` (repo convention:
  `scott/<short-description>`; use `but`, not raw git, for commits).
- One commit at the end. Message style is conventional commits, e.g.
  `style(canvas): drive tones from host theme tokens`.
- Do NOT push or open a PR.
- Other agents may have uncommitted work in this repo. Commit only the three
  in-scope files (`but diff` then `but commit -b scott/canvas-tone-tokens -m "..." <ids>`).

## Steps

### Step 1: Declare tone custom properties on `.canvas-prose`

In `app.css`, inside the existing `.canvas-prose { ... }` rule that declares the
`--canvas-prose-*` properties (around line 20), add:

```css
/* Tones follow the host status tokens. The host has no info token, so info is
   * a fixed blue with a dark variant below. */
--canvas-tone-info: oklch(0.55 0.15 240);
--canvas-tone-success: var(--success);
--canvas-tone-warning: var(--warning-text, var(--warning));
--canvas-tone-danger: var(--destructive-text, var(--destructive));
```

Directly after that rule add:

```css
.dark .canvas-prose {
  --canvas-tone-info: oklch(0.75 0.13 240);
}
```

(`.dark` is the host's dark-mode class; `app.css` already uses it for
`.dark .canvas-diff`.)

**Verify**: `grep -n "canvas-tone-" plugins/canvas/src/app/app.css` → 5 lines
(4 declarations + 1 dark override).

### Step 2: Add tone rules for pills, callouts, stat deltas, and table rows

In `app.css`, after the `.canvas-nested` rules (around line 270-280, before the
`.canvas-diff` comment block), add one block per tone. Write the four tones out
in full (no preprocessor is available). Template for `success`, repeat for
`info`, `warning`, `danger`:

```css
.canvas-prose .canvas-pill[data-tone="success"],
.canvas-prose .canvas-callout[data-tone="success"],
.canvas-prose .canvas-callout[data-tone="success"] .canvas-callout-title,
.canvas-prose .canvas-stat[data-tone="success"] .canvas-stat-delta {
  color: var(--canvas-tone-success);
}

.canvas-prose .canvas-pill[data-tone="success"],
.canvas-prose .canvas-callout[data-tone="success"] {
  background: color-mix(in srgb, var(--canvas-tone-success) 10%, transparent);
  border-color: color-mix(in srgb, var(--canvas-tone-success) 40%, transparent);
}

/* Rows carry a tone across a whole line of body text, so they use a quieter
 * tint than a Pill or Callout title. */
.canvas-prose .canvas-table tr[data-tone="success"] {
  color: color-mix(in srgb, var(--canvas-tone-success) 70%, var(--foreground));
}
```

`--foreground` is the host body-text token; `app.css` already uses it for
`--canvas-prose-heading` and `--canvas-prose-strong` (lines 25-26). There is no
`--canvas-prose-fg` property, so do not invent one.

Neutral keeps the Tailwind classes it has today (`text-muted-foreground`,
`border-border bg-muted/40`). Do not add a neutral rule.

**Verify**: `grep -c 'data-tone="' plugins/canvas/src/app/app.css` → at least
28 (7 selectors × 4 tones).

### Step 3: Shrink the tone maps in `components.tsx`

Replace the three maps at `components.tsx:41-67` so every non-neutral entry is an
empty string and neutral keeps its current classes:

```ts
/* Non-neutral tones are styled in app.css via data-tone, so the default style
 * can follow the host theme tokens. Neutral stays a Tailwind class. */
export const toneText: Readonly<Record<Tone, string>> = {
  neutral: "text-muted-foreground",
  info: "",
  success: "",
  warning: "",
  danger: "",
};

const toneRowText: Readonly<Record<Tone, string>> = {
  neutral: "",
  info: "",
  success: "",
  warning: "",
  danger: "",
};

const toneSurface: Readonly<Record<Tone, string>> = {
  neutral: "border-border bg-muted/40",
  info: "",
  success: "",
  warning: "",
  danger: "",
};
```

If after this every value of `toneRowText` is `""`, delete the map and the
`${tone === null ? "" : toneRowText[tone]}` interpolation at line 294 instead of
keeping a dead lookup. Keep the `data-tone` attribute on the row.

Then drop the tone class from the `Stat` delta span (line 225); the wrapper `div`
already has `data-tone`, and the step-2 rule targets the span through it:

```tsx
<span className="canvas-stat-delta text-[0.75em]">{delta}</span>
```

Keep `data-tone` on `Pill` (line 239) and `Callout` (line 183) as they are. The
`Callout` title `<p>` (line 188) loses `${toneText[tone]}`; the CSS rule in
step 2 colours it.

**Verify**:
`grep -n -E "sky-|emerald-|amber-|red-" plugins/canvas/src/app/components.tsx`
→ no matches.
`bun run --cwd plugins/canvas typecheck` → exit 0.

### Step 4: Replace the diff frame hexes with the host border token

In `app.css`, change:

```css
.canvas-diff {
  ...
  border: 1px solid #e5e5e5;
```

to `border: 1px solid var(--border);` and delete the `.dark .canvas-diff { border-color: #262626; }`
rule. Update the comment above `.canvas-diff` so it no longer promises
"neutral-200 light, neutral-800 dark"; say the frame uses the host hairline.

**Verify**: `grep -n -E "#e5e5e5|#262626" plugins/canvas/src/app/app.css` → no matches.

### Step 5: Add a rendering test

Create `plugins/canvas/src/app/components.test.tsx`. Copy the setup block from
`canvas.test.tsx:1-30` (installDom, the Pierre mock, `installTestPluginRuntime`,
`renderSlot`, the `sample` canvas readFileSync). Then render a canvas source
that contains:

```mdx
<Pill label="ok" tone="success" />
<Callout tone="warning" title="Heads up">
  body
</Callout>
<Stat label="p95" value="120ms" delta="+3%" tone="danger" />
<Table headers={["a"]} rows={[["x"]]} rowTone={["info"]} />
```

Look at how `canvas.test.tsx` feeds source into `CanvasOpener` (it reads an
example file and mocks the `render` rpc); mirror that with an inline string.
Assert:

- `container.querySelector('.canvas-pill[data-tone="success"]')` is not null.
- `container.querySelector('.canvas-stat[data-tone="danger"] .canvas-stat-delta')` is not null.
- `container.querySelector('.canvas-callout[data-tone="warning"] .canvas-callout-title')` is not null.
- `container.querySelector('.canvas-table tr[data-tone="info"]')` is not null.
- `container.innerHTML` does not match `/(sky|emerald|amber|red)-[0-9]/`.

**Verify**: `bun run --cwd plugins/canvas test` → all pass, including the new file.

### Step 6: Build, lint, format, and eyeball

1. `bun run --cwd plugins/canvas build` → exit 0.
2. `bun run lint && bun run fmt` → exit 0.
3. `bun run --cwd plugins/canvas check` → exit 0.
4. Start `bun run dev:instance`, open
   `plugins/canvas/examples/flaky-test-triage.canvas.mdx` and
   `plugins/canvas/examples/github-style.canvas.mdx` in the dev instance.
   Expected: in the flaky example the warning callout, the toned table rows,
   and the pills are coloured (not grey). In the github example the pills are
   still solid Primer blue/green with white text and the callout rule is still
   Primer amber (github.css unchanged and still winning).
5. Switch the dev instance theme to Solarized (Settings → Appearance) and
   confirm the flaky example's success/warning/danger tones now use the
   Solarized greens/oranges/reds. This is the visible payoff of the plan.

**Verify**: screenshots or a one-line note of what you saw for both examples,
plus the Solarized check.

## Test plan

- New file `plugins/canvas/src/app/components.test.tsx` (step 5), modelled on
  `plugins/canvas/src/app/canvas.test.tsx`. Cases: each toned component emits
  `data-tone`; no Tailwind palette class names remain in rendered output.
- Existing `canvas.test.tsx`, `comments.test.tsx`, `theme.test.ts` must keep
  passing unchanged.
- Verification: `bun run --cwd plugins/canvas test` → 0 fail.

## Done criteria

- [ ] `grep -n -E "sky-|emerald-|amber-|red-" plugins/canvas/src/app/components.tsx` → no matches
- [ ] `grep -n -E "#e5e5e5|#262626" plugins/canvas/src/app/app.css` → no matches
- [ ] `grep -c 'data-tone="' plugins/canvas/src/app/app.css` ≥ 28
- [ ] `git diff --stat -- plugins/canvas/src/app/styles/github.css` → empty
- [ ] `bun run --cwd plugins/canvas typecheck` exits 0
- [ ] `bun run --cwd plugins/canvas test` exits 0 with the new test file passing
- [ ] `bun run --cwd plugins/canvas build && bun run --cwd plugins/canvas check` exit 0
- [ ] `bun run lint && bun run fmt:check` exit 0
- [ ] Only the three in-scope files are modified (check with `but diff` or `git status --short plugins/canvas`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The tone maps in `components.tsx` are not at lines 41-67 or their contents
  differ from the excerpt (drift).
- `grep -rn "toneText" plugins/canvas/src` shows an importer outside
  `components.tsx` (another component depends on the Tailwind classes).
- `app.css` no longer declares `--canvas-prose-*` properties on `.canvas-prose`
  (the styling architecture changed).
- The host dev instance does not expose `--success` / `--warning` /
  `--destructive` on `:root` (check in devtools:
  `getComputedStyle(document.documentElement).getPropertyValue("--success")`
  is empty). The fallbacks in step 1 would then render nothing useful.
- After step 6, github-style pills lose their solid Primer background. That
  means the new rules out-specify `github.css`; report rather than editing
  `github.css`.

## Maintenance notes

- Any new toned component must set `data-tone` and get a rule in the step-2
  block; the Tailwind maps no longer do anything for non-neutral tones. A
  reviewer should check new components for `data-tone`.
- If bb ever ships an `--info` token, swap the hand-set `--canvas-tone-info`
  values for it.
- `--warning-text` / `--destructive-text` exist in bb's default theme; the
  `var(--x-text, var(--x))` fallbacks cover themes that only define the base
  token. Keep the fallbacks.
- Deferred: the chart palette (`theme.ts`) derives from the code theme, not the
  status tokens, so chart tones and component tones can differ slightly. That
  is intentional today and out of scope here.
