# bb-plugin-theme

Contributes **Cursor Monokai** as a selectable bb palette.

Selectable id: `plugin:theme:smsunarto`.

```sh
bb plugin install ./plugins/theme
bb theme set plugin:theme:smsunarto
```

## How it works

`bb.themes` in `package.json` points bb at `themes/smsunarto.css`. bb reads
that file straight from the plugin directory and injects it as the last
stylesheet, so it wins over the default palette. There is no copy under
`~/.bb/theme` and no build step for the CSS.

`server.ts` does nothing but log. It exists because `bb.server` is a required
manifest field.

## Editing the palette

1. Edit `themes/smsunarto.css`.
2. `bb plugin reload theme`.
3. Re-apply with `bb theme set plugin:theme:smsunarto` if the palette does not
   refresh.

The palette is dark-only: the `.dark` block restyles the app and light mode
keeps bb's defaults. The `:root, .light` block holds the mode-independent text
tiers and fonts.

## Limits

- Code and diff token colors come from bb's bundled shiki themes. CSS cannot
  change them.
- The palette asks for **Berkeley Mono**, a commercially licensed font that is
  not bundled. Without it installed the font stack
  falls back to `ui-monospace`.
- Disabling or removing this plugin drops bb back to the default palette.
