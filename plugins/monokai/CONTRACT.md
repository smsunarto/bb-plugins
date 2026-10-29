# Color Contract

This is the bb plugin's checked-in snapshot of Cursor Monokai's shared color
contract. Editor-theme paths below are relative to the source checkout supplied
to `sync:code-theme --source`; the **bb adapter** section describes this plugin.
Copy and review contract updates explicitly when importing palette changes.
Syncing code rules does not update this document.

The rules for what each color means in Cursor Monokai. Every token rule in
`themes/Cursor Monokai-color-theme.json` must satisfy this contract. A rule that
repeats a generic color with a language suffix is noise; a rule that
contradicts this table per-language is a bug — unless it appears in
**Named exceptions** with a rationale.

**Philosophy: calibrated Monokai.** Identifiers are white unless they carry a
distinct semantic role. A hue has exactly one meaning; scarcity is what makes
each hue legible. The axis is *kind-based* (what a token is), not
provenance-based (where it comes from) — stdlib and user code get the same
colors.

## Hues

| Color  | Hex         | Meaning                  | Covers                                                                                                                                                                | Explicitly excludes                                                        |
| ------ | ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Pink   | `#FE5D86`   | Language machinery       | keywords, operators, control flow, tags, template-expression delimiters                                                                                               | declaration keywords (exception 1)                                         |
| Cyan   | `#51DAE9`   | Compile-time structure   | named types, primitives, type parameters, interfaces/classes/enums *as types*, regardless of origin; namespaces/packages/modules                                      | properties, builtins-as-such, decorators                                   |
| Green  | `#9DDD54`   | Callables                | functions and methods, at declaration **and** call site; own and stdlib alike; decorators and macros (they are callables)                                             | types                                                                      |
| Orange | `#FF8342`   | Values passed into scope | parameters everywhere — italic at the declaration, regular at references; implicit ones (`this`, `super`, `self`) at every use                                        | locals, stdlib globals                                                     |
| Purple | `#A895FE`   | Constant values          | numbers, `true`/`false`/`null`/`undefined`, enum members, string escapes; named constants where the language has real ones (Go `const`, at declaration and reference) | `const` bindings in languages where it only means "not reassigned" (TS/JS) |
| Yellow | `#F7D05C`   | Literal text             | strings, templates, regex, labels                                                                                                                                     | —                                                                          |
| Gray   | `#BEB89999` | Meta-commentary          | comments, doc comments (no doc split)                                                                                                                                 | —                                                                          |
| White  | `#E3E3DD`   | Everything else          | locals, properties, punctuation, stdlib globals                                                                                                                       | —                                                                          |

Parameter references align with their declaration in hue (orange everywhere)
while italic marks only the binding site. The hue shift on references at
file-open is the one **accepted** semantic flicker: TextMate cannot resolve
a reference to its declaration, and reference-alignment was chosen over
boot-frame stability (both were tried). Type parameters follow the same hue
rule — orange at every occurrence (`[T any]`, `func(*T)`, `var zero T`),
never the type hue, because a generic is a parameter of the type level — and
add italic + underline everywhere to distinguish them from value parameters.
Both marks are semantic-only (TextMate cannot tell `T` from `world`), so a
generic settles into its styling when the server loads.

Hues are Monokai Pro "pro" filter accents re-tuned in OKLCH for this
background: same hue angles, warm hues trade 2–4 L for chroma (the originals
were gamut-pinned). Coverage-amplified hues are capped low — cyan reads more
vivid per unit chroma than any other hue, and yellow paints the largest area
(strings) — while sparse signal hues (green, orange, purple) carry the punch.
Weakest hue: pink at 6.0:1.

## Named exceptions

1. **`storage.type` is cyan-italic** (`let`, `const`, `function`) — original
   Monokai signature, kept for identity. Italic separates it from type names.
2. **Format exceptions** — per-format rules are allowed where a format
   genuinely differs, each with a rationale comment at the rule: JSON keys
   cyan; markdown/markup family (headings green, raw orange, links cyan).
   Markdown list content in `.md` and `.mdc`, MDX list content in `.mdx`, and
   rendered `*.plan.md` list content stay plain foreground. Source markers
   (`-`, `*`, or `1.`) keep the yellow syntax signal. Rendered `*.plan.md`
   markers use muted `#7C7866` so they support the prose instead of competing
   with syntax.
3. **Callable parameters render green** when the language server classifies
   them as callables (e.g. a TS callback param like `onToggle`) — kind wins
   over role, by design.
4. **`null`/`undefined` in type position are cyan** — inside a type
   annotation they act as types (`(() => void) | null`). Purple applies to
   value-position literals only.
5. **`variable.readonly.defaultLibrary` is purple** — the one place a
   provenance modifier is allowed, because it is the only handle on a
   language's predeclared literal constants (Go `nil`/`iota`/`true`/`false`,
   TS `undefined`/`NaN`/`Infinity`). These are literal values, not stdlib
   identifiers; without this rule the semantic layer paints them white and
   contradicts the TextMate layer, which scopes them `constant.language`.
6. **Func-valued variables are green** (`variable.signature`, a gopls
   modifier): a variable holding a function is called like a function, and
   the TextMate layer already guesses green from the call shape — so honoring
   it is both contract-correct under the callable row and one less flicker.
7. **`variable.readonly:go` is purple, underlined** — a named constant is a
   constant value that happens to have a name, the same kind as the literals
   and enum members already purple, so white made it indistinguishable from a
   variable. The underline carries what colour alone cannot: purple is shared
   with namespaces and literals, and the mark says *this name never changes*.
   Language-qualified on purpose: Go `const` is a compile-time constant, TS
   `const` is merely a non-reassignable binding and colouring it would flood a
   TS file. Other languages with real constants (Rust, Java `static final`)
   can join after checking what their server emits.

