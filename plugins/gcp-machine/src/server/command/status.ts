import { cliCommand } from "@get-bb/plugin-sdk";
import type { Service } from "../lib/service.ts";

export function status(gcp: Service) {
  return cliCommand({
    summary: "Show GCP VM state, BB registration, and the one-hour idle policy",
    async run() {
      return { exitCode: 0, stdout: JSON.stringify(await gcp.status(), null, 2) };
    },
  });
}
