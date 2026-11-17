// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { PermissionPicker } from "./ComposerPermissionControl";
import { CEILING_REASON, permissionModeOptions } from "./permission-modes";

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

  it("shows each mode by name alone, and why a mode above the machine's limit is off", async () => {
    renderSheet({ value: "auto", options: permissionModeOptions(ALL, "auto") });
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    const rows = await screen.findAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Accept Edits",
      "Approve for me",
      `Full Access${CEILING_REASON}`,
    ]);
    expect(rows[2]!.hasAttribute("disabled")).toBe(true);
  });

  it("names only the mode in the trigger's tooltip", () => {
    renderSheet({ value: "auto" });
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(
      "Permission mode: Approve for me",
    );
  });

  it("stays read-only until the machine's modes are known", () => {
    renderSheet({ options: null });
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.textContent).toContain("Full Access");
  });
});