## Style axes

| Style | Meaning |
|---|---|
| Italic | parameter declarations; declaration keywords (the two carve-outs above) |
| Bold | callable definition sites (`function.declaration`, `method.declaration`); Markdown headings and bold emphasis. Callable definitions pop while call sites stay quiet. Their bold is semantic-only because TextMate cannot tell a declaration from a call, so the weight arriving late is a permitted flash. Markdown weight is immediate because its grammar identifies the syntax. |
| Underline | **Immutability and type-level binding.** Named constants (`variable.readonly:go`) — the mark that separates a constant from a variable when both would otherwise be a colour alone. Also type parameters (`T`) at every occurrence, where italic + underline separate a generic from a value parameter now that both are orange. `*.modification` (reassigned after declaration) was **removed**: it never rendered — gopls and TypeScript do not emit the modifier — and it asserted the exact opposite of the constant rule, so keeping a dead rule that contradicts a live one is worse than losing it. If a server that emits `modification` is added later, it needs a different mark, not this one. |
| Strikethrough | `*.deprecated` |

## Depth is separated by lightness

The editor's bracket-pair colorizer computes a nesting depth for every bracket
and offers six color slots. Depth is real information and the colorizer earns
its keep in nested TSX — but it is not a *kind*, so it may not spend a hue.
It gets a **darker register** instead: six slots that sit below every kind in
lightness, so depth never competes with meaning.

Rotating the six code hues through six depths (what most themes do) would give
each hue a second meaning on the most numerous glyph class in the file, and
unlike the purple exception, depth and kind share every syntactic position: at
`foo()` a green `(` would sit against a green callable and the call collapses
into one blob. It also inverts the coverage cap — brackets outnumber every
other colored glyph. Pure brightness cycling is refused too: the ladder means
information tier, so cycling *through the ladder* would assert that deeply
nested code matters less. (Lightness still varies within the depth palette
below — but as a discrimination cue between three chromatic colors, not as a
claim about importance.)

The palette fills all six slots: **white → blue → magenta → gold → teal →
violet**. Depth 1 is ordinary punctuation white, so the outermost level — most
brackets in a file — stays quiet and colour appears only as nesting deepens.
White must appear exactly once, which forces the palette length to divide six:
the editor cycles all six slots, so a four-colour palette would reintroduce
white at depth 5. Separation is maximized, not minimized — discrimination
between adjacent depths is the entire point — giving 0.177 minimum adjacent
distance in OKLab, versus 0.06 for an earlier low-chroma attempt that was
correctly reported as unusable.

**Lightness, not hue, is what separates brackets from kinds.** Every code hue
sits at L64–88; the five chromatic depths sit at L62–66 with full chroma. The
wheel is already full — six kinds plus white — so no set of five hues can be
angularly clear of everything. Dropping below the kinds resolves it, and it
fixes the green–cyan problem as a side effect: a teal at this lightness is
0.175 from cyan, where a bright teal was 0.105 and read as cyan's cousin.

Both chromatic steps stay out of the **green–cyan arc** (131°–205°). Measured
in OKLab, a teal at 168° sits 0.105 from cyan — nominally 37° of hue
separation, but hue discrimination is weakest in that region, so it read as
cyan's cousin. Blue at 258° and rose at 334° sit 0.156 and 0.252 from cyan
respectively. Nominal hue angle is not the test; perceptual distance is. Note
that no rule in this document can *predict* bracket colors: they come from
neither TextMate nor the language server, but from a parse the editor performs
itself.

- `editorBracketHighlight.foreground1`–`6`: `#E3E3DD` white, `#3093F4` blue,
  `#C860CF` magenta, `#B28B11` gold, `#04A891` teal, `#8A6AE6` violet —
  4.5–13.8:1, each at least 0.119 from every kind. All six must be written,
  in palette order; the generator rejects any slot that does not match. Dark
  defaults are
  `#FFD700`/`#DA70D6`/`#179FFF` for 1–3 and transparent for 4–6 — gold sits
  4.7° from string yellow at 1.3× its chroma, so every brace read as a string.
  The editor drops transparent levels from the cycle rather than leaving a gap,
  so a partial definition shifts every depth.
- `editorBracketHighlight.unexpectedBracket.foreground`: `#E34671` (4.55:1). An
  unmatched bracket is a defect, not a depth — the only bracket carrying color,
  and the color is feedback. The default `#FF1212CC` fails AA at 3.22:1.
- `editorBracketPairGuide.background1`–`6`: `#E3E3DD11`;
  `.activeBackground1`–`6`: `#E3E3DD2C` — the same hairlines as the indent
  guide, which is what they are. Mandatory, not cosmetic: a transparent guide
  key falls back to `editorBracketHighlight.foreground{N}`, at full alpha for
  the active guide, so pinning brackets white without pinning guides would draw
  a solid white rule down the viewport. The active guide stays on the ladder
  rather than the accent because it is drawn almost continuously, while the
  accent means attention — that is `editorBracketMatch`, sparse and transient.
  Hairlines are non-text, so the AA floor and ladder step do not apply (same
  carve-out as `charts.lines`).

`editorIndentGuide.background2`–`6` and `.activeBackground2`–`6` stay unset:
their default is transparent, and the editor drops transparent entries and
cycles the survivors, so all thirty levels fall back to index 1. Nothing leaks.

## Reserved feedback colors

