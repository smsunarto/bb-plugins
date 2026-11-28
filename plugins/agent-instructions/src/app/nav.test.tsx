import { installDom } from "@bb-plugins/testing";
import { afterEach, expect, test } from "bun:test";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { Names } from "./nav.ts";

// nav.ts reaches the editors' Radix components, which bind their layout effect
// to a no-op when no DOM exists at load and keep it for every later test file.
installDom();
const { pageTrail } = await import("./nav.ts");
const { act, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { queryClient } = await import("./query.ts");

const names: Names = {
  doc: (id) => (id === "imported:shared" ? "Shared" : undefined),
  rule: (id) => (id === "rule_git" ? "Git via Codex" : undefined),
  project: (id) => (id === "proj_web" ? "Web app" : undefined),
  plugin: (id) => (id === "genui" ? "GenUI" : undefined),
};

test.each([
  ["", [{ label: "Global" }]],
  ["global", [{ label: "Global" }]],
  ["projects", [{ label: "Projects" }]],
  ["prompts", [{ label: "Plugin prompts" }]],
  ["global/docs/imported%3Ashared", [{ label: "Global", subPath: "global" }, { label: "Shared" }]],
  ["global/skills/dev/SKILL.md", [{ label: "Global", subPath: "global" }, { label: "dev" }]],
  [
    "global/skills/dev/references/a.md",
    [
      { label: "Global", subPath: "global" },
      { label: "dev", subPath: "global/skills/dev/SKILL.md" },
      { label: "references/a.md" },
    ],
  ],
  ["global/rules", [{ label: "Global", subPath: "global" }, { label: "Rules" }]],
  [
    "global/rules/rule_git",
    [
      { label: "Global", subPath: "global" },
      { label: "Rules", subPath: "global/rules" },
      { label: "Git via Codex" },
    ],
  ],
  [
    "projects/proj_web/src_mac/.agents/skills/x/SKILL.md",
    [
      { label: "Projects", subPath: "projects" },
      { label: "Web app", subPath: "projects/proj_web/src_mac" },
      { label: ".agents/skills/x/SKILL.md" },
    ],
  ],
  [
    "prompts/genui/file/instructions/tools/check_ui.md",
    [{ label: "Plugin prompts", subPath: "prompts" }, { label: "GenUI" }, { label: "check_ui.md" }],
  ],
  [
    "prompts/other/tool/run",
    [{ label: "Plugin prompts", subPath: "prompts" }, { label: "other" }, { label: "run" }],
  ],
])("the title bar trail for %p links each level back up", (subPath, trail) => {
  expect(pageTrail(subPath, names)).toEqual(trail);
});

test("an unloaded doc falls back to its decoded id", () => {
  expect(pageTrail("global/docs/doc%5Fnew", names).at(-1)).toEqual({ label: "doc_new" });
});

async function panel() {
  const app = await loadPluginApp(() => import("./app.tsx"));
  return app.navPanels[0]!;
}

test("the title hook names a doc from the catalog the page already loaded", async () => {
  queryClient.setQueryData(["catalog"], {
    docs: [{ id: "doc_shared", name: "Shared" }],
  });
  const usePageTitle = (await panel()).experimental_usePageTitle!;
  function Probe(props: PluginNavPanelProps) {
    const title = usePageTitle(props);
    return <output>{title?.breadcrumbs?.at(-1)?.label}</output>;
  }
  const cache = queryClient.getQueryCache();
  const realSubscribe = cache.subscribe.bind(cache);
  let subscribeCalls = 0;
  cache.subscribe = ((listener: Parameters<typeof cache.subscribe>[0]) => {
    subscribeCalls++;
    return realSubscribe(listener);
  }) as typeof cache.subscribe;
  try {
    const probe = render(<Probe subPath="global/docs/doc_shared" />);
    expect(probe.container.textContent).toBe("Shared");
    const afterMount = subscribeCalls;
    probe.rerender(<Probe subPath="global/docs/doc_other" />);
    probe.rerender(<Probe subPath="global/docs/doc_shared" />);
    // Memoized subscribe callback avoids unsubscribing and re-subscribing on every render.
    expect(subscribeCalls).toBe(afterMount);
    probe.unmount();
  } finally {
    cache.subscribe = realSubscribe;
    queryClient.clear();
  }
});

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

/** A viewport `width` px wide, as bb's compact query sees it. */
function viewport(width: number) {
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 767px)" && width <= 767,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const rpc = {
  catalog: () => ({
    revision: 1,
    sourcePath: "/data/plugins/agent-instructions/source",
    conflicts: [],
    docs: [],
    skills: [],
    deleted: [],
    published: null,
  }),
  catalogShadows: () => ({ checked: true, shadows: [] }),
  documentSources: () => ({ globalProjectId: null, projects: [] }),
  plugins: () => ({ plugins: [] }),
};

async function sidebarSlot(subPath: string) {
  const sidebar = (await panel()).experimental_sidebar as ComponentType<PluginNavPanelProps>;
  return renderSlot({ component: sidebar }, { subPath }, { rpc: rpc as never });
}

function clickTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0 });
  act(() => {
    tab.focus();
  });
  fireEvent.mouseUp(tab, { button: 0 });
  fireEvent.click(tab);
}

function pressEnter(tab: HTMLElement) {
  fireEvent.keyDown(tab, { key: "Enter" });
  fireEvent.click(tab);
}

test("the sidebar switcher renders one tablist whose active tab follows the route and navigates once per click", async () => {
  const global = await sidebarSlot("global");
  const tablist = global.getByRole("tablist", { name: "Instruction editors" });
  expect(global.queryByRole("tabpanel")).toBeNull();
  expect(
    within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Global", "Projects", "Plugin prompts"]);
  const globalTab = within(tablist).getByRole("tab", { name: "Global" });
  const projectsTab = within(tablist).getByRole("tab", { name: "Projects" });
  const promptsTab = within(tablist).getByRole("tab", { name: "Plugin prompts" });
  expect(globalTab.getAttribute("aria-selected")).toBe("true");
  expect(projectsTab.getAttribute("aria-selected")).toBe("false");
  expect(promptsTab.getAttribute("aria-selected")).toBe("false");

  // A full mouse click (mouseDown + focus + mouseUp + click) pushes exactly one navigation.
  clickTab(projectsTab);
  expect(global.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "instructions",
      options: { subPath: "projects" },
    },
  ]);
  global.unmount();

  const projects = await sidebarSlot("projects");
  expect(projects.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(projects.getByRole("tab", { name: "Global" }).getAttribute("aria-selected")).toBe("false");
  clickTab(projects.getByRole("tab", { name: "Global" }));
  expect(projects.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "instructions",
      options: { subPath: "global" },
    },
  ]);
  projects.unmount();
});

test("arrow keys move roving focus without navigating until Enter activates the tab once", async () => {
  const slot = await sidebarSlot("global");
  const globalTab = slot.getByRole("tab", { name: "Global" });
  const projectsTab = slot.getByRole("tab", { name: "Projects" });

  act(() => {
    globalTab.focus();
  });
  fireEvent.keyDown(globalTab, { key: "ArrowRight" });
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Projects"));
  expect(projectsTab.getAttribute("tabindex")).toBe("0");
  expect(globalTab.getAttribute("tabindex")).toBe("-1");
  expect(slot.navigateCalls).toHaveLength(0);

  pressEnter(projectsTab);
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "instructions",
      options: { subPath: "projects" },
    },
  ]);
  slot.unmount();
});

test("activating the already-active tab navigates back to its section root", async () => {
  const slot = await sidebarSlot("global/rules");
  const globalTab = slot.getByRole("tab", { name: "Global" });
  expect(globalTab.getAttribute("aria-selected")).toBe("true");

  clickTab(globalTab);
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "instructions",
      options: { subPath: "global" },
    },
  ]);

  pressEnter(globalTab);
  expect(slot.navigateCalls).toHaveLength(2);
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel",
    path: "instructions",
    options: { subPath: "global" },
  });
  slot.unmount();
});

test("a phone's editor root lists the editors and the catalog in the page", async () => {
  viewport(390);
  const slot = renderSlot(await panel(), { subPath: "global" }, { rpc: rpc as never });
  expect(slot.getByRole("tablist", { name: "Instruction editors" })).toBeTruthy();
  await slot.findByRole("navigation", { name: "Catalog" });
  expect(slot.queryByText("Instructions and skills for every agent")).toBeNull();
  slot.unmount();
});

test("at 768px the root keeps the desktop overview", async () => {
  viewport(768);
  const slot = renderSlot(await panel(), { subPath: "global" }, { rpc: rpc as never });
  await slot.findByText("Instructions and skills for every agent");
  expect(slot.queryByRole("tablist", { name: "Instruction editors" })).toBeNull();
  slot.unmount();
});

test("a phone's open item has a back bar that returns to its editor", async () => {
  viewport(390);
  const slot = renderSlot(
    await panel(),
    { subPath: "global/skills/dev/SKILL.md" },
    {
      rpc: {
        ...rpc,
        catalogFile: () => ({
          content: "Body\n",
          sha256: "a".repeat(64),
          size: 5,
          executable: false,
        }),
      } as never,
    },
  );
  expect(slot.getByRole("navigation", { name: "Instruction location" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Back to Global" }));
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel",
    path: "instructions",
    options: { subPath: "global" },
  });
  slot.unmount();
});

test("the desktop item page has no back bar", async () => {
  viewport(1280);
  const slot = renderSlot(await panel(), { subPath: "global/rules" }, { rpc: rpc as never });
  expect(slot.queryByRole("navigation", { name: "Instruction location" })).toBeNull();
  slot.unmount();
});

test.each([
  ["global/rules/rule_git", "Back to Global"],
  ["global/skills/dev/references/a.md", "Back to Global"],
])("a phone's back bar on %p returns to the list", async (subPath, back) => {
  viewport(390);
  const slot = renderSlot(await panel(), { subPath }, { rpc: rpc as never });
  expect(slot.getByRole("button", { name: back })).toBeTruthy();
  slot.unmount();
});
