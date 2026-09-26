import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { MdxOpener } from "./opener.tsx";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "mdx",
    title: "Canvas",
    extensions: ["mdx"],
    component: MdxOpener,
  });
});
