// @smsunarto/bb-plugin-monokai — backend entry.
//
// The palette itself is declarative: `bb.themes` in package.json points BB at
// themes/bb-monokai.css. The runtime owns one setting and a bounded RPC so every
// open client can apply its UI font without reloading the plugin.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { DEFAULT_UI_FONT, UI_FONT_OPTIONS, normalizeUiFont } from "./shared/ui-font.ts";

const uiFontSchema = z.enum(UI_FONT_OPTIONS);

export const uiFontRpcContract = defineRpcContract({
  getUiFont: {
    input: z.object({}).strict(),
    output: z.object({ uiFont: uiFontSchema }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    uiFont: {
      type: "select",
      label: "UI font",
      description:
        "Applies to the full bb interface on mobile and desktop. Code keeps Berkeley Mono.",
      options: [...UI_FONT_OPTIONS],
      default: DEFAULT_UI_FONT,
    },
  });
  let uiFont = normalizeUiFont((await settings.get()).uiFont);
  settings.onChange((next) => {
    uiFont = normalizeUiFont(next.uiFont);
  });
  bb.rpc.register(uiFontRpcContract, {
    getUiFont: () => ({ uiFont }),
  });
  bb.log.info("loaded — contributes the bb Monokai palette and UI font setting");
}
