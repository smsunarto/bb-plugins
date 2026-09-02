export type RemoteSessionState = "ready" | "browser-login-required";

export const REMOTE_SESSION_URL = "/api/v1/plugins/novnc/http/remote-session";

export async function prepareRemoteSession(
  fetchImpl: typeof fetch = globalThis.fetch,
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
