import {
  createGameStudioClient,
  type GameStudioClient,
  serviceTokenHeaders,
} from "@argus-labs/game-studio-api";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/*
 * The studio lives in the Game Studio web app; this plugin is one of its clients. It calls the
 * API with the Cloudflare Access service token the operator pastes into the plugin's settings,
 * and tells people where the studio is so the panel can embed it.
 */

export function defineStudioSettings(bb: BbPluginApi) {
  return bb.settings.define({
    studioUrl: {
      type: "string",
      label: "Game Studio URL",
      description: "Origin of the Game Studio web app, for example https://studio.argus.dev.",
      default: "https://studio.argus.dev",
    },
    accessClientId: {
      type: "string",
      label: "Cloudflare Access client ID",
      description:
        "Client ID of the Access service token that lets this plugin call the studio API as a machine.",
    },
    accessClientSecret: {
      type: "string",
      label: "Cloudflare Access client secret",
      secret: true,
      description: "Secret of that service token. Never shown again once saved.",
    },
  });
}
export type StudioSettings = ReturnType<typeof defineStudioSettings>;

export class StudioClient {
  private readonly settings: StudioSettings;
  private readonly fetchImpl: typeof fetch | undefined;
  private cached: { key: string; client: GameStudioClient } | null = null;
  constructor(settings: StudioSettings, fetchImpl?: typeof fetch) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }
  /** Where the studio is, without a trailing slash. */
  async url(): Promise<string> {
    const { studioUrl } = await this.settings.get();
    const url = (studioUrl ?? "").trim().replace(/\/+$/, "");
    if (!url) throw new Error("Set the Game Studio URL in the plugin's settings.");
    return url;
  }
  /** A client over the current settings; a settings change makes a new one. */
  async client(): Promise<GameStudioClient> {
    const values = await this.settings.get();
    const baseUrl = await this.url();
    const clientId = (values.accessClientId ?? "").trim();
    const clientSecret = (values.accessClientSecret ?? "").trim();
    if (!clientId || !clientSecret)
      throw new Error(
        "Set the Cloudflare Access client ID and secret in the plugin's settings so it can call Game Studio.",
      );
    const key = JSON.stringify([baseUrl, clientId, clientSecret]);
    if (this.cached?.key === key) return this.cached.client;
    const client = createGameStudioClient({
      baseUrl,
      headers: serviceTokenHeaders({ clientId, clientSecret }),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    this.cached = { key, client };
    return client;
  }
}
