import { fireEvent, within } from "@testing-library/react";

export function selectOption(trigger: HTMLElement, name: string) {
  // jsdom has no layout/scroll implementation; Radix focuses real options.
  HTMLElement.prototype.scrollIntoView ??= () => {};
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(within(document.body).getByRole("option", { name }));
}

type Queries = {
  findByRole: (role: string, options: { name: string | RegExp }) => Promise<HTMLElement>;
};
/** Bots unfold on navigation and activity; expand only when still folded. */
export async function expandBot(slot: Queries, name: string) {
  const toggle = await slot.findByRole("button", {
    name: new RegExp(
      `^(Expand|Collapse) conversations for ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
  });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return toggle;
}
