import { beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import type { Rule } from "../shared/rules.ts";
import type { Targets } from "../shared/targets.ts";

// The DOM must exist before the SDK's render harness is evaluated.
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, waitFor } = await import("@testing-library/react");

const targets: Targets = {
  hosts: [
    { id: "host_mac", name: "Build Mac" },
    { id: "host_linux", name: "linux-builder" },
  ],
  providers: [
    { id: "codex", name: "Codex" },
    { id: "claude-code", name: "Claude Code" },
  ],
  projects: [{ id: "proj_bb", name: "bb-plugins" }],
};

const browser: Rule = {
  id: "rule_a",
  name: "Browser review",
  enabled: true,
  instructions: "Open the page in bb's browser.",
  when: { hosts: ["host_mac"], providers: [], models: ["gpt-*"], projects: [] },
};

// The plugin's query cache and the rules draft are module-level. Each test starts
// from an empty cache, and its server starts past every revision seen before,
// because the draft only ever moves forward.
let queryCache: { clear(): void; invalidateQueries(): Promise<void> } | undefined;
beforeEach(() => queryCache?.clear());
let startRevision = 0;

/** A fake server: `stored` is what bb holds, and every save bumps its revision. */
async function page(
  saved: Rule[],
  {
    conflictAt,
    reply,
    fetched,
  }: { conflictAt?: number; reply?: Promise<void>; fetched?: () => Promise<void> } = {},
) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  queryCache ??= (await import("./query.ts")).queryClient;
  expect(app.settingsSections).toHaveLength(0);
  const panel = app.navPanels[0];
  if (!panel) throw new Error("app.tsx registers one navigation page");
  expect(panel.path).toBe("instructions");
  startRevision += 100;
  const server = { revision: startRevision, rules: saved };
  const saves: Rule[][] = [];
  const rpc = {
    rules: async () => {
      const stored = { ...server };
      await fetched?.();
      return stored;
    },
    targets: async () => targets,
    saveRules: async (input: unknown) => {
      const { rules, revision } = input as { rules: Rule[]; revision: number };
      if (conflictAt !== undefined && saves.length === conflictAt) {
        server.revision += 1;
        server.rules = [...server.rules, { ...browser, id: "rule_cli", name: "From the CLI" }];
      }
      saves.push(rules);
      // The server commits at once. `reply` only delays the response.
      if (revision !== server.revision) {
        const refused = { ...server, saved: false };
        await reply;
        return refused;
      }
      server.revision += 1;
      server.rules = rules;
      const stored = { ...server, saved: true };
      await reply;
      return stored;
    },
  };
  const open = async () => {
    const slot = renderSlot(panel, { subPath: "" }, { rpc });
    await slot.findByRole("button", { name: "Add rule" });
    return slot;
  };
  return { slot: await open(), open, saves, server };
}

test("a saved rule shows its scope by name", async () => {
  const { slot } = await page([browser]);
  expect(slot.getByRole("button", { name: "Scope: Build Mac · gpt-*" }).textContent).toBe(
    "Build Mac · gpt-*",
  );
  expect(
    sourceTextbox(slot.getByRole("textbox", { name: "Browser review instructions" })),
  ).toHaveProperty("value", "Open the page in bb's browser.");
  slot.unmount();
});

test("scoping a rule to a provider autosaves it", async () => {
  const { slot, saves } = await page([browser]);
  fireEvent.click(slot.getByRole("button", { name: "Scope: Build Mac · gpt-*" }));
  await act(async () => {
    fireEvent.click(slot.getByRole("button", { name: "Claude Code" }));
  });
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 });
  expect(saves[0]?.[0]?.when).toEqual({
    hosts: ["host_mac"],
    providers: ["claude-code"],
    models: ["gpt-*"],
    projects: [],
  });
  expect(slot.getByRole("status").textContent).toBe("Saved");
  slot.unmount();
});

