---
name: diffs
description: Use when an app uses @pierre/diffs to render or edit code files, diffs,
  patches, merge conflicts, or CodeView review surfaces, including React,
  vanilla JavaScript, SSR, workers, annotations, selection, and custom Shiki
  languages or themes.
---

# `@pierre/diffs`

Use `@pierre/diffs` to render syntax-highlighted files and diffs. Use its optional editor, SSR, and worker entries for those capabilities.

## Install

```bash
bun add @pierre/diffs
```

Install `react` and `react-dom` when the app uses the React entry.

## Select an API reference

| Surface                                                      | Reference               |
| ------------------------------------------------------------ | ----------------------- |
| Root components, parsing, and file extension APIs            | Core API                |
| Languages, themes, highlighter state, and streams            | Highlighting API        |
| Renderers, managers, DOM helpers, comparisons, and constants | Low-level rendering API |
| Shared data, option, render, selection, and editor types     | Shared types            |
| `@pierre/diffs/react`                                        | React API               |
| `@pierre/diffs/edit`                                         | Editor API              |
| `@pierre/diffs/ssr`                                          | SSR API                 |
| `@pierre/diffs/worker` and worker scripts                    | Worker API              |

## Select a recipe

| Task                                | Recipe                         |
| ----------------------------------- | ------------------------------ |
| Render a file or diff in React      | Render with React              |
| Render a file or diff without React | Render with vanilla JavaScript |
| Build a virtualized review surface  | Use CodeView                   |
| Edit a React surface or CodeView    | Edit with React                |
| Edit a vanilla surface or CodeView  | Edit with vanilla JavaScript   |
| Preload markup on the server        | Use SSR                        |
| Highlight through a worker pool     | Use workers                    |
| Add line annotations and selection  | Add annotations and selection  |
| Register a Shiki language or theme  | Register custom highlighting   |
