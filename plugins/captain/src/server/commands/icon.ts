import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import { normalizeIconName, type CaptainIcon, type IconChoice } from "../../contract/icon.ts";
import { callerCaptain, readCallerBytes } from "../caller.ts";
import { dataUrlBytes, IconImageError, imageDataUrl, setCaptainIcon } from "../icon.ts";
import { guard, Refusal, render, type Item } from "../output.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

const VALUE = {
  name: "icon",
  description:
    "A name from bb's icon set such as Star or ai-brain-01, or the path of a PNG, JPEG, GIF, WebP or SVG image on this machine",
} as const;

/** bb publishes no list of its icon names, so a name is stored as typed. */
const UNKNOWN_NAME_NOTE =
  "note: a name bb's icon set lacks shows the default Captain icon; Captain settings previews a name as you type it";

/** A path, not an icon name: it has a separator, starts with a dot, or ends in a file extension. */
const PATH_LIKE = /[/\\]|^\.|\.[A-Za-z0-9]{2,5}$/u;

export function iconCommand(deps: CommandDeps) {
  return cliCommand({
    summary:
      "Set the Captain's sidebar icon to a bb icon or an image; --clear restores the default",
    positionals: [VALUE],
    options: {
      clear: { type: "boolean", description: "Go back to the default Captain icon" },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain icon", json, async () => {
        const captain = await callerCaptain(deps.bb, deps.registry, ctx, {
          captain: input.options.captain,
        });
        const value = input.positionals.icon?.trim();
        if (value !== undefined && value !== "" && input.options.clear === true) {
          throw new Refusal([
            { reason: "an icon and --clear were both given", fix: "pass one of them" },
          ]);
        }
        if (input.options.clear === true) {
          return render(
            [iconItem(captain.threadId, "cleared", setCaptainIcon(deps, captain.threadId, null))],
            json,
          );
        }
        if (value === undefined || value === "") {
          return render(
            [iconItem(captain.threadId, "current", deps.store.captainIcon(captain.threadId))],
            json,
          );
        }
        const choice = await choiceFor(deps, ctx, value);
        return render(
          [iconItem(captain.threadId, "set", setCaptainIcon(deps, captain.threadId, choice))],
          json,
          choice?.kind === "icon" ? [UNKNOWN_NAME_NOTE] : [],
        );
      });
    },
  });
}

async function choiceFor(
  deps: CommandDeps,
  ctx: PluginCliContext,
  value: string,
): Promise<IconChoice> {
  if (!PATH_LIKE.test(value)) {
    const name = normalizeIconName(value);
    if (name === null) {
      throw new Refusal([
        {
          reason: `${JSON.stringify(value)} is not an icon name`,
          fix: "pass a bb icon name such as Star, or an image path such as ./icon.png",
        },
      ]);
    }
    return { kind: "icon", name };
  }
  const file = await readCallerBytes(deps.bb, ctx, value);
  try {
    return { kind: "image", src: imageDataUrl(file.bytes) };
  } catch (error) {
    if (!(error instanceof IconImageError)) throw error;
    throw new Refusal([
      {
        reason: `${file.path}: ${error.message}`,
        fix: "pass a smaller PNG, JPEG, GIF, WebP or SVG",
      },
    ]);
  }
}

function iconItem(threadId: string, state: string, icon: CaptainIcon): Item {
  const bytes = icon.kind === "image" ? dataUrlBytes(icon.src).length : 0;
  const detail =
    icon.kind === "default"
      ? "default"
      : icon.kind === "icon"
        ? `icon ${icon.name}`
        : `image ${Math.ceil(bytes / 1024)} KB`;
  const data: Item["data"] =
    icon.kind === "image"
      ? { icon: { kind: "image", bytes } }
      : icon.kind === "icon"
        ? { icon: { kind: "icon", name: icon.name } }
        : { icon: { kind: "default" } };
  return { id: threadId, ok: true, state, detail, data };
}
