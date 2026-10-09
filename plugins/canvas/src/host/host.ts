import { stat } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { canvasHostContract } from "../shared/host-contract.ts";

// A second write inside one timestamp tick of the first can leave the same
// size and times, so a file modified this recently is never vouched for.
const settleMs = 2000;

export default experimental_defineHostEntry({
  contract: canvasHostContract,
  handlers: {
    async stamp({ path }) {
      try {
        const stats = await stat(path, { bigint: true });
        if (!stats.isFile() || Date.now() - Number(stats.mtimeMs) < settleMs) {
          return { stamp: null };
        }
        const { dev, ino, size, mtimeNs, ctimeNs } = stats;
        return { stamp: [dev, ino, size, mtimeNs, ctimeNs].join(":") };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { stamp: code === "ENOENT" || code === "ENOTDIR" ? "absent" : null };
      }
    },
  },
});
