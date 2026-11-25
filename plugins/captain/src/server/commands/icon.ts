import { cliCommand } from "@get-bb/plugin-sdk";
import { normalizeIconName, type CaptainIcon } from "../../contract/icon.ts";
import { actingFor } from "../caller.ts";
import { dataUrlBytes, setCaptainIcon } from "../icon.ts";
import { guard, Refusal, render, type Item } from "../output.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

const VALUE = {
  name: "icon",
  description:
    "A name from bb's icon set, such as Star or ai-brain-01. Set a picture in Captain settings",
} as const;

/** bb publishes no list of its icon names to plugins, so a name is stored unchecked. */
const UNCHECKED_NAME_NOTE =
  "note: the name was not checked against bb's icon set; a name bb lacks shows the default Captain icon. Captain settings checks a name before it saves it";

/** Looks like a file, not a name: a separator, a leading dot, or a file extension. */
const PATH_LIKE = /[/\\]|^\.|\.[A-Za-z0-9]{2,5}$/u;

/**
 * `bb captain icon <name>`, `--clear`, or no argument to show the icon. A
 * picture is set only in Captain settings, which re-encodes it in the browser.
 */
export function iconCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Set the Captain's sidebar icon to a bb icon name; --clear restores the default",
    positionals: [VALUE],
    options: {
      clear: { type: "boolean", description: "Go back to the default Captain icon" },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain icon", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
        });
        const value = input.positionals.icon?.trim() ?? "";
        if (value !== "" && input.options.clear === true) {
          throw new Refusal([
            { reason: "an icon and --clear were both given", fix: "pass one of them" },
          ]);
        }
        if (input.options.clear === true) {
          const icon = setCaptainIcon(deps, captain.threadId, null);
          return render([iconItem(captain.threadId, "cleared", icon)], json);
        }
        if (value === "") {
          const icon = deps.store.captainIcon(captain.threadId);
          return render([iconItem(captain.threadId, "current", icon)], json);
        }
        const name = iconName(value);
        const icon = setCaptainIcon(deps, captain.threadId, { kind: "icon", name });
        return render([iconItem(captain.threadId, "set", icon)], json, [UNCHECKED_NAME_NOTE]);
      });
    },
  });
}

function iconName(value: string): string {
  if (PATH_LIKE.test(value)) {
    throw new Refusal([
      {
        reason: `${JSON.stringify(value)} looks like a file; the CLI sets icon names only`,
        fix: "upload the picture in Captain settings (Captain icons), or pass a bb icon name such as Star",
      },
    ]);
  }
  const name = normalizeIconName(value);
  if (name !== null) return name;
  throw new Refusal([
    {
      reason: `${JSON.stringify(value)} is not an icon name`,
      fix: "pass a bb icon name such as Star",
    },
  ]);
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
