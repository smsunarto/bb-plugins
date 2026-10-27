import { defineRpcContract } from "@get-bb/plugin-sdk";
import { unityHostContract } from "./unity-editor-contract.ts";

/** What this plugin still runs on a bb machine: the Unity Editor and checkout-slot work. */
export const studioHostContract = defineRpcContract({ ...unityHostContract });
