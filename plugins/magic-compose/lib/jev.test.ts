import { describe, expect, it } from "vitest";
import { askChoice, askChoices, askChoicesVia, JEV_PROVIDERS, JevError } from "./jev";

const question = {
  instructions: "Pick the project.",
  options: { bb: "The BB app.", games: "Small games." },
};

function respond(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("askChoice", () => {
  it("speaks the AI Gateway evaluation protocol", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          answers: { q0: { type: "choice", choice: "bb", probabilities: { bb: 0.9, games: 0.1 } } },
          usage: { inputTokens: 412 },
          providerMetadata: { typesafe: { confidence: { q0: 0.81 } } },
        }),
      );
    };

    const answer = await askChoice({
      provider: "vercel",
      apiKey: "key",
      model: "typesafe-ai/jev",
      state: { task: "Fix the sidebar" },
      question,
      fetchImpl,
    });

    expect(request?.url).toBe(JEV_PROVIDERS.vercel.url);
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key");
    expect(headers["ai-model-id"]).toBe("typesafe-ai/jev");
    expect(headers["ai-evaluation-model-specification-version"]).toBe("4");
    expect(JSON.parse(String(request?.init.body))).toEqual({
      state: { task: "Fix the sidebar" },
      questions: {
        q0: { type: "choice", instructions: question.instructions, criteria: question.options },
      },
    });
    expect(answer).toMatchObject({
      choice: "bb",
      probabilities: { bb: 0.9, games: 0.1 },
      confidence: 0.81,
      inputTokens: 412,
    });
  });

  it("falls back to the likeliest offered option when the pick was not offered", async () => {
    const answer = await askChoice({
      provider: "vercel",
      apiKey: "key",
      model: "m",
      state: "s",
      question,
      fetchImpl: respond(200, {
        answers: {
          q0: {
            type: "choice",
            choice: "invented",
            probabilities: { invented: 0.6, games: 0.3, bb: 0.1 },
          },
        },
      }),
    });
    expect(answer.choice).toBe("games");
    expect(answer.probabilities).toEqual({ games: 0.3, bb: 0.1 });
    expect(answer.confidence).toBeNull();
  });

  it("explains a rejected key without retrying", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response("{}", { status: 401 });
    };
    const error = await askChoice({
      provider: "vercel",
      apiKey: "bad",
      model: "m",
      state: "s",
      question,
      fetchImpl,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).code).toBe("auth");
    expect(calls).toBe(1);
  });

  it("names the free-tier limit on a 429", async () => {
    const error = await askChoice({
      provider: "vercel",
      apiKey: "key",
      model: "m",
      state: "s",
      question,
      fetchImpl: respond(429, { error: { message: "slow down" } }),
    }).catch((cause: unknown) => cause);
    expect((error as JevError).code).toBe("rate_limited");
    expect((error as JevError).message).toContain("free tier");
  });

  it("retries a server error once", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response("upstream timeout", { status: 504 });
      return new Response(JSON.stringify({ answers: { q0: { type: "choice", choice: "bb" } } }));
    };
    const answer = await askChoice({
      provider: "vercel",
      apiKey: "key",
      model: "m",
      state: "s",
      question,
      fetchImpl,
    });
    expect(calls).toBe(2);
    expect(answer.choice).toBe("bb");
    expect(answer.probabilities).toEqual({});
  });

  it("refuses more options than Jev accepts", async () => {
    const options = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p${i}`, null]));
    await expect(
      askChoice({
        provider: "vercel",
        apiKey: "key",
        model: "m",
        state: "s",
        question: { instructions: "x", options },
      }),
    ).rejects.toThrow("at most 255");
  });
});

describe("askChoice on OpenRouter", () => {
  it("speaks the Decisions endpoint and reads confidence off the answer", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          id: "gen-1",
          model: "typesafe/jev-1.13",
          answers: {
            q0: {
              type: "choice",
              choice: "games",
              confidence: 0.77,
              probabilities: { bb: 0.2, games: 0.8 },
            },
          },
          usage: { input_tokens: 388, output_tokens: 0, cost: 0.00001 },
        }),
      );
    };

    const answer = await askChoice({
      provider: "openrouter",
      apiKey: "sk-or-key",
      model: "typesafe/jev-1.13",
      state: { task: "Add a lap counter" },
      question: { instructions: "Pick the project.", options: { bb: "The BB app.", games: null } },
      fetchImpl,
    });

    expect(request?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-key");
    expect(headers["ai-model-id"]).toBeUndefined();
    // The model travels in the body, and every option gets a string description.
    expect(JSON.parse(String(request?.init.body))).toEqual({
      model: "typesafe/jev-1.13",
      state: { task: "Add a lap counter" },
      questions: {
        q0: {
          type: "choice",
          instructions: "Pick the project.",
          criteria: { bb: "The BB app.", games: "" },
        },
      },
    });
    expect(answer).toMatchObject({
      choice: "games",
      probabilities: { bb: 0.2, games: 0.8 },
      confidence: 0.77,
      inputTokens: 388,
    });
  });

  it("names OpenRouter when the key is rejected or the account has no credit", async () => {
    const ask = (status: number) =>
      askChoice({
        provider: "openrouter",
        apiKey: "k",
        model: "m",
        state: "s",
        question,
        fetchImpl: respond(status, { error: { message: "User not found.", code: status } }),
      }).catch((cause: unknown) => cause as JevError);
    expect(await ask(401)).toMatchObject({
      code: "auth",
      message: expect.stringContaining("OpenRouter"),
    });
    expect(await ask(402)).toMatchObject({ code: "no_credit" });
  });
});

describe("askChoicesVia", () => {
  const vercel = { provider: "vercel" as const, apiKey: "v", model: "typesafe-ai/jev" };
  const openrouter = { provider: "openrouter" as const, apiKey: "o", model: "typesafe/jev-1.13" };

  it("falls over to the next gateway when the first is unavailable", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      urls.push(String(url));
      return String(url) === JEV_PROVIDERS.vercel.url
        ? new Response("{}", { status: 429 })
        : new Response(JSON.stringify({ answers: { q0: { type: "choice", choice: "bb" } } }));
    };
    const answers = await askChoicesVia([vercel, openrouter], {
      state: "s",
      questions: { project: question },
      fetchImpl,
    });
    expect(answers.project?.choice).toBe("bb");
    expect(urls).toEqual([JEV_PROVIDERS.vercel.url, JEV_PROVIDERS.openrouter.url]);
  });

  it("reports the last gateway's error when every one fails, and says so when none is set", async () => {
    await expect(
      askChoicesVia([vercel, openrouter], {
        state: "s",
        questions: { project: question },
        fetchImpl: respond(401, {}),
      }),
    ).rejects.toThrow("OpenRouter rejected the API key");
    await expect(
      askChoicesVia([], { state: "s", questions: { project: question } }),
    ).rejects.toThrow("No Jev API key");
  });
});

describe("askChoices", () => {
  it("sends every question in one request under plain ids and hands the answers back by key", async () => {
    let body: { questions: Record<string, { instructions: string }> } | undefined;
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          answers: {
            q0: { type: "choice", choice: "bb", probabilities: { bb: 0.6, games: 0.4 } },
            q1: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.9 } },
          },
          usage: { inputTokens: 900 },
          providerMetadata: { typesafe: { confidence: { q0: 0.5, q1: 0.88 } } },
        }),
      );
    };
    const answers = await askChoices({
      provider: "vercel",
      apiKey: "key",
      model: "typesafe-ai/jev",
      state: { task: "x" },
      questions: {
        project: question,
        "reasoning:0 (Opus 5)": {
          instructions: "Pick the effort.",
          options: { low: "Fast", high: "Thorough" },
        },
      },
      fetchImpl,
    });
    expect(calls).toBe(1);
    expect(Object.keys(body?.questions ?? {})).toEqual(["q0", "q1"]);
    expect(body?.questions.q1?.instructions).toBe("Pick the effort.");
    expect(answers.project).toMatchObject({ choice: "bb", confidence: 0.5, inputTokens: 900 });
    expect(answers["reasoning:0 (Opus 5)"]).toMatchObject({ choice: "high", confidence: 0.88 });
  });

  it("makes no request when there is nothing to ask", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not be called");
    };
    expect(
      await askChoices({
        provider: "vercel",
        apiKey: "k",
        model: "m",
        state: "s",
        questions: {},
        fetchImpl,
      }),
    ).toEqual({});
  });
});
