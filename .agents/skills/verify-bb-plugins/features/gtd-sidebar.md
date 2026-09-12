# GTD sidebar

## Sub-features

- GTD Sidebar choice in Appearance settings.
- Pinned, Next Action, Waiting, Snoozed, and Settled shelves.
- Project and machine scope selection.
- Pinned, Next Action, and Snoozed families sort by latest attention. Waiting sorts by latest update, and Settled by settlement time. Active children can raise their family in the list.
- Project groups inside every shelf once two projects are in view: a header button named `<project> project` folds the group (`<project> project (n)` or `(needs / total)` while folded), and a hover-only `New thread in <project>` button opens the project. Shelf and group headers are sticky. No headers with a single project.

## How to get to it (user POV)

Open **Settings**, then **Appearance**. Open **Sidebar thread list**. Select **GTD Sidebar**.

Return to the main surface. The sidebar groups matching threads under GTD shelves.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" find role link click --name "Settings (⌘ ,)"
agent-browser --session "$BROWSER_SESSION" wait 'a[href="/settings/appearance"]'
agent-browser --session "$BROWSER_SESSION" find role link click --name "Appearance"
agent-browser --session "$BROWSER_SESSION" wait 'button[aria-label="Sidebar thread list"]'
agent-browser --session "$BROWSER_SESSION" find role button click --name "Sidebar thread list"
agent-browser --session "$BROWSER_SESSION" wait '[role="menuitem"]'
agent-browser --session "$BROWSER_SESSION" find role menuitem click --name "GTD Sidebar (inbox) Next Action and Waiting, with recent threads first."
agent-browser --session "$BROWSER_SESSION" wait --fn '!document.querySelector("[role=menu]")'
```

Capture the selected setting. Then return to the main surface and capture the grouped sidebar.

## Gotchas

- Selecting the option changes the pinned test instance.
- `launch` resets plugin settings before the next run.
- The generic fixture can expose only Next Action. Use a purpose-built fixture to prove every shelf.
- Shelves render only when matching threads exist. Do not report a missing empty shelf as a product gap.
- `bb thread spawn --project <id> --provider codex --title <t> --prompt hello --send-at 7d` creates an idle Next Action thread without running an agent. Two projects are needed before any group header renders.
- The row's Snooze button sits under the row's full-bleed anchor. Trigger it with a `pointerdown` PointerEvent through `eval`, or use the row's context menu.
