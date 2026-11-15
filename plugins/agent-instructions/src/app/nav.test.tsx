import { installDom } from "@bb-plugins/testing";
import { afterEach, expect, test } from "bun:test";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { pageTrail, type Names } from "./nav.ts";

installDom();
const { fireEvent, render } = await import("@testing-library/react");
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
  const probe = render(<Probe subPath="global/docs/doc_shared" />);
  expect(probe.container.textContent).toBe("Shared");
  probe.unmount();
  queryClient.clear();
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
    docs: [],
    skills: [],
    deleted: [],
    published: null,
  }),
  catalogShadows: () => ({ checked: true, shadows: [] }),
};

test("a phone's editor root lists the editors and the catalog in the page", async () => {
  viewport(390);
  const slot = renderSlot(await panel(), { subPath: "global" }, { rpc: rpc as never });
  expect(slot.getByRole("navigation", { name: "Instruction editors" })).toBeTruthy();
  await slot.findByRole("navigation", { name: "Catalog" });
  expect(slot.queryByText("Instructions and skills for every agent")).toBeNull();
  slot.unmount();
});

test("at 768px the root keeps the desktop overview", async () => {
  viewport(768);
  const slot = renderSlot(await panel(), { subPath: "global" }, { rpc: rpc as never });
  await slot.findByText("Instructions and skills for every agent");
  expect(slot.queryByRole("navigation", { name: "Instruction editors" })).toBeNull();
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
