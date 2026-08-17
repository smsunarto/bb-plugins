# Agent notes — bb Monokai

`CONTRACT.md` is the source of truth. It is a relative symlink to the shared
Cursor Monokai contract in the sibling `smsunarto-theme` checkout. Change the
contract before the bb adapter, never after.

## Layout

| Path | Role |
|---|---|
| `CONTRACT.md` | Shared role and palette contract. Amend first. |
| `scripts/generate-theme.ts` | Palette, role registry, generation, and contract audit. |
| `scripts/bb-monokai.template.css` | Host selectors with symbolic color roles. |
| `scripts/code-theme-rules.json` | Vendored scope map for the code theme. Roles, not hexes. |
| `scripts/code-theme-rules.ts` | Its type and reader. |
| `scripts/sync-code-theme.ts` | Re-vendors that map from the sibling editor theme. |
| `themes/bb-monokai.css` | Generated. Never hand-edit. |
| `themes/bb-monokai-code.json` | Generated Shiki/TextMate theme. Never hand-edit. |
| `test/theme-contract.test.ts` | Regression coverage for the audit's failure modes. |
| `storybook/` | Visual component-state review; live bb remains the host integration check. |

## Loop

Run `bun run generate:theme` after every source change, then `bun run check`.
The check typechecks, verifies the generated CSS is current, and audits the
theme. `bun run build` also runs that check before `bb plugin build .`.

`bun run dev` regenerates before it reloads the local plugin. Use Storybook for
the palette catalog and live bb for shadow DOM and host-selector behavior.

## Audit boundaries

The audit fails on:

- a rendered hex whose base color is not registered;
- a missing root, ANSI, diff, tree, or host-adapter token;
- a legal color assigned to the wrong registered role;
- an unregistered custom property in the root `.dark` block;
- an illegible required foreground/background pair; and
- a syntax token wearing a chrome-only role (the accent, a control color, an
  ANSI content tint), or a code-theme rule that scopes or styles nothing.

## The code theme

`bb.themes[].codeTheme` picks the Shiki theme for diffs and file previews —
token colors are inline styles in a shadow root, so CSS cannot reach them. Dark
only; light stays on `pierre-light`.

The editor theme lives in a private repository, so its scope map is vendored
rather than imported. `bun run sync:code-theme` follows the `CONTRACT.md`
symlink to that checkout and rewrites `code-theme-rules.json`; it is a manual,
authoring-time step and CI never runs it. Every color there is a role name, so
the palette in `generate-theme.ts` stays the only registry. An unmapped hex
stops the sync instead of inventing a role — amend `CONTRACT.md` and the
palette first.

CSS comments are excluded because they document foreign upstream defaults.
The generator owns palette policy; the template owns bb selector mechanics.
Do not put rendered hexes in the template or add a second palette registry.
