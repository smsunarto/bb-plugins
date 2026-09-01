# Vimium

Vimium-style link hints for keyboard navigation of the bb UI.

## What it does

- Press `f` anywhere outside a text field. Every clickable element on screen gets a small yellow hint label.
- Press `Cmd+Shift+F` anywhere, including bb's composer, which grabs focus by default. `Escape` also leaves the composer, so `Escape` then `f` works too.
- Type a label's letters to click that element. Already-typed letters dim, and non-matching labels disappear.
- `Backspace` drops the last typed letter. `Escape`, any other key, scrolling, or resizing exits hint mode.
- A hint on a text field focuses it instead of clicking, so `f` can drop you straight into typing.
- A hint that opens a dropdown re-prompts automatically, with hints scoped to the dropdown's options and labels starting on the strongest home-row keys (`f`, `j`, `d`, `k`, ...). Dismissing the dropdown dismisses the prompt, and `Cmd+Shift+F` during it starts a fresh whole-screen prompt instead.
- Picking from one of the composer's own dropdowns hands focus back to the composer, so you can keep typing.

## Labels

- bb's built-in composer controls keep pinned single-character labels for muscle memory: `m` model, `p` project, `a` prompt actions, `v` voice, `s` send. Only built-ins get single characters; plugin-added buttons come and go, so they never do.
- Sidebar thread rows (bb's own or any sidebar honoring the thread-shortcut contract) count `1`-`9` in list order.
- Everything else gets two-character labels from the remaining alphabet, so no button can squat on a character you have learned.

Only the `f` hint mode ships — no scrolling keys, search, or other Vimium bindings.
