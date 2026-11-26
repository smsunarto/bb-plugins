# Lens: Visual

Check the UI the change touches in a running build, not by reading code.

- Build and run the change from your worktree on the test instance the brief names, with live plugins, theme, appearance (defaulting to Dark appearance and the bb Monokai theme when the brief does not specify them), and realistic data density (for example multiple rows or items, not a single stub).
- Capture screenshots at a narrow and a wide width.
- Compare the changed UI directly against neighboring elements for consistent frame, spacing, alignment, and contrast.
- Look for clipping, overlap, unreadable contrast, layout shift while data loads, and controls out of reach at narrow widths.
- Check every state the change adds: loading, empty, error, offline, and long or non-Latin text.
- Report each finding with the screenshot path, the state and width, and what is wrong. Attach screenshots to the task.
