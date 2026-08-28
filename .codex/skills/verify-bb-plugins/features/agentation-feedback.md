# Agentation feedback

## Sub-features

- Feedback mode from the Agentation toolbar.
- Annotation composer and submission.
- Annotation marker placement on the selected element.

## How to get to it (user POV)

Open a bb page that owns an Agentation toolbar. Select **Start feedback mode**. Select a visible target, enter feedback, and select **Add**.

The result shows a numbered annotation marker on the target. The annotation appears in the Agentation panel.

## Driving it with agent-browser

Use the toolbar title because it is Agentation's shipped contract.

```bash
agent-browser --session "$BROWSER_SESSION" find css '[data-agentation-toolbar] [title="Start feedback mode"]' click
agent-browser --session "$BROWSER_SESSION" find placeholder "What should change?" fill "Verification annotation"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Add"
agent-browser --session "$BROWSER_SESSION" wait --selector '[data-annotation-marker]'
```

Choose the target between the first and second commands. Save a screenshot before feedback mode and after the marker appears.

## Gotchas

- The target must belong to a page with Agentation registered.
- Annotation submission writes test data. Use a disposable target and record it.
- Remove only test annotations that this run created.
