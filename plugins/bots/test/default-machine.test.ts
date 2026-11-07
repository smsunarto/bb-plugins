import { afterEach, describe, expect, it } from "vitest";
import { backend } from "./backend-fixture";
import { matchDefaultMachine } from "../lib/default-machine";

const hosts = [
  { id: "host-home", name: "Execution machine" },
  { id: "host-dev", name: "Dev PC" },
];

describe("matchDefaultMachine", () => {
  it("matches an ID, then a case-insensitive name, and nothing when empty or unknown", () => {
    expect(matchDefaultMachine(hosts, "host-dev")?.id).toBe("host-dev");
    expect(matchDefaultMachine(hosts, "  dev pc ")?.id).toBe("host-dev");
    expect(matchDefaultMachine(hosts, "")).toBeNull();
    expect(matchDefaultMachine(hosts, undefined)).toBeNull();
    expect(matchDefaultMachine(hosts, "Laptop")).toBeNull();
  });
});

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function setup(defaultMachine: string) {
  const host = await backend();
  instances.push(host);
  host.harness.inspection.sdk.stub("hosts.list", async () =>
    hosts.map((entry) => ({ ...entry, status: "connected" as const })),
  );
  await host.harness.behavior.setSettings({ defaultMachine });
  return host;
}

describe("Default machine setting", () => {
  it("places bots made with bb bots create on the configured machine", async () => {
    const host = await setup("Dev PC");
    const result = await host.harness.behavior.runCli(["create", "--name", "Quill", "--json"]);
    expect(result.exitCode).toBe(0);
    const { id } = JSON.parse(result.stdout!) as { id: string };
    expect(host.store.require(id).hostId).toBe("host-dev");
  });

  it("reports the configured machine to the editor, and warns when it matches none", async () => {
    const host = await setup("Dev PC");
    const list = (await host.harness.behavior.callRpc("bots_list", {})) as {
      defaultHostId: string | null;
      warnings: string[];
    };
    expect(list.defaultHostId).toBe("host-dev");
    await host.harness.behavior.setSettings({ defaultMachine: "Laptop" });
    const unmatched = (await host.harness.behavior.callRpc("bots_list", {})) as typeof list;
    expect(unmatched.defaultHostId).toBeNull();
    expect(unmatched.warnings.join("\n")).toMatch(/Default machine "Laptop" matches no/);
  });
});
