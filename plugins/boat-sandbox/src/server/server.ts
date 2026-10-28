import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { boatRpcContract } from "../shared/rpc.ts";
import { readMachineResource } from "../shared/schema.ts";
import { registerCli } from "./cli.ts";
import { createBoatClient, type BoatClientFactory } from "./lib/boat-api.ts";
import { createIdlePolicy } from "./lib/idle.ts";
import { createBoatMachine } from "./lib/machine.ts";
import { resolveSettings, SETTING_DESCRIPTORS } from "./lib/settings.ts";

export interface BoatSandboxDeps {
  clientFactory: BoatClientFactory;
  now(): number;
  sleep(delayMs: number): Promise<void>;
  randomId(): string;
}

export function createBoatSandboxPlugin(deps: BoatSandboxDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    const currentSettings = async () => resolveSettings(await settings.get());
    const machine = createBoatMachine({
      clientFactory: deps.clientFactory,
      kv: bb.storage.kv,
      currentSettings,
      now: deps.now,
      sleep: deps.sleep,
      randomId: deps.randomId,
    });
    bb.onDispose(() => machine.close());

    async function inspectMachine(hostId: string) {
      const stored = await bb.experimental_machines.getResource(hostId);
      if (stored === null) throw new Error("No Boat resource is stored for this machine.");
      return machine.inspect(readMachineResource(stored));
    }

    const idle = createIdlePolicy(bb, { machine, currentSettings, now: deps.now });
    machine.register(bb, { onConnected: idle.bump });

    bb.rpc.register(boatRpcContract, {
      "account.inspect": () => machine.connectionStatus(),
      "machine.inspect": ({ hostId }) => inspectMachine(hostId),
      "launch.options": () => machine.launchOptions(),
    });
    registerCli(bb, {
      accountInspect: () => machine.connectionStatus(),
      machineInspect: inspectMachine,
      launchOptions: () => machine.launchOptions(),
    });

    const loaded = await currentSettings();
    if (!loaded.ok) bb.status.needsConfiguration(loaded.message);
  };
}

export default createBoatSandboxPlugin({
  clientFactory: (credentials) => createBoatClient(credentials),
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  randomId: () => randomUUID(),
});
