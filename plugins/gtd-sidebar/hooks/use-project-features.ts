import { useSettings } from "@get-bb/plugin-sdk/app";

/** Fail closed while the SDK is loading settings. */
export function useProjectFeatures() {
  const { values } = useSettings();
  const projects = values?.projectsEnabled === true;
  return { projects, subscriptions: projects && values?.subscriptionsEnabled === true };
}
