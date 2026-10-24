import { describe, expect, it } from "bun:test";
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import type { CheckoutSlot } from "../shared/unity-editor-contract.ts";
import { selectGameCheckout, selectGameRequestCheckout } from "./game-checkout-selection.ts";

const game = { projectId: "project-rampage", hostId: "host-mac", rootPath: "/games/rampage" };

function composerWith(initial: ComposerSelection) {
  let selection = initial;
  const patches: ComposerSelection[] = [];
  return {
    patches,
    get selection() {
      return selection;
    },
    async setSelection(patch: ComposerSelection) {
      patches.push(patch);
      selection = { ...selection, ...patch };
      return selection;
    },
  };
}

function unityCheckout(inputs: { slotId: string } | Record<string, never>) {
  return {
    projectId: "project-rampage",
    providerId: "codex",
    model: "gpt-6",
    environment: {
      type: "provider" as const,
      environmentProviderId: "unity-rampage-slot",
      machine: { type: "existing" as const, hostId: "host-mac" },
      inputs,
    },
  };
}

describe("Studio checkout selection", () => {
  const inputs: ({ slotId: string } | Record<string, never>)[] = [
    { slotId: "slot-performance" },
    {},
  ];
  it.each(inputs)("preserves the selected Unity checkout inputs %j", async (inputs) => {
    const composer = composerWith(unityCheckout(inputs));
    const result = await selectGameCheckout(composer, game);
    expect(result).toEqual({
      projectId: "project-rampage",
      providerId: "codex",
      model: "gpt-6",
      environment: {
        type: "provider",
        environmentProviderId: "unity-rampage-slot",
        machine: { type: "existing", hostId: "host-mac" },
        inputs,
      },
    });
    expect(composer.patches).toEqual([{}]);
  });

  it("does not replace a loading or blocked checkout with the game root", async () => {
    const composer = composerWith({ projectId: "project-rampage", providerId: "codex" });
    expect(await selectGameCheckout(composer, game)).toEqual({
      projectId: "project-rampage",
      providerId: "codex",
    });
    expect(composer.selection).toEqual({ projectId: "project-rampage", providerId: "codex" });
    expect(composer.patches).toEqual([{}]);
  });

  it("refuses a Unity checkout selected on another machine", async () => {
    const initial = unityCheckout({ slotId: "slot-elsewhere" });
    initial.environment.machine.hostId = "host-elsewhere";
    const composer = composerWith(initial);
    await expect(selectGameCheckout(composer, game)).rejects.toThrow(
      "Select a Unity checkout on this project's machine before preparing a request.",
    );
    expect(composer.selection.environment).toEqual({
      type: "provider",
      environmentProviderId: "unity-rampage-slot",
      machine: { type: "existing", hostId: "host-elsewhere" },
      inputs: { slotId: "slot-elsewhere" },
    });
    expect(composer.patches).toEqual([{}]);
  });

  it("seeds the game project, machine and full root path for a different project", async () => {
    const composer = composerWith({ projectId: "another-project", providerId: "codex" });
    expect(await selectGameCheckout(composer, game)).toEqual({
      projectId: "project-rampage",
      providerId: "codex",
      environment: {
        type: "host",
        hostId: "host-mac",
        workspace: { type: "unmanaged", path: "/games/rampage" },
      },
    });
    expect(composer.patches).toEqual([
      {},
      {
        projectId: "project-rampage",
        environment: {
          type: "host",
          hostId: "host-mac",
          workspace: { type: "unmanaged", path: "/games/rampage" },
        },
      },
    ]);
  });

  it("retains the existing root fallback for another resolved environment", async () => {
    const composer = composerWith({
      projectId: "project-rampage",
      environment: {
        type: "host",
        hostId: "host-mac",
        workspace: { type: "unmanaged", path: "/games/other" },
      },
    });
    expect(await selectGameCheckout(composer, game)).toEqual({
      projectId: "project-rampage",
      environment: {
        type: "host",
        hostId: "host-mac",
        workspace: { type: "unmanaged", path: "/games/rampage" },
      },
    });
  });
});

function registeredCheckout() {
  const slot = {
    id: "inventory-checkout-id",
    hostId: "host-mac",
    workspacePath: "/games/rampage",
    mainEditors: [],
    mppmEditors: [],
    claims: [],
    reservations: [],
    lifecycle: {
      id: "slot-performance",
      hostId: "host-mac",
      workspacePath: "/games/rampage",
      projectId: "project-rampage",
      state: "available",
      ownerThreadId: null,
      reason: null,
      updatedAt: "2026-10-15T00:00:00.000Z",
    },
  } satisfies CheckoutSlot;
  return {
    slot,
    inventory: {
      hostId: "host-mac",
      instances: [],
      warnings: [],
      claims: [],
      reservations: [],
      slots: [slot],
    },
  };
}

