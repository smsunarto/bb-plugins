import { rmSync } from "node:fs";
import { readTextOr } from "./fsx.ts";

export type SharedServiceDefinitionOwnership = "missing" | "owned" | "foreign" | "ambiguous";

export interface SharedServiceRetirementCandidate {
  name: "core" | "tunnel";
  label: string;
  definitionPath: string;
  expectedDefinition: string;
  requiredOwnedPaths: readonly string[];
  stop(): Promise<unknown>;
}

interface OwnershipExpectation {
  expectedDefinition: string;
  requiredOwnedPaths: readonly string[];
}

export function classifySharedServiceDefinition(
  actualDefinition: string | null,
  expectation: OwnershipExpectation,
): SharedServiceDefinitionOwnership {
  if (actualDefinition === null) return "missing";
  if (
    expectation.requiredOwnedPaths.length > 0 &&
    expectation.requiredOwnedPaths.every((path) => expectation.expectedDefinition.includes(path)) &&
    actualDefinition === expectation.expectedDefinition
  ) {
    return "owned";
  }
  return expectation.requiredOwnedPaths.some((path) => actualDefinition.includes(path))
    ? "ambiguous"
    : "foreign";
}

export async function retireCurrentDevOwnedSharedServices(options: {
  tunnel: SharedServiceRetirementCandidate;
  core: SharedServiceRetirementCandidate;
  readDefinition?: (path: string) => string | null;
  removeDefinition?: (path: string) => void;
}): Promise<{ retiredTunnel: boolean; retiredCore: boolean }> {
  const readDefinition = options.readDefinition ?? readTextOr;
  const removeDefinition = options.removeDefinition ?? ((path) => rmSync(path, { force: true }));
  const candidates = [options.tunnel, options.core] as const;
  const inspected = candidates.map((candidate) => {
    const definition = readDefinition(candidate.definitionPath);
    return {
      candidate,
      definition,
      ownership: classifySharedServiceDefinition(definition, candidate),
    };
  });

  const ambiguous = inspected.find((entry) => entry.ownership === "ambiguous");
  if (ambiguous !== undefined) {
    throw new Error(
      `The shared Agent Proxy ${ambiguous.candidate.name} definition at ${ambiguous.candidate.definitionPath} partially matches this development instance. Ownership is ambiguous, so Agent Proxy is refusing to stop or remove ${ambiguous.candidate.label}.`,
    );
  }

  const retired = { retiredTunnel: false, retiredCore: false };
  for (const entry of inspected) {
    if (entry.ownership !== "owned" || entry.definition === null) continue;
    await entry.candidate.stop();
    const currentDefinition = readDefinition(entry.candidate.definitionPath);
    if (
      currentDefinition !== entry.definition ||
      classifySharedServiceDefinition(currentDefinition, entry.candidate) !== "owned"
    ) {
      throw new Error(
        `The shared Agent Proxy ${entry.candidate.name} definition at ${entry.candidate.definitionPath} changed while the shared service was stopping. Agent Proxy left the definition untouched.`,
      );
    }
    removeDefinition(entry.candidate.definitionPath);
    if (entry.candidate.name === "tunnel") retired.retiredTunnel = true;
    else retired.retiredCore = true;
  }
  return retired;
}
