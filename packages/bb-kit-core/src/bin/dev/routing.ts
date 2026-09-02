import { delimiter, dirname } from "node:path";
import type { EnvironmentResult } from "./model.ts";

export const BB_ROUTING_KEYS = [
  "BB_SERVER_URL",
  "BB_CLI",
  "BB_HOST_DAEMON_PORT",
  "BB_KIT_DEV_NAME",
  "BB_KIT_DEV_SOURCE",
  "BB_THREAD_ID",
  "BB_ENVIRONMENT_ID",
  "BB_THREAD_STORAGE",
  "BB_PROJECT_ID",
  "BB_DEV_REPO_ROOT",
  "BB_DEV_LAUNCHER_NAME",
] as const;

export function cleanBbEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const key of BB_ROUTING_KEYS) {
    delete clean[key];
  }
  return clean;
}

export function routedEnvironment(
  environment: NodeJS.ProcessEnv,
  route: EnvironmentResult,
): NodeJS.ProcessEnv {
  const routed = cleanBbEnvironment(environment);
  routed["BB_CLI"] = route.BB_CLI;
  routed["BB_SERVER_URL"] = route.BB_SERVER_URL;
  routed["BB_HOST_DAEMON_PORT"] = route.BB_HOST_DAEMON_PORT;
  routed["BB_KIT_DEV_NAME"] = route.BB_KIT_DEV_NAME;
  routed["BB_KIT_DEV_SOURCE"] = route.BB_KIT_DEV_SOURCE;
  routed["PATH"] = `${dirname(route.BB_CLI)}${delimiter}${routed["PATH"] ?? ""}`;
  return routed;
}
