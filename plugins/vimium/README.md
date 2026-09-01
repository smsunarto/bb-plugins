# Vimium

Vimium-style link hints for keyboard navigation of the bb UI.

## What it does

- Press `f` anywhere outside a text field. Every clickable element on screen gets a small yellow hint label.
- Press `Cmd+Shift+F` anywhere, including bb's composer, which grabs focus by default. `Escape` also leaves the composer, so `Escape` then `f` works too.
- Type a label's letters to click that element. Already-typed letters dim, and non-matching labels disappear.
- `Backspace` drops the last typed letter. `Escape`, any other key, scrolling, or resizing exits hint mode.
- A hint on a text field focuses it instead of clicking, so `f` can drop you straight into typing.

Only the `f` hint mode ships — no scrolling keys, search, or other Vimium bindings.
