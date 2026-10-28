import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";

/**
 * What every RPC handler and command receives: the host plus the plugin
 * services `server.ts` builds once per load. A handler that needs only
 * some services narrows with `WhiteboardContext<"engine">`.
 */
export type WhiteboardContext<K extends keyof WhiteboardServices = keyof WhiteboardServices> =
  Readonly<{ bb: BbPluginApi } & Pick<WhiteboardServices, K>>;
