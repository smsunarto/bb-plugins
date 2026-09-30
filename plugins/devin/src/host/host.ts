import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge as acp } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createTurnSettler } from "./turn-settle.ts";

// Devin speaks ACP natively (`devin acp`), so the plugin runs it through the
// SDK's generic ACP bridge. The launch spec arrives per command in the
// provider options (src/server/lib/declaration.ts).
//
// The bridge writes its lines straight to stdout, so the turn settler
// (src/host/turn-settle.ts) wraps the stream once at start. It only ever
// delays a Cloud turn's end line; everything else passes as written.
let writeThrough: (chunk: string) => void = () => {};
const settler = createTurnSettler({ write: (line) => writeThrough(line) });

function settleStdout(): void {
  const stdout = process.stdout;
  const original = stdout.write.bind(stdout);
  writeThrough = (chunk) => void original(chunk);
  stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string" && rest.length === 0) {
      settler.write(chunk);
      return true;
    }
    return original(chunk as never, ...(rest as never[]));
  }) as typeof stdout.write;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context) {
    settleStdout();
    acp.start?.(context);
  },
  handleLine(line) {
    settler.beforeInbound(line);
    acp.handleLine(line);
  },
  onClose() {
    settler.flush();
    acp.onClose?.();
  },
});
