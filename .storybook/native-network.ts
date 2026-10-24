let installed = false;

export function installNativeNetworkFixture() {
  if (installed) return;
  installed = true;
  const attempts: { method: string; url: string }[] = [];
  window.__bbNativeBackendAttempts = attempts;
  const record = (method: string, url: string): never => {
    attempts.push({ method, url });
    throw new Error(`Native Storybook blocks backend access: ${method} ${url}`);
  };
  const isBackend = (url: string) =>
    /^\/(api|ws)(\/|$)/.test(new URL(url, window.location.href).pathname);
  const nativeFetch = window.fetch;
  const originalFetch = nativeFetch.bind(window);
  const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!isBackend(url)) return originalFetch(input, init);
    if (
      method === "GET" &&
      new URL(url, window.location.href).pathname === "/api/v1/plugins/contributions"
    ) {
      return Response.json({ threadActions: [], mentionProviders: [] });
    }
    return record(method, url);
  };
  window.fetch = Object.assign(fixtureFetch, nativeFetch);
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (isBackend(String(url))) record("WebSocket", String(url));
      super(url, protocols);
    }
  };
  const Events = window.EventSource;
  window.EventSource = class extends Events {
    constructor(url: string | URL, options?: EventSourceInit) {
      if (isBackend(String(url))) record("EventSource", String(url));
      super(url, options);
    }
  };
}
