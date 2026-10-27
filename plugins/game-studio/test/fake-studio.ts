import type { Game } from "@argus-labs/game-studio-api";

/*
 * A stand-in for the Game Studio Worker behind the plugin's `fetch`: routes by method and path,
 * records every call with its headers, and is removed again when the test ends.
 */
export type StudioCall = { method: string; path: string; headers: Headers; body: unknown };
export type StudioRoute = (call: StudioCall) => { status?: number; body: unknown };

export const STUDIO_URL = "https://studio.test";
export const STUDIO_SETTINGS = {
  studioUrl: STUDIO_URL,
  accessClientId: "client-id.access",
  accessClientSecret: "client-secret",
};

export function fakeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "game",
    name: "Orbit",
    kind: "unity",
    createdAt: 0,
    threadId: null,
    previewPath: "index.html",
    checkout: { projectId: "project", hostId: "remote", rootPath: "/game" },
    ...overrides,
  };
}

export function fakeStudio(routes: Record<string, StudioRoute>) {
  const calls: StudioCall[] = [];
  const original = globalThis.fetch;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== STUDIO_URL) throw new Error(`Unexpected fetch to ${request.url}`);
    const key = `${request.method} ${url.pathname}`;
    const route = routes[key];
    if (!route)
      return Response.json({ error: "not_found", message: `No route for ${key}` }, { status: 404 });
    const text = await request.text();
    const call = {
      method: request.method,
      path: url.pathname + url.search,
      headers: request.headers,
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    const { status = 200, body } = route(call);
    return Response.json(body, { status });
  }) as typeof globalThis.fetch;
  globalThis.fetch = fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
