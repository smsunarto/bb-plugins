import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { catalogHostHandlers } from "./catalog/host.ts";
import { documentHostHandlers } from "./documents/host.ts";
import { hostContract } from "./host-contract.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { ...documentHostHandlers, ...catalogHostHandlers },
});