describe("Studio prepared requests", () => {
  const connectFirst =
    "Start a thread in the selected Unity checkout, then connect that checkout in Game Studio before preparing a request.";

  it("waits for an unresolved checkout before preparing context", async () => {
    const composer = composerWith({ projectId: "project-rampage", providerId: "codex" });
    const { inventory } = registeredCheckout();
    await expect(selectGameRequestCheckout(composer, game, async () => inventory)).rejects.toThrow(
      "Finish selecting a checkout in BB before preparing a Game Studio request.",
    );
    expect(composer.selection).toEqual({ projectId: "project-rampage", providerId: "codex" });
    expect(composer.patches).toEqual([{}]);
  });

  it("allows the registered checkout at the game's exact root using its lifecycle id", async () => {
    const composer = composerWith(unityCheckout({ slotId: "slot-performance" }));
    const { inventory } = registeredCheckout();
    const requests: { hostId: string }[] = [];
    const result = await selectGameRequestCheckout(composer, game, async (input) => {
      requests.push(input);
      return inventory;
    });
    expect(result).toEqual({
      projectId: "project-rampage",
      providerId: "codex",
      model: "gpt-6",
      environment: {
        type: "provider",
        environmentProviderId: "unity-rampage-slot",
        machine: { type: "existing", hostId: "host-mac" },
        inputs: { slotId: "slot-performance" },
      },
    });
    expect(requests).toEqual([{ hostId: "host-mac" }]);
    expect(composer.patches).toEqual([{}]);
  });

  it("blocks automatic allocation before a prepared context can be inserted", async () => {
    const composer = composerWith(unityCheckout({}));
    const { inventory } = registeredCheckout();
    const draft = { text: "User draft", mentions: [] as string[] };
    const prepare = async () => {
      await selectGameRequestCheckout(composer, game, async () => inventory);
      draft.text += "\nBuild Rampage";
      draft.mentions.push("Game Studio context");
    };
    await expect(prepare()).rejects.toThrow(connectFirst);
    expect(draft).toEqual({ text: "User draft", mentions: [] });
    expect(composer.selection.environment).toEqual({
      type: "provider",
      environmentProviderId: "unity-rampage-slot",
      machine: { type: "existing", hostId: "host-mac" },
      inputs: {},
    });
  });

  it("blocks another checkout's context without changing its explicit selection", async () => {
    const composer = composerWith(unityCheckout({ slotId: "slot-performance" }));
    const { slot, inventory } = registeredCheckout();
    slot.workspacePath = "/games/rampage-performance";
    slot.lifecycle.workspacePath = "/games/rampage-performance";
    const draft = { text: "User draft", mentions: [] as string[] };
    const prepare = async () => {
      await selectGameRequestCheckout(composer, game, async () => inventory);
      draft.text += "\nBuild Rampage";
      draft.mentions.push("Game Studio context");
    };
    await expect(prepare()).rejects.toThrow(connectFirst);
    expect(draft).toEqual({ text: "User draft", mentions: [] });
    expect(composer.selection.environment).toEqual({
      type: "provider",
      environmentProviderId: "unity-rampage-slot",
      machine: { type: "existing", hostId: "host-mac" },
      inputs: { slotId: "slot-performance" },
    });
    expect(composer.patches).toEqual([{}]);
  });

  it.each(["host", "project", "lifecycle-id", "inventory-id"])(
    "rejects a checkout with an incompatible %s",
    async (mismatch) => {
      const composer = composerWith(
        unityCheckout({
          slotId: mismatch === "inventory-id" ? "inventory-checkout-id" : "slot-performance",
        }),
      );
      const { slot, inventory } = registeredCheckout();
      if (mismatch === "host") slot.lifecycle.hostId = "another-host";
      if (mismatch === "project") slot.lifecycle.projectId = "another-project";
      if (mismatch === "lifecycle-id") slot.lifecycle.id = "another-slot";
      await expect(
        selectGameRequestCheckout(composer, game, async () => inventory),
      ).rejects.toThrow(connectFirst);
      expect(composer.patches).toEqual([{}]);
    },
  );

  it("keeps ordinary game-root requests working without an editor inventory read", async () => {
    const composer = composerWith({ projectId: "another-project" });
    const result = await selectGameRequestCheckout(composer, game, async () => {
      throw new Error("Ordinary game roots do not require a registered Unity slot");
    });
    expect(result).toEqual({
      projectId: "project-rampage",
      environment: {
        type: "host",
        hostId: "host-mac",
        workspace: { type: "unmanaged", path: "/games/rampage" },
      },
    });
  });
});
