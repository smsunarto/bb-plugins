import { defineCommand } from "@bb-kit/core/command";
import { inspectAuthSeed } from "../../src/auth.ts";
import { NANOCODEX_BINDING_VERSION } from "../../src/catalog.ts";

export const status = defineCommand({
  summary: "Show NanoCodex binding and authentication status",
  async execute() {
    const auth = await inspectAuthSeed();
    const detail = auth.state === "ready" ? "ready" : `${auth.state}: ${auth.message}`;
    return {
      exitCode: auth.state === "broken" ? 1 : 0,
      stdout: `binding: ${NANOCODEX_BINDING_VERSION}\nauth seed: ${detail}\nauth file: ${auth.path}\n`,
    };
  },
});
