import { randomUUID } from "node:crypto";
import type {
  Account,
  AntigravityLoginCompleteInput,
  AntigravityLoginStart,
  AntigravityLoginTarget,
} from "./contracts.js";
import type { AntigravityUsageProbe } from "./antigravity-host-contract.js";

export interface AntigravityHostBridge {
  loginStart(
    hostId: string,
    input: { profileId: string; command?: string },
  ): Promise<{
    sessionId: string;
    authorizeUrl: string;
    profileHomeDir: string;
    geminiDir: string;
    appDataDir: string;
  }>;
  loginComplete(
    hostId: string,
    input: { sessionId: string; pasted: string },
  ): Promise<{
    profileHomeDir: string;
    geminiDir: string;
    appDataDir: string;
    usage: AntigravityUsageProbe;
  }>;
  loginCancel(hostId: string, input: { sessionId: string }): Promise<{ cancelled: boolean }>;
  probeUsage(
    hostId: string,
    input: { profileId: string; command?: string },
  ): Promise<AntigravityUsageProbe>;
  removeProfile(hostId: string, input: { profileId: string }): Promise<{ removed: boolean }>;
}

export interface AntigravityAuthenticatedProfile {
  label: string;
  hostId: string;
  profileId: string;
  geminiDir: string;
  appDataDir: string;
  usage: AntigravityUsageProbe;
}

interface PendingLoginSession {
  sessionId: string;
  hostId: string;
  hostSessionId: string;
  profileId: string;
  target: AntigravityLoginTarget;
}

export interface AntigravityOAuthLoginOptions {
  bridge: AntigravityHostBridge;
  resolveTargetHost: (target: AntigravityLoginTarget) => Promise<{
    hostId: string;
    profileId: string;
  }>;
  saveLogin: (
    authenticated: AntigravityAuthenticatedProfile,
    target: AntigravityLoginTarget,
  ) => Promise<Account>;
}

export class AntigravityOAuthLogin {
  private readonly sessions = new Map<string, PendingLoginSession>();

  constructor(private readonly options: AntigravityOAuthLoginOptions) {}

  async start(target: AntigravityLoginTarget): Promise<AntigravityLoginStart> {
    const { hostId, profileId } = await this.options.resolveTargetHost(target);
    const started = await this.options.bridge.loginStart(hostId, { profileId });
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      hostId,
      hostSessionId: started.sessionId,
      profileId,
      target,
    });
    return {
      sessionId,
      hostId,
      authorizeUrl: started.authorizeUrl,
    };
  }

  async complete(input: AntigravityLoginCompleteInput): Promise<Account> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new Error("Antigravity login session was not found. Start again.");
    }
    this.sessions.delete(input.sessionId);
    const completed = await this.options.bridge.loginComplete(session.hostId, {
      sessionId: session.hostSessionId,
      pasted: input.pasted,
    });
    const label =
      session.target.kind === "add" && session.target.label !== null
        ? session.target.label
        : `Antigravity (${session.profileId.slice(0, 8)})`;
    return this.options.saveLogin(
      {
        label,
        hostId: session.hostId,
        profileId: session.profileId,
        geminiDir: completed.geminiDir,
        appDataDir: completed.appDataDir,
        usage: completed.usage,
      },
      session.target,
    );
  }

  async cancel(input: { sessionId: string }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) return false;
    this.sessions.delete(input.sessionId);
    const result = await this.options.bridge
      .loginCancel(session.hostId, { sessionId: session.hostSessionId })
      .catch(() => ({ cancelled: false }));
    return result.cancelled;
  }

  dispose(): void {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of pending) {
      void this.options.bridge
        .loginCancel(session.hostId, { sessionId: session.hostSessionId })
        .catch(() => undefined);
    }
  }
}