test("a new rule applies everywhere until scoped", async () => {
  const { slot, saves } = await page([]);
  expect(slot.getByText("No rules yet. A rule with no scope applies to every agent.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Add rule" }));
  expect(slot.getByRole("button", { name: "Scope: Always" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(slot.getByRole("button", { name: "Any machine" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 });
  expect(saves[0]?.[0]).toMatchObject({
    enabled: true,
    instructions: "",
    when: {
      hosts: [],
      providers: [],
      models: [],
      projects: [],
    },
  });
  slot.unmount();
});

test("a save refused for a stale revision offers to discard or overwrite", async () => {
  const { slot, saves, server } = await page([browser], { conflictAt: 0 });
  fireEvent.change(sourceTextbox(slot.getByRole("textbox", { name: "Rule name" })), {
    target: { value: "Renamed" },
  });
  const alert = await slot.findByText("Rules changed elsewhere since this page loaded.");
  expect(alert).toBeTruthy();
  expect(server.rules.map((rule) => rule.name)).toEqual(["Browser review", "From the CLI"]);

  fireEvent.click(slot.getByRole("button", { name: "Discard my edits" }));
  expect(
    slot
      .getAllByRole("textbox", { name: "Rule name" })
      .map((input) => (input as HTMLInputElement).value),
  ).toEqual(["Browser review", "From the CLI"]);
  expect(slot.getByRole("status").textContent).toBe("Saved");
  expect(saves).toHaveLength(1);
  slot.unmount();
});

test("leaving the page saves an edit still waiting for its pause", async () => {
  const { slot, saves } = await page([browser]);
  fireEvent.change(sourceTextbox(slot.getByRole("textbox", { name: "Rule name" })), {
    target: { value: "Renamed" },
  });
  expect(slot.getByRole("status").textContent).toBe("Saving…");
  slot.unmount();
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]?.[0]?.name).toBe("Renamed");
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function names(slot: Awaited<ReturnType<typeof page>>["slot"]) {
  return slot
    .getAllByRole("textbox", { name: "Rule name" })
    .map((input) => (input as HTMLInputElement).value);
}

function rename(slot: Awaited<ReturnType<typeof page>>["slot"], name: string) {
  fireEvent.change(slot.getAllByRole("textbox", { name: "Rule name" })[0]!, {
    target: { value: name },
  });
}

test("leaving during a save still stores the edit made after it", async () => {
  const reply = deferred();
  const { slot, saves, server } = await page([browser], { reply: reply.promise });
  rename(slot, "First");
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 });
  rename(slot, "Second");
  slot.unmount();
  reply.release();
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(server.rules.map((rule) => rule.name)).toEqual(["Second"]);
});

test("a late save response does not hide rules stored after it", async () => {
  const reply = deferred();
  const { slot, saves, server } = await page([browser], { reply: reply.promise });
  rename(slot, "Mine");
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 });
  // Another writer stores a newer revision and the page refetches it before the reply lands.
  server.revision += 1;
  server.rules = [...server.rules, { ...browser, id: "rule_cli", name: "From the CLI" }];
  await act(() => queryCache!.invalidateQueries());
  reply.release();
  await waitFor(() =>
    expect(
      slot
        .getAllByRole("textbox", { name: "Rule name" })
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Mine", "From the CLI"]),
  );
  expect(slot.getByRole("status").textContent).toBe("Saved");
  slot.unmount();
});

test("a save refused after leaving the page is offered again on return", async () => {
  const { slot, open, saves, server } = await page([browser], { conflictAt: 0 });
  rename(slot, "Mine");
  slot.unmount();
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 });
  expect(server.rules.map((rule) => rule.name)).toEqual(["Browser review", "From the CLI"]);

  const again = await open();
  await again.findByText("Rules changed elsewhere since this page loaded.");
  expect(names(again)).toEqual(["Mine"]);
  fireEvent.click(again.getByRole("button", { name: "Discard my edits" }));
  expect(names(again)).toEqual(["Browser review", "From the CLI"]);
  again.unmount();
});

test("overwriting and leaving at once still stores my rules", async () => {
  const { slot, saves, server } = await page([browser], { conflictAt: 0 });
  rename(slot, "Mine");
  await slot.findByText("Rules changed elsewhere since this page loaded.");
  fireEvent.click(slot.getByRole("button", { name: "Overwrite with mine" }));
  slot.unmount();
  await waitFor(() => expect(saves).toHaveLength(2), { timeout: 2000 });
  expect(server.rules.map((rule) => rule.name)).toEqual(["Mine"]);
});

test("an edit after taking in a newer revision saves on that revision", async () => {
  const { slot, saves, server } = await page([browser]);
  rename(slot, "One");
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 });
  server.revision += 4;
  server.rules = [...server.rules, { ...browser, id: "rule_cli", name: "From the CLI" }];
  await act(() => queryCache!.invalidateQueries());
  await waitFor(() => expect(names(slot)).toEqual(["One", "From the CLI"]));
  rename(slot, "Two");
  slot.unmount();
  await waitFor(() => expect(saves).toHaveLength(2), { timeout: 2000 });
  expect(server.rules.map((rule) => rule.name)).toEqual(["Two", "From the CLI"]);
});

test("reopening never shows a fetch older than the last save", async () => {
  let gate: Promise<void> | undefined;
  const { slot, open, saves } = await page([browser], {
    fetched: () => gate ?? Promise.resolve(),
  });
  const slowFetch = deferred();
  gate = slowFetch.promise;
  // A refetch reads the stored rules, then answers only after the save below.
  void queryCache!.invalidateQueries();
  gate = undefined;
  rename(slot, "Mine");
  await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Saved"), {
    timeout: 2000,
  });
  expect(saves).toHaveLength(1);
  await act(async () => slowFetch.release());
  expect(names(slot)).toEqual(["Mine"]);
  slot.unmount();

  const again = await open();
  expect(names(again)).toEqual(["Mine"]);
  expect(again.getByRole("status").textContent).toBe("Saved");
  again.unmount();
});

// These draft/save tests explicitly exercise the optional source mode.
function sourceTextbox(element: HTMLElement): HTMLElement {
  if (!element.matches(".tiptap")) return element;
  const wrapper = element.closest(".bb-markdown-editor");
  const button = [...(wrapper?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === "Markdown source",
  );
  if (!button) throw new Error("Markdown editor has no source control");
  fireEvent.click(button);
  const source = wrapper?.querySelector<HTMLElement>("textarea[data-markdown-source]");
  if (!source) throw new Error("Source mode did not open");
  return source;
}
