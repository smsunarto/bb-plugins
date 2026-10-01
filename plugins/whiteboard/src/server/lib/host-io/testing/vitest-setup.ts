import { installInProcessHostIo } from "./in-process.ts";

/**
 * vitest `setupFiles` entry: vendored engine specs (structural comparisons,
 * pull requests, local data) call the host-io facades the way upstream called
 * local git, so every spec file gets the real host entry in-process.
 */
installInProcessHostIo();
