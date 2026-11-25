import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const DEVICE_PIXEL = "--monokai-device-pixel";

/** A resolution query is repinned after a zoom or a move to another display. */
export function mountHairlineDensity({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  const view = doc.defaultView;
  if (signal.aborted || !view) return;
  const root = doc.documentElement;
  let query: MediaQueryList | undefined;

  const update = () => {
    query?.removeEventListener("change", update);
    const scale = view.devicePixelRatio;
    root.style.setProperty(DEVICE_PIXEL, `${1 / scale}px`);
    query = view.matchMedia(`(resolution: ${scale}dppx)`);
    query.addEventListener("change", update);
  };
  const dispose = () => {
    query?.removeEventListener("change", update);
    root.style.removeProperty(DEVICE_PIXEL);
    signal.removeEventListener("abort", dispose);
  };

  update();
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
