import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CanvasOpener } from "./canvas.tsx";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "canvas",
    title: "Canvas",
    extensions: ["mdx"],
    component: CanvasOpener,
  });
});
