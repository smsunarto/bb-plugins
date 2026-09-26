import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Host = { id: string; name: string; online: boolean };

export async function listHosts(bb: BbPluginApi): Promise<Host[]> {
  return (await bb.sdk.hosts.list()).map((item) => ({
    id: item.id,
    name: item.name,
    online: item.status === "connected",
  }));
}

// bb answers 404 only for a removed machine. An offline machine or a failed
// request is not proof, so those throw instead of reporting the host gone.
export async function hostExists(bb: BbPluginApi, hostId: string): Promise<boolean> {
  try {
    await bb.sdk.hosts.get({ hostId });
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "status" in error && error.status === 404)
      return false;
    throw error;
  }
}
