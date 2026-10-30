/*
 * Prose fields use the shared Markdown editor. Its rich surface is a
 * contenteditable that takes no `change` events, so tests type into the
 * editor's Markdown source instead. Import after `./dom.ts`.
 */
const { fireEvent } = await import("@testing-library/react");

/** The Markdown source textarea behind a prose field, opening source mode if the field shows rich text. */
export function sourceTextbox(element: HTMLElement): HTMLElement {
  if (!element.matches(".tiptap")) return element;
  const wrapper = element.closest(".bb-markdown-editor");
  const button = [...(wrapper?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === "Markdown source",
  );
  if (!button) throw new Error("Markdown editor has no source control");
  fireEvent.click(button);
  const source = wrapper?.querySelector<HTMLElement>("textarea[data-markdown-source]");
  if (!source) throw new Error("Source mode did not open");
  return source;
}