One hex per feedback role, used identically in syntax rules and workbench
(squiggles, gutters, minimap, input validation, lists, git decorations).
Syntax rules may never borrow these for non-feedback meaning:

- `#E34671` — errors / invalid / deleted (version control)
- `#F1B467` — warnings / modified (version control)
- `#3FA266` — added / untracked (version control; untracked was accent cyan
  in the Cursor Dark lineage — moved to the feedback family so the git column
  speaks one language: green new, amber changed, red gone)
- `#6796E6` — info
- `#B267E6` — debug

## Workbench (UI)

### Typography

- The bb UI font is user-selectable across desktop and compact mobile layouts.
  **Inter (Default)** uses bb's bundled `"Inter Variable", Inter, sans-serif`
  stack. **SF Pro** uses the Apple system stack, then the named SF Pro
  families, with a generic sans-serif fallback.
- The selection owns only `--font-sans`. Code, diff bodies, and terminal
  text keep the Berkeley Mono stack below. bb code and diff file headers use
  the selected sans-serif UI font, including their file paths.
- Fenced code blocks in the thread use 1.5 leading on the code child and a
  zero-height strut on the `pre`, instead of the host's prose `leading-relaxed`.
  `diagram` and `patch` fences use 1.3 leading. Berkeley Mono draws
  box-drawing glyphs 1.2em tall, so any looser leading splits the vertical
  connectors. Skills draw file trees in a `diagram` fence and tree diffs in a
  `patch` fence: bb keeps the raw fence name on the element and sugar-high
  reads `patch` as `diff`, so the rows keep add/remove shading. Plain `diff`
  fences are source code and keep 1.5.
- The plugin setting is authoritative. Every open bb client watches it and
  updates without a plugin reload.
- Composer placeholder text is hidden at every width. Accessible editor labels
  remain available, and the touch editor stays at 16px to avoid iOS focus zoom.

- The composer environment selector shows a computer for providers that declare
  the folder icon, including project checkout and personal workspace. This
  approved CSS override depends on the host's `Environment` button label,
  shrinkable-control attribute and `Folder` SVG marker. It preserves sizing and
  picker behavior. Folder icons outside this trigger, other provider glyphs,
  loading indicators and the dropdown chevron retain their artwork.

### Notifications

- The in-app notification center follows the Monokai surface contract at every
  width: standard seams, ladder-based focus and hover fills, muted controls,
  and the UI font. On desktop its popover is rounded to 16 px with the standard
  border and layered shadow. Compact layouts keep bb's native drawer geometry.
- Transient desktop toasts use the Monokai notification card: top-centered over
  the focused conversation, rounded to 16 px, separated with the standard
  border and layered shadow, with bb's native text and action flow and dismissal
  inside the card. Compact layouts keep bb's native toast geometry and action layout.
- Native browser and operating-system banners delivered by bb's push
  notification plugin are system-owned surfaces. A bb theme cannot restyle
  their layout or colors.

- **Grounds ramp**: `#141414` chrome, `#181818` content, `#1E1E1E` recessed
  wells (every text field, dropdown, filter, and the SCM message box —
  one treatment), `#262626` raised/hover, `#404040` selection. Nothing else
  may serve as a generic surface. Filled buttons are the one registered
  control exception: `#363635` primary and `#1E1E1E` secondary, with a
  `#3C3C3C` edge on the secondary control.
- **The side bar rides the chrome ground.** `sideBar.background` and its
  section headers use `#141414`, so navigation stays with the title bar,
  activity bar, tabs, status bar, and panel frame. Devin derives its agent
  panel from this key, while its conversation page continues to use the
  `#181818` editor ground; that frame/content split is deliberate.
- **Chrome text is one color**: `#E3E3DD` at alpha steps — the same white as
  the syntax foreground. No other whites (`#E4E4E4` and `#F0F0F0` were
  collapsed into the ladder, alpha-scaled to preserve appearance). Ladder
  steps must differ by ≥ 20 alpha points to read as different tiers:
  primary `E8` (91%), secondary `BD` (74%), muted `8C` (55%), faint `4D`
  (30% — gitignored files, descriptions, and resource paths: everything that
  answers "where" rather than "what"; deliberately ghosted).
- **One accent**: `#88C0D0`, meaning interactive/attention (the activity-bar
  badge, find matches, links). It is the only chromatic voice in the chrome
  and is distinct from all six code hues.
- **Counters and focus are quiet, not accent.** Count chips (`badge.*`,
  `panelTitleBadge.*` — which must be pinned, since its default inherits
  `activityBarBadge`) are information: `#404040` ground + primary text.
  Focus indicators (`focusBorder`, `list.focusOutline`) are ladder outlines
  (`26`/`40` alpha) — position is the signal; a colored ring would make
  every focused control shout. Selected list rows must not recolor their
  icons (severity/status color survives selection).
- **Buttons are quiet too.** Primary `button.*` uses a borderless `#363635`
  fill, primary text, and `#404040` on hover. Secondary buttons use the
  `#1E1E1E` well, a `#3C3C3C` edge, and `#262626` on hover. Neither uses the
  accent. Devin paints its SCM "Generate commit message" control with the
  shared primary token — an accent fill there put a second shouting element
  inside the commit input, competing with the Commit button directly below
  it. Extension actions mirror the quiet primary button. Cursor 3.17 forces
  `extensionButton.background` onto prominent actions but keeps
  `extensionButton.prominentForeground`; matching both families prevents dark
  prominent text from landing on the quiet fill.
