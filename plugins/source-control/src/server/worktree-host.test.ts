import { expect, test } from "vitest";
import { pickSource, worktreeSource } from "./worktree-host.ts";

const source = (hostId: string, isDefault = false) => ({
  createdAt: 1,
  hostId,
  id: `src_${hostId}`,
  isDefault,
  path: `/git/${hostId}`,
  projectId: "proj_1",
  type: "local_path" as const,
  updatedAt: 1,
});
const sources = [source("host_grok", true), source("host_dev"), source("host_mac")];
const hosts = [
  { id: "host_grok", name: "Grok box" },
  { id: "host_dev", name: "Dev PC" },
];

test("an empty setting keeps the project's default source", () => {
  expect(pickSource(sources, "", hosts)?.hostId).toBe("host_grok");
});

test("the setting picks the source on that machine, by ID or by name in any case", () => {
  expect(pickSource(sources, "host_dev", [])?.hostId).toBe("host_dev");
  expect(pickSource(sources, "dev pc", hosts)?.hostId).toBe("host_dev");
});

test("a project with no source on that machine falls back to its default", () => {
  expect(pickSource([source("host_mac"), source("host_grok", true)], "Dev PC", hosts)?.hostId).toBe(
    "host_grok",
  );
  expect(pickSource(sources, "Nowhere", hosts)?.hostId).toBe("host_grok");
});

test("machines are listed only for a name, and a failed list or setting read falls back", async () => {
  let listed = 0;
  const bb = (list: () => Promise<typeof hosts>) =>
    ({
      sdk: {
        hosts: {
          list: () => {
            listed++;
            return list();
          },
        },
      },
    }) as never;
  const project = { sources } as never;
  const ok = bb(async () => hosts);
  expect((await worktreeSource(ok, project, async () => "host_dev"))?.hostId).toBe("host_dev");
  expect(listed).toBe(0);
  expect((await worktreeSource(ok, project, async () => "Dev PC"))?.hostId).toBe("host_dev");
  expect(listed).toBe(1);
  const failing = bb(() => Promise.reject(new Error("offline")));
  expect((await worktreeSource(failing, project, async () => "Dev PC"))?.hostId).toBe("host_grok");
  expect(
    (await worktreeSource(ok, project, () => Promise.reject(new Error("no settings"))))?.hostId,
  ).toBe("host_grok");
});
