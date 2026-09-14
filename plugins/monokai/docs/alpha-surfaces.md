# Alpha surfaces

Monokai uses an ink-relative ladder for in-flow surfaces and controls. A control
keeps its role when its parent changes. It does not pick a replacement hex for
each card, pane, dialog, or nested container.

## Cursor reference

Measured in the installed Cursor 3.20.17 Agents window on 2026-09-13 through
Computer Use, opening General settings and Window Restoration. The live
DevTools console returned these computed custom properties on
`.monaco-workbench`. Its ink source was `oklch(0.955 0 0)`.

| Cursor token                 | Observed value            | Monokai use                |
| ---------------------------- | ------------------------- | -------------------------- |
| `--cursor-bg-quinary`        | foreground at 4% alpha    | card / editable field      |
| `--cursor-bg-quaternary`     | foreground at 6% alpha    | secondary control          |
| `--cursor-bg-tertiary`       | foreground at 8% alpha    | hover                      |
| `--cursor-bg-secondary`      | foreground at 14% alpha   | selection / primary action |
| `--cursor-bg-primary`        | foreground at 20% alpha   | active / strong hover      |
| `--cursor-stroke-quaternary` | foreground at 4% alpha    | seam                       |
| `--cursor-stroke-tertiary`   | foreground at 8% alpha    | hairline                   |
| `--cursor-stroke-secondary`  | foreground at 12% alpha   | control edge               |
| `--cursor-stroke-primary`    | foreground at 20% alpha   | strong edge tier           |
| `--cursor-bg-elevated`       | opaque `oklch(0.209 0 0)` | opaque popover             |

The installed `out/vs/workbench/workbench.glass.main.css` independently contains
these definitions in `body:not([data-cursor-glass-mode=true]) .monaco-workbench`.
The relevant foreground mixes use `in srgb` and `transparent`.

The live Window Restoration trigger was transparent with a 12% ink border.
Search Settings used a transparent input inside a 3% ink wrapper. The menu
visually occluded the settings content and had a border and shadow. These
observations do not imply that every Cursor component uses one identical fill.

Monokai copies the composition model and five-step neutral ladder, preserving
its own ink, content grounds, feedback colors, and text ladder. BB fields and
outline triggers deliberately use 4% at rest for a visible hit area. Popovers
use the opaque 4% ink layer over the conversation ground. CSS hex alpha rounds each percentage to
the nearest byte.

## Component contract

- Consume BB's existing theme manifest and semantic CSS custom properties.
  No runtime color sampling or component-background detection is needed.
- Use `--control-background` for fields and outline triggers, `--secondary`
  for secondary actions, and `--control-primary` for filled actions.
- Menu navigation highlights use the 8% hover layer, including model and
  reasoning selections. They do not use the 20% pressed-action layer.
- Embedded frames clip their fill inside the edge and do not add a light
  outer shadow. This keeps inline visualizations and code embeds crisp.
- Use `--state-hover`, `--surface-selected`, and `--state-active` for interaction
  layers. Ghost controls remain transparent at rest.
- Keep `--input` for edges. Clip translucent control fills to `padding-box`.
  The fill must not stack under the translucent border.
- Use the same 6% layer for user bubbles, composer shells, context cards,
  embed headers, and diff separators. Inline code uses 8%; diff selections
  and their gutters use 14%. Pane dividers and controls share the 12% edge.
- Composer editor-scroll and context-inlay children stay transparent. These
  layout wrappers do not represent another container.
- Keep menus, tooltips, native option sheets, terminal/code grounds, and
  explicit `*-solid` tokens opaque. Transparency is not appropriate when the
  component must hide unrelated content beneath it. The generator derives
  recessed solid from 4% ink over conversation, and raised solid from 6% ink
  over content. Sticky Git headers consume the raised solid, matching the
  normal layer while covering scrolling code.
- Settings container selectors must exclude controls. BB uses `bg-card` on
  both settings cards and compact picker buttons. Matching both previously
  erased the picker edge and overrode its hover state.
- Keep alpha on color values. The host's disabled opacity remains unchanged.
  Nested surface layers compound intentionally. Do not repaint a transparent
  layout wrapper as a second surface unless it represents a separate container.

## Verification

Launch a run with `.agents/skills/verify-bb-plugins/scripts/control`, source its
`run.env`, then run:

```sh
bun plugins/monokai/scripts/audit-control-surfaces.ts \
  "$BROWSER_SESSION" "$BB_APP_URL" "$ARTIFACT_DIR/control-matrix.json"
```

The audit reads Input and picker classes from the running BB settings UI. It
mounts a temporary matrix under the same settings ancestry and exercises rest
and real pointer hover on canvas, sidebar, user surface, popover, card, and
nested card. It checks the rendered alpha, padding clip, and at least 4.5:1
text contrast after ancestor compositing. The fixture is removed in `finally`.
It then opens the actual Palette menu and verifies opaque fill and shadow after
its animation completes. It writes the measurements and a matrix screenshot.

The matrix verifies the CSS composition contract, not arbitrary host component
behavior. Real settings dropdown, input focus, mobile layout, and theme
switching still need the isolated app checks. Text ratios are representative
measurements, not a blanket accessibility verdict.

For the wider neutral surface contract, run:

```sh
bun plugins/monokai/scripts/audit-theme-surfaces.ts \
  "$BROWSER_SESSION" "$BB_APP_URL" "$ARTIFACT_DIR/surface-matrix.json"
```

This mounts user bubbles, composer/context wrappers, annotation banners, embed
headers, Last turn headings, and inline code on four parent grounds. It asserts
28 alpha combinations, transparent layout children, and the opaque sticky Git
header. These fixtures exercise the shipped selectors. They do not replace
checking real conversation and diff rendering after BB upgrades.
