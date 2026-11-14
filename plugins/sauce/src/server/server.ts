import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";

import { sauceCli } from "./cli.ts";
import { LEASE_MIGRATIONS, createSauceCore, defaultCoreDeps, type SauceCoreDeps } from "./core.ts";

/** Every skill under skills/; configure must name them all, or none would be selected. */
export const SKILLS = ["sauce-live"];

/** The thread snippet that steers device work to `bb sauce` reaches only these projects (name or git remote). */
export const SAUCE_PROJECT_PATTERN = /rampage/i;

const text = instructionFiles(import.meta.url);

export function registerSauce(bb: BbPluginApi, overrides: Partial<SauceCoreDeps> = {}) {
  bb.storage.migrate(bb.storage.database(), LEASE_MIGRATIONS);
  const core = createSauceCore({ ...defaultCoreDeps(bb), ...overrides });
  bb.cli.register(sauceCli(core));
  const snippet = text.read("sauce");
  bb.agents.configure((context) => {
    const sauce =
      SAUCE_PROJECT_PATTERN.test(context.project.name) ||
      SAUCE_PROJECT_PATTERN.test(context.project.gitRemoteUrl ?? "");
    return { tools: [], skills: SKILLS, ...(sauce ? { instructions: snippet } : {}) };
  });
  return core;
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  registerSauce(bb);
}
