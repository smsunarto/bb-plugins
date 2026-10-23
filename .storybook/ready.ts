import { expect, waitFor, within } from "storybook/test";

export async function ready({ canvasElement }: { canvasElement: HTMLElement }) {
  await waitFor(
    () => {
      const host = canvasElement.querySelector("[data-storybook-host]");
      // renderSlot always appends a container, even when its React root is blank.
      const content = host?.firstElementChild;
      const dialog = canvasElement.ownerDocument.querySelector('[role="dialog"]');
      expect((content?.childElementCount ?? 0) + (dialog ? 1 : 0)).toBeGreaterThan(0);
      expect(host?.textContent).not.toBe("Loading component…");
    },
    { timeout: 15000 },
  );
}

/** State-specific checks for data-backed stories, beyond the generic render smoke. */
export function shows(text: string | RegExp) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const element = await within(canvasElement).findByText(text, {}, { timeout: 15000 });
    await waitFor(() => expect(element).toBeVisible());
  };
}
