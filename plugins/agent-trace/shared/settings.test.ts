import { describe, expect, test } from "bun:test";
import { parseAgentTraceSettings, type AgentTraceSettingsValues } from "./settings.ts";

const base: AgentTraceSettingsValues = {
  contentMode: "metadata",
  deploymentEnvironment: "test",
  laminarEndpoint: "https://api.lmnr.ai/v1/traces",
  langfuseBaseUrl: "https://cloud.langfuse.com",
};

describe("agent trace settings", () => {
  test("requires at least one backend", () => {
    expect(parseAgentTraceSettings(base)).toEqual({
      ok: false,
      message:
        "Set a Laminar project API key or Langfuse public and secret keys in plugin settings.",
    });
  });

  test("enables Langfuse Cloud from a key pair and trims the base URL", () => {
    const parsed = parseAgentTraceSettings({
      ...base,
      langfuseBaseUrl: " https://us.cloud.langfuse.com/ ",
      langfusePublicKey: "pk-lf-1",
      langfuseSecretKey: "sk-lf-1",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        contentMode: "metadata",
        deploymentEnvironment: "test",
        laminar: null,
        langfuse: {
          baseUrl: "https://us.cloud.langfuse.com",
          publicKey: "pk-lf-1",
          secretKey: "sk-lf-1",
        },
      },
    });
  });

  test("rejects a half-configured Langfuse key pair", () => {
    expect(parseAgentTraceSettings({ ...base, langfusePublicKey: "pk-lf-1" })).toEqual({
      ok: false,
      message: "Set both the Langfuse public key and secret key.",
    });
  });

  test("enables both backends together", () => {
    const parsed = parseAgentTraceSettings({
      ...base,
      contentMode: "full",
      laminarApiKey: "lmnr",
      langfusePublicKey: "pk-lf-1",
      langfuseSecretKey: "sk-lf-1",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.laminar).toEqual({ apiKey: "lmnr", endpoint: base.laminarEndpoint });
    expect(parsed.value.langfuse?.publicKey).toBe("pk-lf-1");
    expect(parsed.value.contentMode).toBe("full");
  });

  test("rejects an invalid Langfuse base URL", () => {
    expect(
      parseAgentTraceSettings({
        ...base,
        langfuseBaseUrl: "ftp://cloud.langfuse.com",
        langfusePublicKey: "pk-lf-1",
        langfuseSecretKey: "sk-lf-1",
      }),
    ).toEqual({
      ok: false,
      message: "Set a valid HTTP or HTTPS Langfuse base URL such as https://cloud.langfuse.com.",
    });
  });
});
