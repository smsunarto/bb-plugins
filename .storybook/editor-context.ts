export type EditorPlacement =
  | "page"
  | "page-panel"
  | "thread-panel"
  | "message"
  | "composer"
  | "sidebar"
  | "settings"
  | "overlay";
export type EditorContext = {
  placement: EditorPlacement;
  title: string;
  tab?: string;
};

/** Placements follow the plugin app registrations and BB's SplitThreadArea. */
const placements: Record<string, EditorContext> = {
  "GTD Sidebar": { placement: "sidebar", title: "Threads" },
  "Agent Instructions": { placement: "settings", title: "Agent instructions" },
  Devin: { placement: "composer", title: "Cloud session" },
  Amp: { placement: "message", title: "Amp" },
  "Kitchen Sink": { placement: "message", title: "Kitchen Sink" },
  "Game Studio": { placement: "thread-panel", title: "Game Studio", tab: "Game Studio" },
  "GitHub Stack": { placement: "thread-panel", title: "GitHub Stack", tab: "GitHub Stack" },
  GitButler: { placement: "thread-panel", title: "GitButler", tab: "GitButler" },
  Whiteboard: { placement: "thread-panel", title: "Whiteboard", tab: "Whiteboard" },
  "Inline Visualizations": { placement: "message", title: "Visualization" },
  "Code Review": { placement: "page", title: "Review" },
  Tasks: { placement: "page", title: "Tasks" },
  Dotfiles: { placement: "page", title: "Dotfiles" },
  Agentation: { placement: "page", title: "Agentation" },
  Traces: { placement: "page", title: "Traces" },
  Vimium: { placement: "overlay", title: "Keyboard navigation" },
};

export function editorContextFor(title: string): EditorContext | undefined {
  const [, plugin] = title.split("/");
  if (plugin === "Docs") {
    if (title.includes("Document card")) return { placement: "message", title: "Docs" };
    return { placement: "page", title: "Docs" };
  }
  if (plugin === "Prompt Editor") return { placement: "page", title: "Prompt Editor" };
  return plugin ? placements[plugin] : undefined;
}

export function showsEditor(mode: unknown, viewMode: string, docsIframe = false): boolean {
  return mode === "editor" || (mode === "auto" && viewMode !== "docs" && !docsIframe);
}
