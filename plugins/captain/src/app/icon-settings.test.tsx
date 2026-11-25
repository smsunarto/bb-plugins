// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CaptainIcon } from "../contract/icon.ts";
import { captainContract } from "../contract/rpc.ts";

// The upload's decode, held open so a test can finish it after a newer edit.
const decode = vi.hoisted(() => ({ finish: (_src: string) => {} }));
vi.mock("./icon-image.ts", () => ({
  iconImage: () =>
    new Promise<string>((resolve) => {
      decode.finish = resolve;
    }),
}));

const app = await loadPluginApp(() => import("./app.tsx"));
const section = app.settingsSections.find((each) => each.id === "captain-icons")!;

afterEach(cleanup);

const CAPTAIN = "thr_captain";
const PNG_URL = "data:image/png;base64,AAAA";

function render(setIcon: (input: { icon: unknown }) => unknown) {
  let icon: CaptainIcon = { kind: "icon", name: "Star" };
  const saved: unknown[] = [];
  const slot = renderSlot(section, {} as never, {
    experimental_rpcContract: captainContract,
    rpc: {
      captainIcons: () => ({ captains: [{ threadId: CAPTAIN, name: "Plugins", icon }] }),
      setIcon: (input: { icon: unknown }) => {
        saved.push(input.icon);
        const result = setIcon(input);
        icon = (input.icon ?? { kind: "default" }) as CaptainIcon;
        return result ?? icon;
      },
    } as never,
  });
  return { slot, saved };
}

test("a failed save keeps the name the user typed, with the reason", async () => {
  const { slot } = render(() => {
    throw new Error("bb is offline");
  });
  const field = (await slot.findByLabelText("Icon name for Plugins")) as HTMLInputElement;
  expect(field.value).toBe("Star");
  fireEvent.change(field, { target: { value: "Target" } });
  fireEvent.click(slot.getByRole("button", { name: "Set icon" }));
  await slot.findByText(/Not saved: .*bb is offline/u);
  expect(field.value).toBe("Target");
});

test("a save that lands clears the draft back to the stored name", async () => {
  const { slot, saved } = render(() => undefined);
  const field = (await slot.findByLabelText("Icon name for Plugins")) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "target" } });
  fireEvent.click(slot.getByRole("button", { name: "Set icon" }));
  await waitFor(() => expect(saved).toEqual([{ kind: "icon", name: "Target" }]));
  await waitFor(() => expect(field.value).toBe("Target"));
});

test("an upload that finishes after a newer edit is dropped", async () => {
  const { slot, saved } = render(() => undefined);
  const field = (await slot.findByLabelText("Icon name for Plugins")) as HTMLInputElement;
  const file = new File(["png"], "crest.png", { type: "image/png" });
  fireEvent.change(slot.getByLabelText("Image for Plugins"), { target: { files: [file] } });
  fireEvent.change(field, { target: { value: "Brain" } });
  fireEvent.click(slot.getByRole("button", { name: "Set icon" }));
  await waitFor(() => expect(saved).toEqual([{ kind: "icon", name: "Brain" }]));
  await act(async () => decode.finish(PNG_URL));
  await new Promise((settle) => setTimeout(settle, 20));
  expect(saved).toEqual([{ kind: "icon", name: "Brain" }]);
});

test("an upload from an unmounted row cannot save after Settings is reopened", async () => {
  const received: unknown[] = [];
  const record = ({ icon }: { icon: unknown }) => {
    received.push(icon);
  };
  const first = render(record).slot;
  const input = await first.findByLabelText("Image for Plugins");
  const file = new File(["png"], "crest.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  first.lifecycle.unmount();

  const reopened = render(record).slot;
  const field = await reopened.findByLabelText("Icon name for Plugins");
  fireEvent.change(field, { target: { value: "Brain" } });
  fireEvent.click(reopened.getByRole("button", { name: "Set icon" }));
  await waitFor(() => expect(received).toEqual([{ kind: "icon", name: "Brain" }]));
  await act(async () => decode.finish(PNG_URL));
  expect(received).toEqual([{ kind: "icon", name: "Brain" }]);
});
