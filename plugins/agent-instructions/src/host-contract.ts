import { defineRpcContract } from "@get-bb/plugin-sdk";
import { catalogHostMethods } from "./catalog/model.ts";
import { documentHostMethods } from "./documents/model.ts";

/** The plugin's one `bb.host` entry serves both the documents and catalog methods. */
export const hostContract = defineRpcContract({ ...documentHostMethods, ...catalogHostMethods });
