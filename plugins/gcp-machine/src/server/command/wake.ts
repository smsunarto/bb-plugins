import { cliCommand } from "@get-bb/plugin-sdk";
import type { Service } from "../lib/service.ts";

export function wake(gcp: Service) {
  return cliCommand({
    summary: "Ask BB to resume the registered GCP machine",
    async run() {
      return { exitCode: 0, stdout: JSON.stringify(await gcp.wake(), null, 2) };
    },
  });
}
