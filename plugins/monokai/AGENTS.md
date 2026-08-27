# bb Monokai

- `CONTRACT.md` is the source of truth. Amend it before the bb adapter.
- Do not edit `themes/bb-monokai.css` or `themes/bb-monokai-code.json` by hand.
- Use Storybook for the palette catalog. Use live bb for shadow DOM and host selectors.
- Code theme tokens are inline styles in a shadow root. CSS cannot set them. The theme is dark only. Light stays on `pierre-light`.
- `sync:code-theme` is an authoring step. CI never runs it. The editor theme is a private sibling checkout.
- An unmapped hex stops the sync. Amend `CONTRACT.md` and the palette first.
- The generator owns palette policy. The template owns bb selector mechanics.
- Do not put rendered hexes in the template. Do not add a second palette registry.
- CSS comments are excluded. They document foreign upstream defaults.
