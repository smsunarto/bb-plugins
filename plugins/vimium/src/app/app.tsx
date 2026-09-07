import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountLinkHints } from "./link-hints.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "link-hints",
    mount: mountLinkHints,
  });
});