- **Syntax hues never appear in chrome**; feedback hues appear in either
  layer but only with their feedback meaning. When you see color in a window
  it is the accent, feedback, or code — nothing else. In content surfaces
  (terminal, charts) it is a content-palette entry — see **Content
  palettes**.

### Cursor rendered Markdown

Cursor's native `*.plan.md` editor and the Preview mode in Cursor's built-in
Markdown Editor both render prose as workbench rich-text UI. The traditional
built-in Markdown webview remains a fallback. All three surfaces inherit the
editor ground and use the same rendered content contract: green headings,
cyan links, and a pink blockquote rule. List bullets and numbers use muted
`#7C7866` by the explicit rendered-Markdown exception above.

The workbench typography layer lives in `styles/cursor-plan-preview.css` and
loads through `be5invis.vscode-custom-css`. It targets both `.plan-editor` and
`.markdown-editor-react`. Each selector anchors on the renderer's content
wrapper so it outranks Cursor's later runtime rich-text rules. The traditional
webview fallback loads
`styles/cursor-markdown-preview.css` through the extension's
`markdown.previewStyles` contribution. These layers mirror the current
Obsidian Minimal setup: a 700 px border-box wrapper with up to 56 px side
padding, SN Pro at 17 px with 1.5 leading, and 1.75 rem prose spacing.
Headings step 1.5 / 1.25 / 1.1 / 1 em at weight 600 so the four levels read
apart, with more space above than below (2.5, 2.25, 1.75, 1.75 rem over 1,
0.875, 0.75, 0.5 rem) so each heading groups with the text it introduces. At a wide pane, the resulting prose column is 588 px. Links and file
references are cyan and underlined, like Obsidian external and internal links.
Inline code uses Berkeley Mono on a clearer `#262626` well with a faint white
edge. Fenced code uses Berkeley Mono at 13 px on `#1E1E1E`. Fenced blocks can
break out to fit 100 Berkeley Mono columns plus padding, while prose stays at
its 700 px measure. The pane width remains the upper bound. Fenced code
preserves source lines and scrolls horizontally instead of wrapping. The
explicit body size keeps Cursor's rich-text scale from inheriting the smaller
Agent size. List text rounds Obsidian's live horizontal geometry to 30 px at
the first level and 32 px for same-kind nested lists. Mixed nested list kinds
retain the first-level offset, matching Obsidian's core selectors. Items
space by depth so proximity shows grouping: 0.5 em between top-level items,
0.25 em between nested siblings, and 0.25 em from a parent item's text to its
child list.

The 1.75 rem gap belongs to top-level blocks only. Nested lists, list items,
and paragraphs inside blockquotes and table cells carry no prose margin, and
Cursor's runtime item spacing is reset to the stylesheet's own value. Cursor's
Markdown-to-document conversion keeps the blank line after a list or fenced
block as an empty paragraph; the stylesheet collapses an empty paragraph that
directly follows a list or fenced block to zero height with a negative bottom
margin, so the gap stays one prose step whether or not the editor is focused.
Empty paragraphs anywhere else keep their line so the caret always has one.
Links
drop Cursor's rich-link glyph and 500 weight and read as plain underlined cyan
text. Tables show horizontal row rules only, no column dividers; the table
wrapper owns the prose margin so it collapses with its neighbours, and inline
code inside a cell inherits the cell size instead of shrinking twice. The
traditional webview fallback carries the same nested-list, quote, cell, and
first-block rules, keeps the blockquote ground transparent so all three
surfaces show only the pink rule, and pins `white-space: pre` on fenced blocks
under the webview's word-wrap mode without touching the block's own ground,
size, or padding.

Canvases (`.canvas.tsx`) are outside this contract's reach. They render in a
webview with inline SDK styles, and Cursor hands them only `button.background`
(as the canvas `primary`, which becomes its link and accent color),
`editor.background`, and `editor.foreground`. Under the quiet `#363635` button
fill, canvas links read near-invisible on the editor ground. The contract keeps
quiet buttons and records that trade in the AGENTS.md jurisdiction notes.

The same companion stylesheet shifts Cursor's main Agent conversation scale
down by two pixels. Main text becomes 12 px, metadata becomes 11 px, compact
labels become 10 px, and extra-small labels become 9 px. This preserves the
one-pixel gaps in Cursor's hierarchy instead of flattening every role. It
targets the composer editor only, so the unified Agents thread-list sidebar
keeps its native scale.

The Shiki bridge derives its palette by probing TextMate scopes. It does not
read `semanticTokenColors`. Those probes must resolve to this contract:
keywords and tags pink; strings yellow; functions green; numbers and constants
purple; comments gray; parameters and language variables orange; links, types,
and classes cyan; punctuation, attributes, properties, ordinary variables, and
non-language `const` bindings white. The generator audits every probe so a
missing generic scope cannot fall back to Cursor's private palette.

## Content palettes (terminal, charts)

The terminal viewport and `charts.*` show program output and data. They are
content, not chrome. The theme supplies the palette; the program or the chart
assigns the meaning. Hue meanings from the syntax and chrome layers do not
transfer to these surfaces.

- **ANSI normal tier = feedback family**: red `#E34671`, green `#3FA266`,
  yellow `#F1B467`, blue `#6796E6`. ANSI convention and the feedback roles
  agree (red error, green added, yellow changed, blue info), so terminal
  diffs and test output speak the same language as the editor gutter.
