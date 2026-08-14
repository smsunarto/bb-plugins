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
| `themes/bb-monokai.css` | Generated. Never hand-edit. |
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
- an unregistered custom property in the root `.dark` block; and
- an illegible required foreground/background pair.

CSS comments are excluded because they document foreign upstream defaults.
The generator owns palette policy; the template owns bb selector mechanics.
Do not put rendered hexes in the template or add a second palette registry.
