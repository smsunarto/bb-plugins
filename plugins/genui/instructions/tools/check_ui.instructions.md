# Inline UI reference
The ```ui language used by the Inline UI section below.
Syntax: one statement per line. `$x = 8` is state inputs bind to; `name = expr` names a value and `f = (a, b) => expr` a function; each bare expression renders. JS expressions incl. ** ?: ?? `${x}` [lists] {objects} x.y map/filter/find/join/length, plus round(x, d), fmt(x, d), sum, min, max, abs, entries, Load(path), sqrt floor ceil clamp range(a, b, step?). Named args go last: Slider($n, 0, 10, label: "N").
Components (? optional; tone: neutral|good|warn|bad|info if meaningful; more in the next section):
{{components}}
Actions: {{actions}}; a list runs in order; a picked Send puts its text in the user's message.
Data: Load("path") reads JSON/CSV/TSV/JSONL from the workspace, "$BB_THREAD_STORAGE/x.json" or /tmp into lists and objects, and other files (a log, tsc output) as text; never retype values a file or command output holds. Snippet and Image read files the same way. Table/Chart/Metric not from Load: source: "illustrative"|"user-provided"|URL.
Games, simulations, custom visuals: write ```app, a self-contained HTML page (inline CSS/JS, CSS vars --foreground --muted-foreground --border --primary --card; no network; localStorage persists; dialogs don't show). Contract: ui_examples(["app"]); check with check_ui(spec, language: "app").