- **ANSI bright tier = code family plus registered tints**: bright-red
  `#FE5D86` (code pink, the vivid tier of the red channel), bright-green
  `#9DDD54`, bright-yellow `#F7D05C`, bright-cyan `#75F0FF` (tint of
  `#51DAE9`), bright-magenta `#BDB2FE` (tint of `#A895FE`), bright-blue
  `#7CACFE` (tint of `#6796E6`). A tint inherits the identity of its base
  hue; it is not a new voice. Tints are legal in content palettes only —
  never in syntax or chrome. With `drawBoldTextInBrightColors` (VS Code
  default), bold promotes normal to bright, so inside the terminal the two
  tiers of a channel are one voice at two intensities; the editor-side
  distinction between `#E34671` and `#FE5D86` is not claimed here.
- **Grays**: bright-black `#7C7865` = the effective comment gray (the
  editor-ground blend from the comment history); normal white `#ADADA9` =
  ladder-secondary flattened over the terminal ground; bright-white
  `#E3E3DD`; ansiBlack `#141414` = chrome ground (a grounds-ramp value).
- **The accent never enters a content palette.** No ANSI slot or chart
  series may be `#88C0D0` — program output must not speak with the chrome
  attention voice. Accent remains legal in terminal chrome overlays (find
  match, focus) with its normal meaning.
- **`charts.*` is categorical.** Feedback and code hexes there carry series
  identity only: red `#E34671`, green `#3FA266`, yellow `#F1B467`, blue
  `#6796E6`, orange `#FF8342`, purple `#A895FE`; `charts.foreground`
  `#E3E3DD`; `charts.lines` `#E3E3DD40` (hairline, non-text — outside the
  chrome-text ladder by design).
- **Known external consumers.** The starship prompt (dotfiles repo,
  `.dotfiles/.config/starship.toml`) styles itself in named ANSI slots so it
  tracks this palette automatically, with one raw hex: branch orange
  `#FF8342`, pinned because ANSI has no orange slot. Retuning the palette's
  orange requires updating that pin by hand. Its slot conventions: red only
  for the failed-exit chevron, git counters match the git column, cyan =
  directory, blue = ahead/behind.

## bb adapter

The bb Monokai plugin is another adapter for this contract. This local snapshot
keeps its palette policy available without an editor-theme checkout. Updates
to the upstream contract require an explicit copy and review here. bb names
and composes its surfaces differently, so the adapter maps the shared roles as follows:

- `--background` is the bb-only conversation ground `#151515`; both navigation
  sidebars remain content `#181818`. Terminal chrome and the thread-side panel
  frame share chrome `#181818`. Popovers use the opaque 4% ink layer over conversation (`#1D1D1D`), a
  translucent edge, and the host shadow so underlying content cannot bleed
  through. User request bubbles and the
  composer use the shared 6% ink surface. Layout children stay transparent
  so the composer and its context inlay each paint their surface once.
  All code bodies, including Markdown code, rendered mermaid diagrams, smart
  embeds, and right-side Git diffs, use content `#181818`. Git diff file
  headers and smart-embed headers use the shared 6% ink surface. Both use the sans-serif UI font.
  The Last turn summary heading uses that same surface. Sticky Git headers
  use that layer composited over the content ground to occlude scrolling code.
  Settings containers keep bb's native card fill and outer border.
  Nested controls add their own layer relative to the container beneath them.
  Neutral diff gutters share the content ground. Hunk
  separators use 6% ink. Neutral diff selections and their gutters use 14%
  ink, and hover uses 8%. Change highlights retain their feedback fills.
- Neutral in-flow surfaces use `#E3E3DD` alpha layers, modeled on Cursor's
  live foreground-relative ladder: 4%, 6%, 8%, 14%, and 20%. These are
  composited over the actual parent, never flattened to a fixed control color.
  Cards and editable fields use 4%, user surfaces and secondary buttons use 6%,
  inline-code emphasis and hover use 8%,
  filled actions and selected rows use 14%, and pressed/strong hover uses 20%.
  Dropdown triggers use the field layer and share its border and hover rules
  across every parent. Ghost buttons stay transparent at rest.
- `--input` is the 12% ink control edge, not a fill. Dividers use 4% or 8%,
  ordinary edges use 12%, and strong edges use 20%. Focus keeps the existing
  neutral 25% ink ring. Apply alpha to colors, never the whole component.
  A translucent control uses `background-clip: padding-box` so its fill does
  not compound under the border. Native select option sheets are opaque.
  Menu navigation highlights, including model/reasoning selection, use the
  shared 8% hover layer rather than the 20% pressed-action layer.
  The model-search row owns one 4% field layer with no bottom divider; its
  input stays transparent inside that field.
  Embedded frames clip their fill inside the border and have no light-colored
  outer shadow. Their translucent edge provides the boundary.
- Opaque grounds remain for panes, code, terminals, occluding popovers,
  scrims, and BB's explicitly named `*-solid` fallbacks. Recessed solid
  fallbacks derive from 4% ink over the conversation ground; raised solid
  fallbacks derive from 6% ink over content. These are occlusion roles, not
  another independently tuned palette. Context-specific
  control colors are forbidden. The existing BB selector adapter maps host
  component variants to roles; it must not choose colors by parent surface.
- Both outer sidebar edges use the shared 12% ink edge. The right resize
  divider owns that edge while active, so a panel border cannot stack beneath
  it and brighten the result.
- bb's native `--primary` name maps to the shared accent `#88C0D0`, not to the
  primary-button fill. Links, mentions, file accents, and search matches use
  it; component selectors map filled buttons to their neutral control roles.
  Conversation links drop the underline and reveal a rounded `#88C0D026`
  accent-alpha surface on hover, preserving the conversation ground beneath it.
