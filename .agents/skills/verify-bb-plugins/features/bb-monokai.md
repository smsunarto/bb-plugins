# bb Monokai

## Sub-features

- bb Monokai palette selection.
- Dark app surfaces and semantic color roles.
- Code and diff token colors.

## How to get to it (user POV)

Open **Settings**, then **Appearance**. Open **Palette**. Select **bb Monokai**.

Return to a surface that contains app chrome and code. The palette must style both surfaces.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" find role link click --name "Settings (⌘ ,)"
agent-browser --session "$BROWSER_SESSION" find role link click --name "Appearance"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Palette"
agent-browser --session "$BROWSER_SESSION" find role menuitem click --name "bb Monokai (monokai)"
```

Capture Appearance with the selected palette. Capture a representative code or diff surface. Inspect both images.

## Gotchas

- `launch` already selects `plugin:monokai:bb-monokai`.
- The theme is dark-only. Test it in dark mode.
- CSS cannot style every private editor surface. Read the theme contract before reporting a gap.
