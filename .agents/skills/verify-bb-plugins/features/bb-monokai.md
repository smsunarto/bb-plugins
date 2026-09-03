# bb Monokai

## Sub-features

- bb Monokai palette selection.
- Dark app surfaces and semantic color roles.
- Code and diff token colors.
- UI font selection between Inter and SF Pro.

## How to get to it (user POV)

Open **Settings**, then **Appearance**. Open **Palette**. Select **bb Monokai**.

Return to a surface that contains app chrome and code. The palette must style both surfaces. Open **bb Monokai** settings to change the UI font.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" find role link click --name "Settings (⌘ ,)"
agent-browser --session "$BROWSER_SESSION" find role link click --name "Appearance"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Palette"
agent-browser --session "$BROWSER_SESSION" find role menuitem click --name "bb Monokai (monokai)"
agent-browser --session "$BROWSER_SESSION" wait 'a[href="/settings/plugins/monokai"]'
agent-browser --session "$BROWSER_SESSION" find role link click --name "bb Monokai"
agent-browser --session "$BROWSER_SESSION" find role button click --name "UI font"
agent-browser --session "$BROWSER_SESSION" find role menuitem click --name "SF Pro"
agent-browser --session "$BROWSER_SESSION" wait 'button[type="submit"]:not([disabled])'
agent-browser --session "$BROWSER_SESSION" click 'button[type="submit"]'
agent-browser --session "$BROWSER_SESSION" wait --fn "getComputedStyle(document.documentElement).getPropertyValue('--bb-monokai-ui-font').includes('SF Pro')"
```

Capture Appearance, the selected UI font, and a representative code or diff surface. Inspect each image.

Check `--bb-monokai-ui-font` on the document root. Restore Inter, submit the form, and wait for `Inter Variable` before cleanup.

## Gotchas

- `launch` already selects `plugin:monokai:bb-monokai`.
- The theme is dark-only. Test it in dark mode.
- The UI font setting does not change the code font.
- The settings form remounts after a font selection. Wait for its enabled submit button.
- CSS cannot style every private editor surface. Read the theme contract before reporting a gap.