- Feedback, text-ladder, comment, and ANSI hue roles are byte-identical to this
  contract. bb gives backtick-delimited inline code the shared 8% ink layer
  while fenced code remains on content `#181818`. bb maps ANSI black
  and its dark background
  companions to its `#181818` chrome ground; bright black on `#7C7865` is
  the one accepted 4.0:1 content-palette exception. The shared translucent
  comment source is measured on bb's `#181818` fenced-code ground; backtick
  inline code is plain prose and does not spend syntax hues.

The bb generator owns these mappings and emits the shipped CSS from a
selector-focused template whose colors are symbolic role references. Its audit
rejects stale output, unknown roles, off-contract literals, missing
bb/shadow-DOM tokens, legal colors assigned to the wrong role, and illegible
foreground/background pairs. CSS comments may name foreign upstream defaults
for provenance; comments do not become rendered theme values.

## Zed adapter

`scripts/generate-zed-theme.ts` emits `themes/zed/cursor-monokai.json`, the
dark `Cursor Monokai` family (schema v0.2.0, written against Zed 1.22).
The TextMate and Zed generators import the shared palette, allowlists and
color math from `scripts/contract.ts`.

Workbench mappings read Cursor values by key from
`themes/Cursor Monokai-color-theme.json` (`text` ← `tab.activeForeground`);
alpha variants derive from those colors. Unmapped Zed roles use contract
literals. A Cursor retune reaches Zed on `bun run generate:theme`;
`bun run check` rejects stale output. `bun run install:theme` copies the
theme into `~/.config/zed/themes/`; Zed reloads it live.

Tree-sitter captures resolve to the longest dotted prefix
(`function.method.call` → `function`). Semantic-token style names require an
exact match. Explicit targets for Zed's default rules include
`namespace`, `type.parameter`, `variable.parameter`, `constant.builtin`,
`variable.builtin` and `variant`. The audit probes both paths.

The adapter maps the shared roles as follows:

- **Grounds**: title bar, tab bar, panels, status bar, terminal and popovers
  use chrome `#141414`; `elevated_surface` follows Cursor's quick input.
  Editor and breadcrumb toolbar use content `#181818`; multibuffer excerpt
  headers use raised `#262626`.
- **Controls and text**: `element.*` uses quiet primary-button fills
  `#363635`/`#404040`; `ghost_element.*` uses the list ladder. Text values
  inherit Cursor keys: `text` is `#E3E3DDD6`, `text.muted` `#E3E3DD8C`,
  `text.placeholder` `#E3E3DD80`, `text.disabled` `#E3E3DD4D`;
  `text.accent` is `#88C0D0`.
- **Brackets**: no match border exists, so
  `editor.document_highlight.bracket_background` uses accent fill
  `#88C0D033`. `accents` follows the depth palette slot for slot, indexed by
  depth modulo length. Zed reorders adjacent colors below 0.08 OKLab
  distance; the palette's minimum is 0.177, so its order holds.
- **Players**: all eight slots are pinned because Zed merges shorter lists
  over its defaults. Player 0 uses local cursor `#E3E3DDD6` and selection
  `#40404099`. Slots 1–6 use the charts content palette (blue, purple, green,
  yellow, orange, red) with `3D`-alpha selections for collaborator identity.
  Slot 7 uses accent `#88C0D0`: Zed's AI agent uses the last slot, and agent
  edits want attention.
- **Status and terminal**: feedback roles (`error`, `warning`, `created`)
  use one hex each with a `1A` wash and `66` edge. `hint`, `predictive`,
  `ignored`, `hidden` and `unreachable` use the ladder for de-emphasis.
  Terminal uses the content palette; dim (SGR 2) is the normal slot at 50%
  alpha, matching Cursor's faint text rather than registering another tier.
- **Modes and debug**: Vim labels stay transparent as plain status-bar text;
  yank flash uses ladder alpha `2C`. Helix jump labels use the accent;
  `debugger.accent` uses debug `#B267E6` for breakpoints.
- **Declarations**: `@keyword.declaration` (TS/JS `const`, `let`, `var`,
  `function`, `class`, `enum`, `interface`, `type`) and
  `@keyword.definition` (Python `def`, `class`, `async`, `lambda`) map to
  cyan italic, porting exception 1. Go `func`, `var`, `const`, `type` stay
  pink in both editors: Zed captures `@keyword`, Cursor `keyword.*.go`.
- **Syntax**: `property.json_key` is cyan (exception 2). Markdown `title` is
  green and bold, `text.literal.markup` orange, links and emphasis cyan, list
  markers yellow. `tag.component` is cyan like Cursor's
  `support.class.component`; `keyword.preproc`/`preproc` are green because
  directives are macros. Python keyword-argument names (`function.kwargs`)
  and `variable.special` (`this`, `super`, `self`, `cls`) are orange;
  `variable.builtin` is white. `string.special` is purple for format verbs
  and CSS colors; `text.literal` is yellow for Rust chars.
  `function.definition` is bold wherever a grammar captures definition sites.
- **Comments**: `comment` and `comment.doc` ship the opaque blend `#7C7865`,
  not the translucent `#BEB89999` source. Zed 1.24 draws a translucent
  syntax color brighter than its opaque base (pixel-sampled near body
  white), so comments lose the selection adaptivity they have in Cursor.

The audit requires all 186 color keys Zed 1.22 reads: missing keys leak its
blue-gray defaults; unknown keys are silently ignored. Off-contract hexes
fail against the chrome allowlist for chrome, accents and players, and the
token allowlist for syntax. It requires eight player slots and the exact
depth palette in `accents`, slot for slot. Capture and semantic style-name
probes check both lookup paths; a declaration probe asserts color and italic.

