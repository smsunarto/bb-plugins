import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createService } from "./lib/service.ts";
import { status } from "./command/status.ts";
import { wake } from "./command/wake.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const gcp = createService(bb);
  bb.cli.register(
    defineCli({
      name: "gcp-machine",
      summary: "CLI for the gcp-machine plugin",
      commands: { status: status(gcp), wake: wake(gcp) },
    }),
  );
  await gcp.register();
}
