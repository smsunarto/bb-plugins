import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Fal's public CLI device client; kept in sync with fal.auth.auth0.
const clientId = "TwXR51Vz8JbY8GUUMy6EyuVR0fTO7N4N";
const issuer = "https://auth.fal.ai";
const token = z.string().min(1).max(32768);
const sessionSchema = z.object({
  accessToken: token,
  refreshToken: token,
  expiresAt: z.number().finite(),
  account: z.string().max(320),
});
const tokenResponse = z.object({
  access_token: token,
  refresh_token: token.optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(365 * 86400),
});
const deviceResponse = z.object({
  device_code: token,
  user_code: z.string().min(1).max(64),
  verification_uri_complete: z.url().refine((value) => new URL(value).origin === issuer),
  expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().min(1).max(60).default(5),
});
export const falAuthAction = z.enum(["connect", "poll", "status", "disconnect"]);
export const falAuthStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disconnected") }),
  z.object({ state: z.literal("connected"), account: z.string(), expiresAt: z.number() }),
  z.object({
    state: z.literal("pending"),
    authorizationUrl: z.url(),
    userCode: z.string(),
    expiresAt: z.number(),
    nextPollAt: z.number(),
  }),
]);
type Session = z.infer<typeof sessionSchema>;
type Pending = z.infer<typeof deviceResponse> & { expiresAt: number; nextPollAt: number };
type Dependencies = {
  read: () => Promise<string | undefined>;
  save: (value: string | null) => Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
};
export type FalOAuthContext = { bb: BbPluginApi; falOAuth: FalOAuth };

/** Owns Fal login, refresh rotation and secret persistence. Public status never contains tokens. */
export class FalOAuth {
  private pending?: Pending;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new Error("Game Studio is reloading. Retry Fal sign-in after reload.");
      return action();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async request(path: string, body: Record<string, string>) {
    let response: Response;
    try {
      response = await this.fetcher(`${issuer}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Could not reach Fal sign-in. Retry when the connection is available.");
    }
    return { ok: response.ok, data: await this.json(response) };
  }
  private async json(response: Response): Promise<unknown> {
    try {
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024) throw new Error("Oversized response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return text.trim() ? JSON.parse(text) : null;
    } catch {
      throw new Error("Fal returned an invalid sign-in response.");
    }
  }
  private async read(): Promise<Session | undefined> {
    const raw = await this.deps.read();
    if (!raw) return;
    try {
      return sessionSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("Saved Fal authorization is invalid. Connect Fal again.");
    }
  }
  private async save(value: Session | null) {
    // dispose waits for in-flight exchanges: persist rotation before the old worker exits.
    await this.deps.save(value ? JSON.stringify(value) : null);
  }
  private status(session?: Session): z.infer<typeof falAuthStatus> {
    const pending = this.pending;
    if (pending && pending.expiresAt > this.now())
      return {
        state: "pending",
        authorizationUrl: pending.verification_uri_complete,
        userCode: pending.user_code,
        expiresAt: pending.expiresAt,
        nextPollAt: pending.nextPollAt,
      };
    this.pending = undefined;
    return session
      ? { state: "connected", account: session.account, expiresAt: session.expiresAt }
      : { state: "disconnected" };
  }
  execute(action: z.infer<typeof falAuthAction>) {
    return this.serial(async (): Promise<z.infer<typeof falAuthStatus>> => {
      if (action === "connect") {
        const response = await this.request("/oauth/device/code", {
          client_id: clientId,
          audience: "fal-cloud",
          scope: "openid profile email offline_access",
        });
        const parsed = deviceResponse.safeParse(response.data);
        if (!response.ok || !parsed.success)
          throw new Error("Fal could not start browser sign-in. Retry connecting.");
        this.pending = {
          ...parsed.data,
          expiresAt: this.now() + parsed.data.expires_in * 1000,
          nextPollAt: this.now() + parsed.data.interval * 1000,
        };
        return this.status();
      }
      if (action === "disconnect") {
        const session = await this.read();
        this.pending = undefined;
        // Forget locally even if revocation is temporarily unavailable.
        await this.save(null);
        if (session) {
          const response = await this.request("/oauth/revoke", {
            client_id: clientId,
            token: session.refreshToken,
          });
          if (!response.ok)
            throw new Error(
              "Fal disconnected locally. Revoke the grant in Fal to confirm remote sign-out.",
            );
        }
        return { state: "disconnected" };
      }
      if (action === "status") return this.status(await this.read());
      const pending = this.pending;
      if (!pending || pending.expiresAt <= this.now()) {
        this.pending = undefined;
        throw new Error("Fal sign-in expired. Connect again.");
      }
      if (pending.nextPollAt > this.now()) return this.status();
      pending.nextPollAt = this.now() + pending.interval * 1000;
      const response = await this.request("/oauth/token", {
        client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.device_code,
      });
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(response.data);
        if (error.success && ["authorization_pending", "slow_down"].includes(error.data.error)) {
          if (error.data.error === "slow_down") {
            pending.interval += 5;
            pending.nextPollAt = this.now() + pending.interval * 1000;
          }
          return this.status();
        }
        this.pending = undefined;
        throw new Error("Fal sign-in was declined or expired. Connect again.");
      }
      const result = tokenResponse.safeParse(response.data);
      if (!result.success || !result.data.refresh_token)
        throw new Error("Fal did not return offline authorization. Connect again.");
      let identityResponse: Response;
      try {
        identityResponse = await this.fetcher(`${issuer}/userinfo`, {
          headers: { Authorization: `Bearer ${result.data.access_token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new Error("Could not verify the Fal account. Connect again.");
      }
      const identity = z
        .object({ sub: z.string().min(1).max(320), email: z.string().max(320).optional() })
        .safeParse(await this.json(identityResponse));
      if (!identityResponse.ok || !identity.success)
        throw new Error("Could not verify the Fal account. Connect again.");
      const session: Session = {
        accessToken: result.data.access_token,
        refreshToken: result.data.refresh_token,
        expiresAt: this.now() + result.data.expires_in * 1000,
        account: identity.data.email ?? identity.data.sub,
      };
      await this.save(session);
      this.pending = undefined;
      return this.status(session);
    });
  }
  accessToken(): Promise<string> {
    return this.serial(async () => {
      let session = await this.read();
      if (!session) throw new Error("Connect Fal with browser sign-in before using H3 Max.");
      // Hosts retain this token through submission plus up to ten minutes of collection.
      if (session.expiresAt <= this.now() + 15 * 60000) {
        const response = await this.request("/oauth/token", {
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        });
        const result = tokenResponse.safeParse(response.data);
        if (!response.ok || !result.success) {
          const error = z.object({ error: z.literal("invalid_grant") }).safeParse(response.data);
          if (error.success) {
            await this.save(null);
            throw new Error("Fal authorization expired. Connect Fal again.");
          }
          throw new Error("Fal authorization could not be refreshed. Retry when Fal is available.");
        }
        session = {
          ...session,
          accessToken: result.data.access_token,
          refreshToken: result.data.refresh_token ?? session.refreshToken,
          expiresAt: this.now() + result.data.expires_in * 1000,
        };
        await this.save(session);
      }
      return session.accessToken;
    });
  }
  async dispose() {
    this.closed = true;
    this.pending = undefined;
    await this.queue;
  }
}
