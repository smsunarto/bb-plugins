import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { cloudflareHostContract } from "../shared/host-contract.ts";
import { ConnectorManager, probe } from "./connector.ts";
const connectors = new ConnectorManager();
export default experimental_defineHostEntry({
  contract: cloudflareHostContract,
  handlers: {
    probe: ({ port, executable }) => probe(port, executable),
    status: ({ id }) => connectors.status(id),
    start: ({ id, token, executable }, context) =>
      connectors.start(id, token, executable, () => context.experimental_retainWorker()),
    stop: ({ id }) => connectors.stop(id),
  },
  dispose: () => connectors.dispose(),
});
