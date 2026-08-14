import type { BbPluginApi } from "@bb/plugin-sdk";
import { installDotfiles } from "./modules/dotfiles/server.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  await installDotfiles(bb);
}
