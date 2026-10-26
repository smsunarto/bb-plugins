# HTML pages

Agents check a self-contained HTML page in headless Chrome and show it inline
in the thread, the way T3 Code agents do. Pages follow bb's light or dark theme
and fit their frame to the content.

## Agent tools

- `html_preview` renders the page in headless Chrome on the bb server and
  returns a PNG, the content height, and console output.
- `html_render` stores the page and returns a `::html-render{…}` directive.
  The agent puts it at the top of its reply, where bb draws the page.

The tool descriptions in `instructions/tools/` are T3 Code's prompt
(pingdotgg/t3code `cc0b86d`), changed only where bb differs from T3: the
directive replaces T3's automatic placement, the column width is bb's 712px,
and there is no browser auto-install or separate mobile frame behavior.

## Behavior

- Absolute image paths are read from the machine the thread runs on and
  inlined. Each image may be at most 10 MiB and the page at most 25 MiB.
- Published pages are served from the bb server in an opaque sandbox
  (`allow-scripts allow-forms allow-popups allow-downloads`) and deleted with
  their thread.
- Previews reach only public addresses: Chrome's traffic goes through a local
  SOCKS proxy that refuses loopback, private, link-local, and the server's own
  addresses after resolving names.

## Settings

- `chromePath`: Chrome or Chromium on the bb server. Empty searches the usual
  macOS and Linux locations and the Playwright cache.
- `chromeNoSandbox`: run Chrome without its sandbox, for root accounts or
  AppArmor-restricted Ubuntu.
