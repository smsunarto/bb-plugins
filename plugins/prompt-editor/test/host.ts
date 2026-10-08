import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { InstalledPlugin } from "../src/server/lib/agent-text.ts";
import plugin from "../src/server/server.ts";

/** The real plugin on a fake host whose bb lists `installed`. */
export async function host(
  installed: InstalledPlugin[],
  reload: (args: { pluginId?: string }) => Promise<unknown> = async () => ({
    ok: true,
    plugins: [],
  }),
) {
  const reloads: Array<string | undefined> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "prompt-editor",
    sdk: {
      plugins: {
        list: async () => ({ plugins: installed }),
        reload: async (args?: { pluginId?: string }) => {
          reloads.push(args?.pluginId);
          return reload(args ?? {});
        },
      },
    } as never,
  });
  await plugin(bb);
  return { call: harness.behavior.callRpc.bind(harness.behavior), reloads };
}