Syntax must reach 4.5:1 on the editor ground; comments and the de-emphasized
`hint`/`predictive` annotations share the 4.0:1 comment floor. Illegible text
pairs fail the audit. Pixel sampling verified compiling Go and TS files in
Zed 1.22 with gopls and vtsls attached.

Named deviations, including Zed's accepted layer-agreement flashes:

1. **Go named constants lose the underline (exception 7).** gopls tags
   numeric constants `readonly number`, but string and bool constants carry
   bare `readonly`, like every TS `const` binding. User semantic rules are
   global: an underline could mark `MaxDepth` but not `Greeting`, so the mark
   stays off. Zed's built-in Go rule still makes constants purple.
2. **ALL_CAPS identifiers flash purple.** TS/JS/Python/Rust/C grammars capture
   them as `@constant` by spelling; vtsls repaints TS ones white. `constant`
   must stay purple for Go, Rust and Python semantic rules. Accepted flash;
   with semantic tokens off they stay purple.
3. **Go escapes settle yellow.** gopls's flat `string` token covers `\n`;
   `string` + `format` still maps format verbs to purple `string.special`.
   A style-less rule must take highest precedence for `string`, so dropping
   plain strings would discard format tokens too. Format verbs outnumber
   escapes, so the server stays on, opposite the Cursor companion setting
   whose grammar colors both. Accepted flash.
4. **CSS property names are white.** Its grammar uses `@property`, shared
   with every language's properties.
5. **Underline and strikethrough need companion settings.** Theme syntax
   styles hold only color, background, font style and weight.

## Injected scopes

The extension ships one grammar injection, `syntaxes/go-blank-injection.json`
(`injectTo: source.go`), because some tokens carry meaning that neither the
grammar nor the language server exposes:

- **`_` → `variable.language.blank.go` → `#E3E3DD4D`** (ghost tier). Go's
  blank identifier is a binding that is explicitly discarded, so it reads as
  present-but-not-read. The Go grammar has no scope for it, so the injection
  is the only TextMate handle. **It only renders where gopls has not produced
  tokens** (files that fail to parse, server starting or down): `gopls semtok`
  shows `_` emitted as `variable [definition number]`, identical to the `v`
  beside it, so the semantic layer repaints it white and no selector can
  prevent that. Disabling gopls's `variable` token type would hand the file
  back to this rule — see **Companion settings**.
- The injection is `L:`-prefixed, so it wins over the base grammar. If Go's
  grammar ever scopes `_` itself, this rule still takes precedence — revisit
  it then.
- Single-letter generics were considered for the same treatment and rejected:
  matching `\bT\b` by convention would also hit `*testing.T`, which appears in
  every Go test file. Type parameters stay semantic-only.

## Companion settings

Some renderings need cooperation from language servers, not theme rules:

- `"[typescript][typescriptreact]": { "editor.language.colorizedBracketPairs":
  [["(",")"],["[","]"],["{","}"]] }` — TypeScript opts `<`/`>` into bracket
  colorization (Go does not); they are absent from its own `brackets` list, so
  colorizing them buys no matching behavior while an unpaired `>` in a
  comparison can render as `unexpectedBracket` red on correct code. Narrowing
  costs nothing visually, since a colorized `<` already renders the same
  `#E3E3DD` as `punctuation.definition.tag`. (Lives in dotfiles
  `vscode/settings.json`.)
- `"gopls": { "ui.semanticTokenTypes": { "string": false } }` — gopls's
  string tokens span whole literals and bury the grammar's format-verb
  (`%T`) and escape scopes, which the purple row covers. Strings gain
  nothing from semantic tokens; disabling them restores placeholder
  coloring and is flicker-free by construction. (Lives in dotfiles
  `vscode/settings.json`.)

- Zed settings live in `~/.config/zed/settings.json`, which dotfiles do not
  track. Set `"semantic_tokens": "combined"` (default `"off"`) so parameters,
  generics, func-valued variables and bold definitions settle when the server
  attaches.
- Set `"colorize_brackets": true` (default `false`) so Zed's bracket
  colorizer reads the depth palette from `accents`.
- Set `global_lsp_settings.semantic_token_rules` to the array below.
  For each property, the earliest matching rule that sets it wins; font-only
  rules preserve the default color. A `token_modifiers` list requires every
  listed modifier, so declaration and definition use separate rules.

  ```jsonc
  [
    { "token_modifiers": ["deprecated"], "strikethrough": true },
    { "token_type": "typeParameter", "font_style": "italic", "underline": true },
    { "token_type": "parameter", "token_modifiers": ["declaration"],
      "font_style": "italic" },
    { "token_type": "parameter", "token_modifiers": ["definition"],
      "font_style": "italic" },
    { "token_type": "parameter", "font_style": "normal" },
    { "token_type": "function", "token_modifiers": ["declaration"],
      "font_weight": "bold" },
    { "token_type": "function", "token_modifiers": ["definition"],
      "font_weight": "bold" },
    { "token_type": "method", "token_modifiers": ["declaration"],
      "font_weight": "bold" },
    { "token_type": "method", "token_modifiers": ["definition"],
      "font_weight": "bold" },
    { "token_type": "variable", "token_modifiers": ["readonly", "defaultLibrary"],
      "style": ["constant.builtin"] },
    { "token_type": "variable", "token_modifiers": ["signature"],
      "style": ["function"] },
    { "token_type": "arithmetic", "style": ["operator"] }
  ]
  ```

  - Deprecated symbols strike through; type parameters use italic + underline
    to distinguish type-level bindings from value parameters.
  - Parameter declarations use italic (`declaration` from tsserver,
    `definition` from gopls); references reset to normal because the theme's
    `variable.parameter` makes tree-sitter declaration captures italic.
  - Function and method declarations/definitions use bold to separate
    definition sites from calls.
  - `readonly` + `defaultLibrary` variables use `constant.builtin`, porting
    `variable.readonly.defaultLibrary` (exception 5). Zed's defaults require a
    `constant` modifier that neither server emits.
  - `signature` variables use `function`, keeping func-valued variables green
    (exception 6).
  - `arithmetic` uses `operator`: Zed's built-in Rust rules send rust-analyzer's
    arithmetic operators to white `punctuation` instead of pink.

