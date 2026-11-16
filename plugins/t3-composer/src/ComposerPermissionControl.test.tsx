// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { PermissionPicker } from "./ComposerPermissionControl";
import { permissionModeOptions } from "./permission-modes";

const ALL = ["accept-edits", "auto", "full"] as const;

function renderSheet(props: Partial<Parameters<typeof PermissionPicker>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <PermissionPicker
        value="full"
        providerName="Claude Code"
        options={permissionModeOptions(ALL, "full")}
        onChange={onChange}
        {...props}
      />
    </CompactViewportOverrideProvider>,
  );
  return onChange;
}

describe("PermissionPicker on a phone", () => {
  afterEach(cleanup);

  it("asks how the provider's actions are approved and marks the current mode", async () => {
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    const rows = await screen.findAllByRole("menuitemradio");
    expect(
      screen.getByRole("dialog", { name: "How should Claude Code actions be approved?" }),
    ).toBeTruthy();
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });

  it("applies the picked mode", async () => {
    const onChange = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Approve for me/ }));
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("shows the machine's limit in place of a disabled mode's description", async () => {
    renderSheet({ value: "auto", options: permissionModeOptions(ALL, "auto") });
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    const full = await screen.findByRole("menuitemradio", { name: /Full Access/ });
    expect(full.hasAttribute("disabled")).toBe(true);
    expect(full.textContent).toContain("Above the selected machine's permission limit.");
  });

  it("stays read-only until the machine's modes are known", () => {
    renderSheet({ options: null });
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.textContent).toContain("Full Access");
  });
});
