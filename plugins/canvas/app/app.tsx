import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CanvasOpener } from "./canvas.tsx";
import { CanvasPage } from "./page.tsx";
import { PANEL_PATH } from "./route.ts";
import "./app.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "canvas",
    title: "Canvas",
    icon: "Layout",
    path: PANEL_PATH,
    component: CanvasPage,
  });
  app.slots.fileOpener({
    id: "canvas",
    title: "Canvas",
    extensions: ["mdx"],
    component: CanvasOpener,
  });
});
