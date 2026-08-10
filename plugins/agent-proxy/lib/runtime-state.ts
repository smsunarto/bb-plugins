import { createHash } from "node:crypto";

export interface RuntimeConfigIdentity {
  managementKey: string;
  port: number;
}

export function runtimeConfigFingerprint(identity: RuntimeConfigIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify({ port: identity.port, managementKey: identity.managementKey }))
    .digest("hex");
}

export interface RuntimeReconciliationPlan {
  stopBeforeWrite: boolean;
  writeConfig: boolean;
  startAfterWrite: boolean;
}

/** Plan startup-only config reconciliation before the config file is changed.
    A loaded service with a missing or different marker must stop first. */
export function planRuntimeReconciliation(options: {
  appliedFingerprint: string | null;
  desiredFingerprint: string;
  desiredRunning: boolean;
  serviceLoaded: boolean;
}): RuntimeReconciliationPlan {
  const configMatches = options.appliedFingerprint === options.desiredFingerprint;
  if (options.serviceLoaded && configMatches) {
    return { stopBeforeWrite: false, writeConfig: false, startAfterWrite: false };
  }

  return {
    stopBeforeWrite: options.serviceLoaded,
    writeConfig: true,
    startAfterWrite: options.serviceLoaded && options.desiredRunning,
  };
}
