import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import { expect, userEvent, waitFor } from "storybook/test";
import "../src/app/app.css";
let contentScriptLifecycle: Promise<void> = Promise.resolve();
let generation = 0;
function LinkHints() {
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    let scripts: Awaited<ReturnType<typeof mountPluginContentScripts>> | undefined;
    contentScriptLifecycle = contentScriptLifecycle
      .then(async () => {
        if (!active) return;
        const app = await loadPluginApp(() => import("../src/app/app"));
        if (!active) return;
        const mounted = await mountPluginContentScripts(app, {
          pluginId: "vimium",
          generation: ++generation,
        });
        if (active) {
          scripts = mounted;
          setMounted(true);
        } else await mounted.lifecycle.dispose();
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => {
      active = false;
      contentScriptLifecycle = contentScriptLifecycle.then(async () => {
        await scripts?.lifecycle.dispose();
      });
    };
  }, []);
  if (error) throw error;
  return (
    <section className="sb-stack" data-vimium-ready={mounted}>
      <h2>Keyboard navigation</h2>
      <p>
        Press f to show hints. Type a label to activate its control. Escape dismisses the overlay.
      </p>
      <div className="sb-gallery">
        <button type="button">Review changes</button>
        <a href="#details">Open details</a>
        <button type="button">New task</button>
      </div>
      <input aria-label="Draft" placeholder="Typing here does not open hints" />
    </section>
  );
}
const meta = { title: "Screens/Vimium/Link hints", component: LinkHints } satisfies Meta<
  typeof LinkHints
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardNavigation: Story = {};
export const HintsVisible: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(
      () => expect(canvasElement.querySelector("[data-vimium-ready=true]")).toBeTruthy(),
      { timeout: 10000 },
    );
    const user = userEvent.setup({ document: canvasElement.ownerDocument });
    await user.click(canvasElement.querySelector("h2")!);
    await user.keyboard("f");
    await waitFor(() =>
      expect(canvasElement.ownerDocument.querySelector(".vimium-hint-layer")).toBeTruthy(),
    );
  },
};
