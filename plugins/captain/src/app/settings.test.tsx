// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Rung } from "../contract/ladder.ts";
import { captainContract } from "../contract/rpc.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
const section = app.settingsSections.find((each) => each.id === "crew-models")!;

afterEach(cleanup);

const ANTIGRAVITY: Rung = {
  providerId: "acp-antigravity",
  model: "gemini-4-neon",
  reasoningLevel: "high",
};

function render(implement: Rung[]) {
  const saved: { role: string; rungs: Rung[] | null }[] = [];
  let rungs = implement;
  const ladder = () => ({
    roles: [
      { role: "implement", label: "Implement", rungs, custom: true, defaults: implement },
      { role: "review", label: "Review", rungs: implement, custom: false, defaults: implement },
    ],
  });
  const slot = renderSlot(section, {} as never, {
    experimental_rpcContract: captainContract,
    rpc: {
      ladders: ladder,
      setLadder: (input: { role: string; rungs: Rung[] | null }) => {
        saved.push(input);
        rungs = input.rungs ?? implement;
        return ladder().roles[0];
      },
    } as never,
  });
  return { slot, saved };
}

test("a picker that re-emits an ACP rung with its `default` tier saves nothing", async () => {
  const { slot, saved } = render([ANTIGRAVITY]);
  const region = await slot.findByRole("region", { name: "Implement ladder" });
  const picker = within(region).getByTestId("bb-provider-model-picker");

  // bb's picker normalizes a provider that declares tiers to `default`; Captain stores no tier.
  fireEvent.change(within(picker).getByLabelText("Service tier"), {
    target: { value: "default" },
  });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  expect(saved).toEqual([]);

  fireEvent.change(within(picker).getByLabelText("Model"), {
    target: { value: "gemini-4-carbon" },
  });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  await waitFor(() =>
    expect(saved).toEqual([
      { role: "implement", rungs: [{ ...ANTIGRAVITY, model: "gemini-4-carbon" }] },
    ]),
  );
});
