// Browser regression probe. Bundle this file with Bun (--target browser --format iife),
// evaluate the bundle on an empty browser page, then await runProbe().
// Checks real layout/observer behavior that the Bun unit tests cannot reproduce.
import { mountDiffHeader } from "../app/diff-header.ts";
(globalThis as any).runProbe = async () => {
  document.documentElement.style.setProperty("--bb-monokai-active", "1");
  document.body.innerHTML =
    '<div id="unrelated"></div><div id="thread-detail-secondary-panel"></div>';
  const panel = document.querySelector("#thread-detail-secondary-panel")!;
  let reads = 0;
  let scans = 0;
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => {
    if (selector.includes("aria-expanded")) scans++;
    return query(selector);
  }) as any;
  const nativeWidth = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!.get!;
  for (let i = 0; i < 80; i++) {
    const wrapper = document.createElement("div");
    wrapper.className = "bg-background";
    wrapper.innerHTML =
      '<div class="flex"><span><button aria-expanded="false">Toggle</button><span><span class="truncate" style="display:block;width:150px;overflow:hidden;white-space:nowrap">long/path/to/a/diff/file.ts</span></span></span></div>';
    const header = wrapper.firstElementChild!;
    const root: any = { return: null, stateNode: {} };
    root.stateNode.current = root;
    (header as any).__reactFiber$probe = {
      return: root,
      memoizedProps: { model: { path: "a.ts", label: "a.ts", changeKind: "modified" } },
    };
    (header as any).__reactProps$probe = (header as any).__reactFiber$probe.memoizedProps;
    const name = wrapper.querySelector(".truncate")!;
    Object.defineProperty(name, "scrollWidth", {
      get() {
        reads++;
        return nativeWidth.call(this);
      },
    });
    panel.append(wrapper);
  }
  const controller = new AbortController();
  const dispose = mountDiffHeader({ signal: controller.signal } as any);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await frame();
  await frame();
  reads = 0;
  scans = 0;
  const start = performance.now();
  for (let i = 0; i < 20; i++) {
    document.querySelector("#unrelated")!.textContent = String(i);
    await frame();
  }
  const result = {
    unrelatedMutations: 20,
    filenameReads: reads,
    documentScans: scans,
    elapsedMs: performance.now() - start,
    icons: document.querySelectorAll("[data-monokai-diff-kind]").length,
  };
  dispose();
  document.querySelectorAll = query;
  if (result.documentScans !== 0 || result.filenameReads !== 0 || result.icons !== 80)
    throw new Error(`Unrelated UI changes triggered diff work: ${JSON.stringify(result)}`);
  if (document.querySelectorAll("[data-monokai-diff-kind]").length !== 0)
    throw new Error("Disposal left header icons behind");
  return result;
};
