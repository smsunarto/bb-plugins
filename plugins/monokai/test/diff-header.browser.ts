// Browser regression probe. Bundle this file with Bun (--target browser --format iife),
// evaluate the bundle on an empty browser page, then await runProbe().
// Checks real layout/observer behavior that the Bun unit tests cannot reproduce.
import { mountDiffHeader } from "../app/diff-header.ts";
import { mountTerminalAppearance } from "../app/terminal-appearance.ts";
(globalThis as any).runProbe = async () => {
  document.documentElement.style.setProperty("--bb-monokai-active", "1");
  document.body.innerHTML =
    '<div id="unrelated"></div><div id="thread-detail-secondary-panel"><div data-testid="git-diff-toolbar-layout"></div></div>' +
    '<div id="thread-detail-secondary-panel-p2"><div data-testid="git-diff-toolbar-layout"></div></div>' +
    '<div data-testid="secondary-panel-shelf"><div id="plain"></div></div>' +
    '<div class="bg-sidebar p-2"><div><div class="xterm"></div></div></div>';
  const panel = document.querySelector("#thread-detail-secondary-panel")!;
  const splitPanel = document.querySelector("#thread-detail-secondary-panel-p2")!;
  let reads = 0;
  let scans = 0;
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => {
    if (selector.includes("aria-expanded")) scans++;
    return query(selector);
  }) as any;
  const nativeWidth = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!.get!;
  for (let i = 0; i < 81; i++) {
    // Half the cards carry bb's sticky sentinel. The second-to-last header sits
    // in a split pane's panel. The last sits in the compact shelf without a
    // diff toolbar, so its shelf stays untagged.
    const card = document.createElement("div");
    if (i % 2 === 0) card.innerHTML = '<div class="h-0"></div>';
    const wrapper = document.createElement("div");
    wrapper.className = "rounded-lg bg-background";
    card.append(wrapper);
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
    (i === 80 ? document.querySelector("#plain")! : i === 79 ? splitPanel : panel).append(card);
  }
  const controller = new AbortController();
  const dispose = mountDiffHeader({ signal: controller.signal } as any);
  for (const [name, value] of [
    ["--terminal-font-family", "monospace"],
    ["--terminal-font-size", "12"],
    ["--terminal-line-height", "1.2"],
    ["--terminal-background", "#181818"],
  ] as const)
    document.documentElement.style.setProperty(name, value);
  const disposeTerminal = mountTerminalAppearance({ signal: controller.signal } as any);
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
    tagged: document.querySelectorAll("[data-monokai-diff-header]").length,
    shells: document.querySelectorAll("[data-monokai-diff-shell]").length,
    cards: document.querySelectorAll("[data-monokai-diff-card]").length,
    panels: [...document.querySelectorAll("[data-monokai-diff-panel]")].map((el) => el.id),
    terminalSurfaces: document.querySelectorAll("[data-monokai-terminal-surface]").length,
  };
  dispose();
  disposeTerminal();
  document.querySelectorAll = query;
  if (result.documentScans !== 0 || result.filenameReads !== 0 || result.icons !== 81)
    throw new Error(`Unrelated UI changes triggered diff work: ${JSON.stringify(result)}`);
  if (
    result.tagged !== 81 ||
    result.shells !== 81 ||
    result.cards !== 41 ||
    result.panels.join() !== "thread-detail-secondary-panel,thread-detail-secondary-panel-p2" ||
    result.terminalSurfaces !== 1
  )
    throw new Error(`Diff or terminal surfaces were not tagged: ${JSON.stringify(result)}`);
  if (document.querySelectorAll("[data-monokai-diff-kind]").length !== 0)
    throw new Error("Disposal left header icons behind");
  if (
    document.querySelectorAll(
      "[data-monokai-diff-header], [data-monokai-diff-shell], [data-monokai-diff-card], [data-monokai-diff-panel], [data-monokai-terminal-surface]",
    ).length !== 0
  )
    throw new Error("Disposal left tags behind");
  return result;
};
