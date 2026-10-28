// Loads Excalifont once per page for Excalidraw-style diagrams (Diagram).
// Mermaid measures text when it lays a diagram out, so the font has to be
// ready before the diagram renders. A slow or failed load stops waiting after
// a moment; the fallback handwriting fonts in SKETCH_FONT_FAMILY take over.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

/** The glyphs in assets/fonts/Excalifont-Regular-latin.woff2 (Excalidraw's Latin subset). */
const LATIN =
  "U+20-7E, U+A0-A3, U+A5-A6, U+A8-AB, U+AD-B1, U+B4, U+B6-B8, U+BA-FF, U+131, U+152-153, U+2BC, U+2C6, U+2DA, U+2DC, U+304, U+308, U+2013-2014, U+2018-201A, U+201C-201E, U+2020, U+2022, U+2024-2026, U+2030, U+2039-203A, U+20AC, U+2122, U+2212";
const WAIT_MS = 1500;

let loading: Promise<void> | null = null;
let settled = false;

function load(fetchFont: () => Promise<{ dataUrl: string }>): Promise<void> {
  loading ??= fetchFont()
    .then(async ({ dataUrl }) => {
      const face = new FontFace("Excalifont", `url(${dataUrl})`, { unicodeRange: LATIN, display: "block" });
      document.fonts.add(await face.load());
    })
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  return loading;
}

/** True once Excalifont is loaded, or once waiting for it stopped. */
export function useSketchFont(): boolean {
  const rpc = useRpc<typeof rpcContract>();
  const [ready, setReady] = useState(settled);
  useEffect(() => {
    if (ready) return;
    let live = true;
    const done = () => {
      if (live) setReady(true);
    };
    void load(() => rpc.call("sketch_font", {})).then(done);
    const timer = setTimeout(done, WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, ready]);
  return ready;
}
