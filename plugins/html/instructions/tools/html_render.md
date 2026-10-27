Publish a finished HTML page inline in this thread, above your final reply. Returns a directive that embeds the saved page in the conversation.

BEFORE CALLING

- Check the page with `html_preview`, inspect its PNG and console output, and use its `contentHeight` as `height`.
- For a bare fragment (no doctype, html, head, or body), read the `html` skill first. Fragments receive bb's visualization runtime.

LAYOUT AND THEME

- The frame uses the reply width (712px desktop, about 360px phones) and fits content up to 20,000px high on the thread background.
- Leave `html`, `body`, and the outer element transparent, with no outer card, border, banner title, or side padding. This overrides any page-background rule. A box needing its own background gets 16px padding and `var(--radius)` corners.
- Let content determine height; give charts fixed pixel heights. Avoid `vh` units and `height:100%` on `html` or `body`: they are rejected or cause sizing loops.
- Use theme CSS variables on `:root` instead of fixed colors: `--background`, `--foreground`, `--muted`, `--card`, `--popover`, `--secondary`, `--border`, `--ring`, `--primary`, `--accent`, `--destructive`, `--warning`, `--success`, `--info`, `--code-background`, `--chart-1` through `--chart-6`, `--radius`, `--font-sans`, and `--font-mono`. Most colors have a matching `-foreground`; accent, destructive, and warning also have `-surface`. The base sheet supplies background, text, and font styles.

RETURNS AND NEXT STEP
Put the returned directive on its own line at the top of your final reply. The reader sees the page above that reply; add only what the page does not say. Do not announce or restate it.
