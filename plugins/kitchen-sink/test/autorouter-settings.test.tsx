import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

async function settingsPanel() {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  return app.navPanels.find((panel) => panel.id === "autorouter-settings")!;
}

test("a failed guidance save preserves the draft and explains the error", async () => {
  const update = mock(async () => {
    throw new Error("Settings storage unavailable");
  });
  const slot = renderSlot(
    await settingsPanel(),
    { subPath: "" },
    {
      settings: { autorouterEnabled: true },
      rpc: { updateAutorouterSettings: update },
    },
  );
  fireEvent.click(slot.getByText("General routing guidance"));
  fireEvent.change(slot.getByLabelText("General routing rule"), {
    target: { value: "My custom routing instructions" },
  });
  fireEvent.click(
    slot
      .getAllByRole("button", { name: "Save changes" })
      .find((button) => !button.hasAttribute("disabled"))!,
  );
  expect(await slot.findByRole("alert")).toHaveProperty(
    "textContent",
    "Settings storage unavailable",
  );
  expect(slot.getByLabelText("General routing rule")).toHaveProperty(
    "value",
    "My custom routing instructions",
  );
  expect(update).toHaveBeenCalledWith({
    values: { autorouterGeneralRule: "My custom routing instructions" },
  });
  slot.unmount();
});

test("a disabled fallback stays visible and invalid project JSON cannot be saved", async () => {
  const slot = renderSlot(
    await settingsPanel(),
    { subPath: "" },
    {
      settings: { autorouterFallback: "sol/high", autorouterModel_sol: false },
    },
  );
  expect(
    slot.getByRole("option", { name: "5.6 Sol · high (disabled)" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(slot.getByText(/This fallback is disabled/)).toBeTruthy();
  fireEvent.click(slot.getByText("Advanced: edit project index"));
  fireEvent.change(slot.getByLabelText("Project index JSON"), { target: { value: "invalid" } });
  expect(slot.getByText("Enter a valid JSON array.")).toBeTruthy();
  expect(
    slot
      .getAllByRole("button", { name: "Save changes" })
      .every((button) => button.hasAttribute("disabled")),
  ).toBe(true);
  expect(slot.rpcCalls).toHaveLength(0);
  slot.unmount();
});
