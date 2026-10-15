import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { Game } from "../shared/schema.ts";
import { slotInputs } from "../shared/slot-contract.ts";
import type { editorInventorySchema } from "../shared/unity-editor-contract.ts";

/** Keep the native Unity checkout picker authoritative when preparing a Studio request. */
export async function selectGameCheckout(
  composer: Pick<PluginComposerApi, "experimental_setSelection">,
  game: Pick<Game, "projectId" | "hostId" | "rootPath">,
) {
  const selection = await composer.experimental_setSelection({});
  if (selection.projectId === game.projectId) {
    const environment = selection.environment;
    if (!environment) return selection;
    if (
      environment.type === "provider" &&
      environment.environmentProviderId === "unity-rampage-slot"
    ) {
      if (environment.machine?.type !== "existing" || environment.machine.hostId !== game.hostId)
        throw new Error(
          "Select a Unity checkout on this project's machine before preparing a request.",
        );
      // Setting environment would reset the provider's own checkout inputs.
      return selection;
    }
  }
  return composer.experimental_setSelection({
    projectId: game.projectId,
    environment: {
      type: "host",
      hostId: game.hostId,
      workspace: { type: "unmanaged", path: game.rootPath },
    },
  });
}

/** A prepared context names one game's files, so its checkout must already be explicit. */
export async function selectGameRequestCheckout(
  composer: Pick<PluginComposerApi, "experimental_setSelection">,
  game: Pick<Game, "projectId" | "hostId" | "rootPath">,
  loadEditors: (input: { hostId: string }) => Promise<z.infer<typeof editorInventorySchema>>,
) {
  const selection = await selectGameCheckout(composer, game);
  const environment = selection.environment;
  if (!environment)
    throw new Error("Finish selecting a checkout in BB before preparing a Game Studio request.");
  if (environment.type !== "provider" || environment.environmentProviderId !== "unity-rampage-slot")
    return selection;
  const reject = () => {
    throw new Error(
      "Start a thread in the selected Unity checkout, then connect that checkout in Game Studio before preparing a request.",
    );
  };
  const inputs = slotInputs.safeParse(environment.inputs);
  if (!inputs.success || !inputs.data.slotId) return reject();
  const inventory = await loadEditors({ hostId: game.hostId });
  const slot = inventory.slots.find((entry) => entry.lifecycle?.id === inputs.data.slotId);
  if (
    inventory.hostId !== game.hostId ||
    slot?.hostId !== game.hostId ||
    slot.workspacePath !== game.rootPath ||
    slot.lifecycle?.hostId !== game.hostId ||
    slot.lifecycle.projectId !== game.projectId ||
    slot.lifecycle.workspacePath !== game.rootPath
  )
    return reject();
  return selection;
}
