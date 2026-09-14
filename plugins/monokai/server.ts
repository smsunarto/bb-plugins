// @smsunarto/bb-plugin-monokai — backend entry.
//
// The palette itself is declarative: `bb.themes` in package.json points BB at
// themes/bb-monokai.css. The runtime owns one setting; every open client reads
// it through the SDK's push-updated settings hook.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { DEFAULT_UI_FONT, UI_FONT_OPTIONS } from "./shared/ui-font.ts";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    uiFont: {
      type: "select",
      label: "UI font",
      description:
        "Applies to the full bb interface on mobile and desktop. Code keeps Berkeley Mono.",
      options: [...UI_FONT_OPTIONS],
      default: DEFAULT_UI_FONT,
    },
  });
  bb.log.info("loaded — contributes the bb Monokai palette and UI font setting");
}
