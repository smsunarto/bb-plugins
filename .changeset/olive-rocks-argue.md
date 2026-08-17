---
"@smsunarto/bb-plugin-monokai": minor
---

Paint the syntax tokens. Diffs and file previews were the one surface the
palette could not reach — Shiki writes an inline style on every span inside a
shadow root — so they stayed on bb's `pierre-dark` while everything around them
was Monokai. bb 0.38 added `bb.themes[].codeTheme`, which picks the Shiki theme
instead of trying to restyle its output, and the plugin now ships one:
`themes/bb-monokai-code.json`, the same TextMate layer as the Cursor Monokai
editor theme. Pink machinery, cyan structure, green callables, yellow literals,
purple constants, gray commentary, white for everything else.

Dark only, like the palette: light mode keeps `pierre-light`.

The scope map is vendored as roles rather than hexes, so the palette in
`scripts/generate-theme.ts` stays the single registry, and the generator now
also rejects a syntax token wearing a chrome-only role.
