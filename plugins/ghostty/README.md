# bb-plugin-ghostty

Terminal tabs rendered by libghostty instead of BB's built-in terminal.

## What it does

- Adds a **"Ghostty terminal"** action to the thread right panel (next to
  "Start terminal"). The tab renders with [`ghostty-web`](https://github.com/coder/ghostty-web) —
  Ghostty's VT engine (libghostty-vt) compiled to WebAssembly, with a canvas
  renderer and an xterm.js-compatible API.
- The PTY is a normal BB terminal session (`bb.sdk.terminals`, thread scope,
  title `Ghostty`), so it runs in the thread's environment and survives tab
  close/reopen. Reopening the tab reattaches to the live session and replays
  the scrollback tail.
- Theme follows the host: background/foreground/cursor resolve from BB's CSS
  variables at mount time.

## How it works

| Piece | Mechanism |
|---|---|
| VT + rendering | `ghostty-web` WASM, bundled into `dist/app.js` |
| WASM delivery | `assets/ghostty-vt.wasm` served by the backend at `/api/v1/plugins/ghostty/http/wasm` |
| Output stream | Frontend polls `readOutput` rpc with a seq cursor (60–500 ms adaptive); buffer truncation triggers a full reset + tail re-sync |
| Input | `onData` → base64 → `sendInput` rpc, promise-chained to keep keystroke order |
| Resize | `FitAddon` + ResizeObserver → `resize` rpc |
| Exit | Overlay with exit code and a "Start new shell" button (`terminals.restart`) |

## Settings

`bb plugin config ghostty` or Settings → Plugins → Ghostty:

- `fontFamily`, `fontSize`, `cursorBlink`, `scrollback` (applied on next tab mount)

## Development

```sh
npm install
bb plugin install . --yes
bb plugin dev          # watch: rebuild + reload on save
```

When upgrading `ghostty-web`, re-vendor the WASM:

```sh
cp node_modules/ghostty-web/ghostty-vt.wasm assets/ghostty-vt.wasm
```

## Limitations

- The built-in terminal UI stays available — BB has no slot to replace it
  wholesale; this adds a parallel, libghostty-rendered surface over the same
  sessions.
- Output is polled over rpc, not streamed over a socket; latency is bounded by
  the 60 ms active poll interval.
- The ANSI 16-color palette is fixed (Ghostty-ish defaults); only
  background/foreground/cursor/selection follow the host theme.
