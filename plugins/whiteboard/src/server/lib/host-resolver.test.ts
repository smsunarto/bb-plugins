import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
import { NO_HOST_MESSAGE, createHostResolver } from "./host-resolver.ts";
import { migrate } from "./migrations.ts";
import { runWithThread } from "./thread-context.ts";

type HostRow = { id: string; name: string; type: string; status: string };

/** A fake bb with the plugin tables, one registered repository and stubbed thread/host lookups. */
function setup(options: { hosts?: HostRow[]; threadEnvironment?: Record<string, string> } = {}) {
  const lookups: string[] = [];
  const { bb } = createFakePluginHost({
    pluginId: "whiteboard",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          lookups.push(`threads.get ${threadId}`);
          const environmentId = options.threadEnvironment?.[threadId];
          return { id: threadId, environmentId: environmentId ?? null };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          lookups.push(`environments.get ${environmentId}`);
          return { id: environmentId, hostId: `host-of-${environmentId}` };
        },
      },
      hosts: { list: async () => options.hosts ?? [] },
    } as never,
  });
  migrate(bb);
  const db = bb.storage.database();
  // WP7 owns the `repositories` DDL; this is the shape the resolver joins on.
  db.exec(
    "CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO repositories VALUES (?, ?, ?)").run("repo-1", "/work/app", "app");
  db.prepare("INSERT INTO repositories VALUES (?, ?, ?)").run("repo-2", "/work/app/nested", "n");
  return { bb, resolver: createHostResolver(bb), lookups };
}

const connected = (id: string, name = id): HostRow => ({
  id,
  name,
  type: "persistent",
  status: "connected",
});

describe("hostFor", () => {
  it("step 1: the repository_hosts row wins over the thread and the single host", async () => {
    const { resolver } = setup({ hosts: [connected("solo")], threadEnvironment: { t1: "env" } });
    await resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "laptop");
    await runWithThread({ threadId: "t1" }, async () => {
      expect(await resolver.hostFor({ repositoryId: "repo-1" })).toBe("laptop");
      expect(await resolver.hostFor({ rootPath: "/work/app" })).toBe("laptop");
      // A path inside a registered repository belongs to its host.
      expect(await resolver.hostFor({ rootPath: "/work/app/src/deep" })).toBe("laptop");
    });
  });

  it("step 1: the longest registered repository path, then remembered paths", async () => {
    const { resolver } = setup({ hosts: [connected("solo")] });
    await resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "laptop");
    await resolver.bindRepository({ repositoryId: "repo-2", rootPath: "/work/app/nested" }, "box");
    expect(await resolver.hostFor({ rootPath: "/work/app/nested/x" })).toBe("box");
    expect(await resolver.hostFor({ rootPath: "/elsewhere/checkout" })).toBe("solo");
    resolver.rememberPath("/elsewhere", "remote");
    expect(await resolver.hostFor({ rootPath: "/elsewhere/checkout" })).toBe("remote");
    expect(await resolver.hostFor({ rootPath: "/elsewhere-not" })).toBe("solo");
  });

  it("step 2: the thread's environment host, looked up once per thread context", async () => {
    const { resolver, lookups } = setup({
      hosts: [connected("solo")],
      threadEnvironment: { t1: "env-1" },
    });
    await runWithThread({ threadId: "t1" }, async () => {
      expect(await resolver.hostFor({ rootPath: "/unbound" })).toBe("host-of-env-1");
      expect(await resolver.hostFor({ repositoryId: "repo-1" })).toBe("host-of-env-1");
    });
    expect(lookups).toEqual(["threads.get t1", "environments.get env-1"]);
  });

  it("step 3: the single connected persistent host when the thread has no environment", async () => {
    const { resolver } = setup({
      hosts: [
        connected("solo"),
        { id: "cloud", name: "cloud", type: "ephemeral", status: "connected" },
        { id: "off", name: "off", type: "persistent", status: "disconnected" },
      ],
    });
    await runWithThread({ threadId: "no-env" }, async () => {
      expect(await resolver.hostFor({ rootPath: "/unbound" })).toBe("solo");
    });
    expect(await resolver.hostFor({})).toBe("solo");
  });

  it("step 4: no answer is a 409 ReviewInputError", async () => {
    const { resolver } = setup({ hosts: [connected("a"), connected("b")] });
    const error = await resolver.hostFor({ rootPath: "/unbound" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewInputError);
    expect(error).toMatchObject({ message: NO_HOST_MESSAGE, status: 409 });
    expect(NO_HOST_MESSAGE).toBe(
      "Whiteboard cannot tell which bb host has this checkout. Run the tool from a thread in that project.",
    );
    await expect(resolver.callerHost()).rejects.toMatchObject({ status: 409 });
  });

  it("callerHost ignores repository bindings", async () => {
    const { resolver } = setup({ hosts: [connected("solo")] });
    await resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "laptop");
    expect(await resolver.callerHost()).toBe("solo");
  });
});

describe("bindRepository", () => {
  it("is idempotent for the same host and rejects a second host for a bound path", async () => {
    const { bb, resolver } = setup({ hosts: [connected("laptop", "Scott's Laptop")] });
    await resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "laptop");
    await resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "laptop");
    const byId = await resolver
      .bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "devbox")
      .catch((e: unknown) => e);
    expect(byId).toBeInstanceOf(ReviewInputError);
    expect(byId).toMatchObject({
      status: 409,
      message:
        "/work/app is already registered from another bb host (Scott's Laptop). Whiteboard keys checkouts by path, so one path can belong to one host.",
    });
    // The same path under another repository id is still the bound path.
    await expect(
      resolver.bindRepository({ repositoryId: "repo-3", rootPath: "/work/app/" }, "devbox"),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      bb.storage
        .database()
        .prepare("SELECT repository_id, host_id FROM repository_hosts ORDER BY repository_id")
        .all(),
    ).toEqual([{ repository_id: "repo-1", host_id: "laptop" }]);
  });

  it("names an unknown host by its id", async () => {
    const { resolver } = setup();
    await resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "gone");
    await expect(
      resolver.bindRepository({ repositoryId: "repo-1", rootPath: "/work/app" }, "other"),
    ).rejects.toThrow("/work/app is already registered from another bb host (gone).");
  });
});
