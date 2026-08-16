import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerDotfilesApp } from "./modules/dotfiles/app.js";

export default definePluginApp((app) => {
  registerDotfilesApp(app);
});
