/**
 * The design system every HTML fragment receives. Colors come from the host
 * theme tokens that `fragment-runtime.ts` copies into the frame, so fragments
 * follow bb's active theme without naming a palette.
 */
export const FRAGMENT_STYLES = String.raw`
:root {
  color-scheme: light dark;
  --font-size-base: 14px;
  --blue: var(--ansi-4);
  --red: var(--ansi-1);
  --green: var(--ansi-2);
  --yellow: var(--ansi-3);
  --purple: var(--ansi-5);
  --cyan: var(--ansi-6);
  --orange: color-mix(in oklch, var(--ansi-1) 45%, var(--ansi-3));
  --viz-series-1: var(--blue);
  --viz-series-2: var(--yellow);
  --viz-series-3: var(--green);
  --viz-series-4: var(--purple);
  --viz-series-5: var(--cyan);
  --viz-series-6: var(--red);
  --viz-radius: var(--radius, 0.5rem);
  --viz-gap: 12px;
  --viz-control-height: 32px;
}
*, *::before, *::after { box-sizing: border-box; }
/* Tabs and carousels toggle the hidden attribute. Author display styles must not undo it. */
[hidden] { display: none !important; }
html, body { margin: 0; background: transparent; }
body {
  display: flow-root;
  padding: 12px 16px;
  color: var(--foreground);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: var(--font-size-base);
  line-height: 1.5;
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { margin: 0 0 8px; font-weight: 500; line-height: 1.3; }
h1 { font-size: 1.25em; }
h2 { font-size: 1.125em; }
h3 { font-size: 1em; }
p { margin: 0 0 8px; }
a { color: var(--blue); }
code, pre { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.92em; }
:not(pre) > code { padding: 0.1em 0.35em; border-radius: 4px; background: var(--muted); }
pre { margin: 0 0 8px; padding: 10px 12px; overflow-x: auto; border-radius: var(--viz-radius); background: var(--muted); }
hr { margin: 12px 0; border: 0; border-top: 1px solid var(--border); }
svg { overflow: visible; }

.card {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--viz-radius);
  background: var(--card);
  color: var(--card-foreground);
}
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--viz-gap); }
.viz-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.viz-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 8px 16px; margin-bottom: var(--viz-gap); }
.viz-controls > .form-label { flex: 1 1 calc(50% - 16px); min-width: 140px; }
.viz-stat { display: flex; flex-direction: column; gap: 2px; }
.viz-stat > :first-child { color: var(--muted-foreground); font-size: 12px; }
.viz-stat-value { font-size: 1.5em; font-weight: 500; line-height: 1.2; font-variant-numeric: tabular-nums; }
.viz-badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
  border-radius: 999px; background: var(--accent); color: var(--accent-foreground);
  font-size: 12px; line-height: 18px; white-space: nowrap;
}
.viz-dotted-background {
  background-image: radial-gradient(color-mix(in oklch, var(--foreground) 14%, transparent) 1px, transparent 1px);
  background-size: 14px 14px;
}

button, input, select, textarea { font: inherit; color: inherit; }
button:not(:disabled), [role="tab"], summary, .cursor-interaction { cursor: pointer; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: var(--viz-control-height); padding: 0 12px;
  border: 1px solid var(--border); border-radius: calc(var(--viz-radius) - 2px);
  background: var(--secondary); color: var(--secondary-foreground);
  font-weight: 500; line-height: 1; text-decoration: none; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: color-mix(in oklch, var(--secondary), var(--foreground) 8%); }
.btn-primary { border-color: transparent; background: var(--primary); color: var(--primary-foreground); }
.btn-primary:hover:not(:disabled) { background: color-mix(in oklch, var(--primary), var(--background) 12%); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--foreground); }
.btn-ghost:hover:not(:disabled) { background: var(--accent); }
.btn-block { display: flex; width: 100%; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn[aria-pressed="true"], .btn[aria-selected="true"], .btn.is-selected {
  border-color: transparent; background: var(--primary); color: var(--primary-foreground);
}
.btn svg, .nav-link svg { width: 16px; height: 16px; flex: none; }
.viz-tile { width: 100%; height: 100%; min-height: 36px; padding: 4px 6px; white-space: normal; }
.viz-tile[aria-pressed="true"], .viz-tile[aria-selected="true"], .viz-tile.is-selected {
  border-color: transparent; background: var(--secondary); color: var(--secondary-foreground);
  box-shadow: 0 0 0 2px var(--ring);
}

.form-label { display: flex; flex-direction: column; gap: 4px; color: var(--muted-foreground); font-size: 12px; }
.form-control, .form-select {
  width: 100%; min-height: var(--viz-control-height); padding: 4px 10px;
  border: 1px solid var(--input, var(--border)); border-radius: calc(var(--viz-radius) - 2px);
  background: var(--background); color: var(--foreground); font-size: var(--font-size-base);
}
textarea.form-control { min-height: 72px; resize: vertical; }
.form-control-color { width: 48px; padding: 2px; }
.form-range { width: 100%; accent-color: var(--primary); }
.form-check { display: inline-flex; align-items: center; gap: 8px; min-height: var(--viz-control-height); }
.form-check-input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary); }
.form-switch .form-check-input {
  appearance: none; width: 30px; height: 18px; border-radius: 999px;
  background: var(--input, var(--border)); position: relative; transition: background 120ms;
}
.form-switch .form-check-input::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--background); transition: transform 120ms;
}
.form-switch .form-check-input:checked { background: var(--primary); }
.form-switch .form-check-input:checked::after { transform: translateX(12px); }

.nav { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: var(--viz-gap); }
.nav-pills { padding: 3px; border-radius: var(--viz-radius); background: var(--muted); width: fit-content; max-width: 100%; }
.nav-justified { width: 100%; }
.nav-justified > .nav-link { flex: 1 1 0; }
.nav-link {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px; padding: 0 12px; border: 0; border-radius: calc(var(--viz-radius) - 3px);
  background: transparent; color: var(--muted-foreground); font-weight: 500;
}
.nav-link:hover:not(:disabled) { color: var(--foreground); }
.nav-link.active, .nav-link[aria-selected="true"] { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px color-mix(in oklch, var(--foreground) 12%, transparent); }
.nav-link:disabled, .nav-link[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }

.progress { height: 6px; overflow: hidden; border-radius: 999px; background: color-mix(in oklch, var(--foreground) 10%, transparent); }
.progress-bar { height: 100%; border-radius: inherit; background: var(--viz-series-1); transition: width 200ms; }

.table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.table th, .table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.table th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; }
.table tbody tr:last-child td { border-bottom: 0; }
.table-sm th, .table-sm td { padding: 4px 8px; }
.table-responsive { max-width: 100%; overflow-x: auto; }
.text-end { text-align: right !important; }
.text-center { text-align: center !important; }
.text-nowrap { white-space: nowrap !important; overflow-wrap: normal !important; }

.text-small { font-size: 12px; }
.text-muted { color: var(--muted-foreground); }
.text-destructive { color: var(--destructive); }
.tabular-nums { font-variant-numeric: tabular-nums; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.tooltip {
  position: fixed; z-index: 2147483646; max-width: min(280px, calc(100vw - 16px));
  padding: 6px 8px; border: 1px solid var(--border); border-radius: calc(var(--viz-radius) - 2px);
  background: var(--popover); color: var(--popover-foreground);
  font-size: 12px; line-height: 1.4; pointer-events: none; white-space: pre-line;
  box-shadow: 0 4px 16px color-mix(in oklch, black 18%, transparent);
}

.viz-carousel { position: relative; padding-bottom: 52px; }
.viz-carousel-nav {
  position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 4px; padding: 3px;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--popover); color: var(--popover-foreground);
}
.viz-carousel-nav button { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: transparent; display: inline-flex; align-items: center; justify-content: center; }
.viz-carousel-nav button:hover { background: var(--accent); }
.viz-carousel-nav select { min-height: 28px; max-width: 220px; padding: 0 6px; border: 0; background: transparent; font-weight: 500; }
.viz-carousel-nav output { padding: 0 6px; color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }

@media (pointer: coarse) {
  :root { --viz-control-height: 44px; }
  .nav-link, .viz-carousel-nav button { min-height: 44px; min-width: 44px; }
  .form-control, .form-select { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
}
`;
