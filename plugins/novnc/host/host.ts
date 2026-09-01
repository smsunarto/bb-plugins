import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { NOVNC_PORT, novncHostContract } from "../shared/node/novnc-contract.ts";

const PROBE_TIMEOUT_MS = 2_000;

export default experimental_defineHostEntry({
  contract: novncHostContract,
  handlers: {
    // Probed from the host itself: the gate tunnel authenticates before
    // routing, so a server-side GET through it returns 401 for every port
    // and says nothing about whether NoVNC listens.
    async checkNovnc() {
      try {
        const response = await fetch(`http://127.0.0.1:${NOVNC_PORT}/vnc.html`, {
          method: "GET",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.status === 200) {
          return { running: true };
        }
        return { running: false, detail: `HTTP ${response.status}` };
      } catch (error) {
        return {
          running: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
});
