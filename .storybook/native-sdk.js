import { createBrowserBbSdk } from "@bb-native/deps/@bb/sdk/browser";
export { BbHttpError } from "@bb-native/deps/@bb/sdk/browser";

export const backendAttempts = window.__bbNativeBackendAttempts ?? [];
export const sdk = createBrowserBbSdk({
  baseUrl: "http://storybook.invalid",
  fetch: async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    backendAttempts.push({ method, url });
    throw new Error(`Native Storybook blocks backend access: ${method} ${url}`);
  },
});
