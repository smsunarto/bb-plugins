# Vimium

Vimium-style link hints for keyboard navigation of the bb UI.

## What it does

- Press `f` anywhere outside a text field. Every clickable element on screen gets a small yellow hint label.
- bb's passive composer autofocus is released. Press `i`, click the composer, or Tab to it when you want to type.
- Press `Cmd+Shift+F` anywhere, including bb's composer. `Escape` also leaves the composer, so `Escape` then `f` works too.
- Type a label's letters to click that element. Already-typed letters dim, and non-matching labels disappear.
- `Backspace` drops the last typed letter. `Escape`, any other key, scrolling, or resizing exits hint mode.
- A hint on a text field focuses it instead of clicking, so `f` can drop you straight into typing.
- A hint that opens a dropdown re-prompts automatically with labels scoped to that popup. Provider tabs count `1`-`9`. Model and reasoning choices use ergonomic single keys, and model search is `i`. Projects use single keys, with `i` for New project and `x` for Don't work in a project. Permission modes start at `a`, `s`, `d`, `f`, `g`, and `h`. Other dropdowns start at `f`, `j`, `d`, and `k`.
- `Cmd+Shift+F` always means the whole screen. During a scoped prompt it replaces it, and over an open dropdown or dialog it closes the popup first, since an open popup hides the rest of the page from hinting.
- Picking from one of the composer's own dropdowns hands focus back to the composer once the popup closes, so you can keep typing.
- The conversation timeline never gets hints. It rerenders and auto-scrolls while an agent streams, and its own scrolling never dismisses a prompt — only a scroll that moves a hinted element does.

## Labels

- bb's stable controls keep pinned single-character labels for muscle memory: `p` project, `i` composer input, `l` machine, `b` branch, `n` new thread, `s` thread search, `k` permission mode, `j` send, `m` model, `a` prompt actions, and `v` voice.
- Core navigation is stable too: `[` back, `]` forward, `e` Extensions, `,` Settings, `q` left sidebar, and `\` right sidebar. The context-window tracker is never selectable.
- Sidebar thread rows (bb's own or any sidebar honoring the thread-shortcut contract) count `1`-`9` in list order.
- Everything else gets two-character labels from the remaining alphabet, extended past the reserved carve-outs so even a diff-heavy screen stays at two characters.

The plugin ships `f` hint mode and the `i` composer shortcut. It does not add scrolling keys or search.
