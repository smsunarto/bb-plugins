# weather-widget

A small weather readout that hosts drop onto a page with one script tag. It
renders a plain text block from a reading, so it works the same in a terminal,
an email, and a `<pre>`.

`bun run build` transpiles `src/*.ts`, strips the module syntax, joins the files
in name order, and writes `generated/widget.js` as one IIFE that hangs
`globalThis.WeatherWidget` off the page. The banner carries a hash of the bundle
body, which is what the CDN uses to tell two uploads apart. `generated/widget.js` is
committed, so rerun the build whenever `src/` changes.
