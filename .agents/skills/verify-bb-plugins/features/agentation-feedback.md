# Agentation feedback

## Sub-features

- Feedback mode from the Agentation toolbar.
- Annotation composer and submission.
- Annotation marker placement on the selected element.

## How to get to it (user POV)

Open any bb route. Select **Start feedback mode**. Select a visible target, enter feedback, and select **Add**.

The result shows a numbered annotation marker on the target. Exit feedback mode, then open Agentation to inspect the annotation.

## Driving it with agent-browser

Use the toolbar title because it is Agentation's shipped contract.

```bash
agent-browser --session "$BROWSER_SESSION" click '[data-agentation-toolbar] [title="Start feedback mode"]'
# Select one visible target.
agent-browser --session "$BROWSER_SESSION" find placeholder "What should change?" fill "Verification annotation"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Add"
agent-browser --session "$BROWSER_SESSION" wait '[data-annotation-marker]'
agent-browser --session "$BROWSER_SESSION" press Escape
agent-browser --session "$BROWSER_SESSION" find role button click --name "Agentation"
agent-browser --session "$BROWSER_SESSION" wait --text "Verification annotation"
```

Use a unique note for each run. Save the page before feedback mode, the marker, and the Agentation panel.

## Gotchas

- The content script mounts the toolbar globally. The page does not need its own registration.
- Feedback mode stays active after Add. Press Escape before opening the Agentation panel.
- Annotation submission writes test data. Use a disposable target and record it.
- Remove only test annotations that this run created.
