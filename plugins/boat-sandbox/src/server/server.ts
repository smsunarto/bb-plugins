import { randomUUID } from "node:crypto";
import { makePluginRuntime } from "@bb-plugins/effect-bridge";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Clock, Effect, Layer } from "effect";
import { boatRpcContract } from "../shared/rpc.ts";
import { readMachineResource } from "../shared/schema.ts";
import { registerCli } from "./cli.ts";
import { createBoatClient, type BoatClientFactory } from "./lib/boat-api.ts";
import { call } from "./lib/call.ts";
import { IdlePolicy, registerIdlePolicy } from "./lib/idle.ts";
import { BoatMachine, registerBoatMachine } from "./lib/machine.ts";
import { resolveSettings, SETTING_DESCRIPTORS } from "./lib/settings.ts";

export interface BoatSandboxDeps {
  clientFactory: BoatClientFactory;
  randomId(): string;
  /** Replaces Effect's clock, for tests that move time themselves. */
  clock?: Clock.Clock;
}

export function createBoatSandboxPlugin(deps: BoatSandboxDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    const currentSettings = async () => resolveSettings(await settings.get());
    const services = IdlePolicy.layer(bb, currentSettings).pipe(
      Layer.provideMerge(
        BoatMachine.layer({
          clientFactory: deps.clientFactory,
          kv: bb.storage.kv,
          currentSettings,
          randomId: deps.randomId,
        }),
      ),
    );
    const runtime = await makePluginRuntime(
      bb,
      deps.clock === undefined
        ? services
        : services.pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, deps.clock))),
    );
    const [machine, idle] = await runtime.run(Effect.all([BoatMachine, IdlePolicy]));
    registerBoatMachine(bb, {
      machine,
      run: runtime.run,
      randomId: deps.randomId,
      currentSettings,
      onConnected: idle.bump,
    });
    registerIdlePolicy(bb, idle, runtime.run);

    const inspectMachine = Effect.fnUntraced(function* (hostId: string) {
      const stored = yield* call(() => bb.experimental_machines.getResource(hostId));
      if (stored === null) {
        return yield* Effect.fail(new Error("No Boat resource is stored for this machine."));
      }
      return yield* machine.inspect(readMachineResource(stored));
    });

    bb.rpc.register(boatRpcContract, {
      "account.inspect": () => runtime.run(machine.connectionStatus),
      "machine.inspect": ({ hostId }) => runtime.run(inspectMachine(hostId)),
      "launch.options": () => runtime.run(machine.launchOptions),
    });
    registerCli(bb, {
      accountInspect: (signal) => runtime.run(machine.connectionStatus, signal),
      machineInspect: (hostId, signal) => runtime.run(inspectMachine(hostId), signal),
      launchOptions: (signal) => runtime.run(machine.launchOptions, signal),
    });

    const loaded = await currentSettings();
    if (!loaded.ok) bb.status.needsConfiguration(loaded.message);
  };
}

export default createBoatSandboxPlugin({
  clientFactory: (credentials) => createBoatClient(credentials),
  randomId: () => randomUUID(),
});