## Constraints

- Every foreground ≥ 4.5:1 (WCAG AA) against `editor.background` `#181818`,
  except comments, which may go to ≥ 4.0:1 — deliberately sub-AA because
  comments are de-emphasis by design; this is the one legibility/quietness
  trade the contract accepts. Alpha colors are measured after blending onto
  the background. (Comment history: `#75715E` 3.62:1 → `#8A8671` 4.84:1 →
  `#84816C`-effective 4.51:1 → `#BEB899` at 60% alpha, which blends to
  `#7C7865` at the 4.0:1 comment floor and adapts over selection/highlight
  fills, Cursor Dark's translucency trick. Foreground-at-60% (6.6:1) popped
  too much.)
- Language-qualified rules (`:typescript`, `.ts` scope suffixes) exist only
  where a language genuinely differs, with a comment saying why.
- `themes/generated-textmate.json` is generated by
  `scripts/generate-textmate-theme.ts` — never hand-edit it; change the
  generator and re-run it.
- **This contract is machine-enforced in all three adapters**: the editor
  generator audits every color in the main theme (workbench, tokenColors,
  semanticTokenColors) against per-layer role allowlists, and bb's generator
  checks generated CSS freshness, literals, required tokens, exact role
  mappings, and contrast pairs. Zed's generator checks freshness, all 186
  required color keys, unknown keys, per-layer allowlists, syntax contrast,
  text pairs, capture probes and exact semantic style-name probes. It also
  requires eight player slots and `accents` matching the depth palette slot
  for slot. Each adapter fails its `bun run check` when it drifts. Chrome may
  use grounds, ladder, accent, feedback, and content palettes; token layers
  may not use the accent or content tints. Adding a new color means amending
  this contract first, then the relevant generator.
- **Depth-indexed families follow the registered palette.** All nineteen
  bracket keys must be present; bracket foregrounds must match the depth
  palette slot for slot (`#E3E3DD`, `#3093F4`, `#C860CF`, `#B28B11`,
  `#04A891`, `#8A6AE6`) and the two guide families must each hold a single value
  (`unexpectedBracket` is exempt — feedback, not depth). The hex audit alone
  cannot catch a bracket rainbow, since these are `colors.*` keys and chrome
  may legally use the code hues, so the generator checks this as its own rule.
- **Known-foreign defaults are required keys**: families whose VS Code
  defaults do not match this contract (charts, git decorations, the full
  ANSI table, terminal command decorations, testing icons, links, buttons,
  error/warning/info foregrounds) must be present in the theme — a missing
  key fails the audit, because an absent key leaks its default silently and
  no hex check can see it.
- **Layer agreement.** The TextMate layer is the loading state: it renders
  instantly, then the language server's semantic tokens arrive and repaint.
  Wherever a scope can be classified statically, the TextMate rule must
  predict the semantic layer's verdict — semantic refines, it never
  contradicts. A cold-open color flash (TextMate color ≠ settled semantic
  color for the same token) is a bug. Flashes are acceptable only where
  TextMate *cannot* know (parameter usages, callable-typed identifiers).
  The Zed adapter's grammars are fixed, so its accepted flashes are named
  under **Zed adapter**.

## Known contract violations (queued rule changes)

None. The 2026-08-08 migration pass applied the original queue (language-
qualified overrides deleted, type family green → cyan, decorator/macro
cyan → green, `*.modification` underline, comment gray at AA, italics
restricted to the style axes) plus the layer-agreement sweep. New violations
found in review are queued here.

## Why containers share the type hue

Packages need to be distinct from **variables** — `url.Parse` and `url.Host`
are unresolvable by spelling when a variable shadows a package — and cyan vs
white carries that. Giving them a *seventh* colour, distinct from types too,
was tried and abandoned: the wheel is full. Six kinds sit at 8° pink, 46°
orange, 91° yellow, 131° green, 205° cyan, 291° purple, with white reading at
107°, so every candidate was marginal against two neighbours at once:

| Candidate | Worst-case OKLab distance | Rejected because |
|---|---|---|
| Recessed cyan `#4E9DA6` | 0.121 | read muddy |
| Steel `#8CA3B8` | 0.127 | read muddy |
| Blue `#3093F4` → `#30AFF8` | 0.128 | clashed with yellow, then green, then purple |
| Rose `#EE8FC8` | 0.115 | closest of all to a kind |
| Ladder `#E3E3DDA6` | 0.160 | best measured, but reads as absence rather than kind |
| Dark gold `#B49532` | 0.134 | — |

Two findings survive the search and generalize: **mud is chroma 0.04–0.10 at
mid lightness** — a near-neutral there reads as dirt, not restraint — and
**hue discrimination is weakest in the green–cyan arc**, so a teal never buys
the distance its degree count suggests. The conclusion is structural: a palette of six kinds plus white has no room
for a seventh, and merging containers into the closest kind — types, which
they are structurally adjacent to — costs less than any of the alternatives.
