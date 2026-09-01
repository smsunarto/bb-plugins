import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { gitButlerHostContract } from "./gitbutler.ts";

export const GTD_SIDEBAR_AI_SERVICE_ID = "gtd-sidebar";

export const gtdSidebarHostContract = defineRpcContract({
  ...gitButlerHostContract,
  ...experimental_aiServicesHostContract,
});
