export type RemoteSessionState = "ready" | "browser-login-required";
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const REMOTE_SESSION_URL = "/api/v1/plugins/agent-trace/http/remote-session";

export function requiresConnectSession(dashboardUrl: string): boolean {
  try {
    return new URL(dashboardUrl).hostname.toLowerCase().endsWith(".getbb.app");
  } catch {
    return false;
  }
}

export async function prepareRemoteSession(
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<RemoteSessionState> {
  try {
    const response = await fetchImpl(REMOTE_SESSION_URL, {
      method: "POST",
      body: "{}",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    return response.ok ? "ready" : "browser-login-required";
  } catch {
    return "browser-login-required";
  }
}
