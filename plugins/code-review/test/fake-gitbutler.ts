import type { z } from "zod";

/*
 * The GitButler plugin's side of `bb.sdk.plugins.callRpc`, as plain data.
 * Its answers go through the caller's output schema, as bb's do.
 */

export const BASE = "28c4d3075b5916acdb6974a7e4f5c49d2c274a86";
export const BOTTOM = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const TOP = "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38";

/** Two stacked branches in one checkout, and one in a checkout with no GitHub origin. */
export const UNPUBLISHED = {
  branches: [
    {
      hostId: "host-1",
      machine: "cardinal",
      path: "/home/scott/git/api",
      repoName: "api",
      origin: "github.com/acme/api",
      branch: "scott/login-copy",
      status: "unpushed",
      head: BOTTOM,
      base: BASE,
      parent: null,
      commits: [
        {
          commitId: BOTTOM,
          changeId: null,
          message: "Reword the login error\n\nSays which field is wrong.",
          authorName: "Scott",
          createdAt: "2026-10-09T10:00:00Z",
          conflicted: false,
        },
      ],
    },
    {
      hostId: "host-1",
      machine: "cardinal",
      path: "/home/scott/git/api",
      repoName: "api",
      origin: "github.com/acme/api",
      branch: "scott/rate-limit",
      status: "ahead",
      head: TOP,
      base: BOTTOM,
      parent: "scott/login-copy",
      commits: [
        {
          commitId: TOP,
          changeId: "c2",
          message: "Rate-limit the login endpoint",
          authorName: "Scott",
          createdAt: "2026-10-10T09:00:00Z",
          conflicted: false,
        },
      ],
    },
    {
      hostId: "host-2",
      machine: "laptop",
      path: "/Users/scott/web",
      repoName: "web",
      origin: "gitlab.com/acme/web",
      branch: "fix-nav",
      status: "unpushed",
      head: TOP,
      base: BASE,
      parent: null,
      commits: [
        {
          commitId: TOP,
          changeId: null,
          message: "Fix the nav",
          authorName: "Ada",
          createdAt: "2026-10-01T00:00:00Z",
          conflicted: false,
        },
      ],
    },
  ],
};

type RpcArgs = { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType };

/** `plugins.callRpc` and `plugins.list` for a fake host, with the GitButler plugin answering `methods`. */
export function fakeGitButler(
  methods: Record<string, (input: unknown) => unknown> = {},
  { installed = true }: { installed?: boolean } = {},
) {
  return {
    callRpc: async ({ pluginId, method, input, outputSchema }: RpcArgs) => {
      const answer = methods[method];
      if (pluginId !== "gitbutler" || !installed || !answer) {
        throw Object.assign(new Error(`HTTP 404: no RPC ${pluginId}.${method}`), { status: 404 });
      }
      return outputSchema.parse(await answer(input));
    },
    list: async () => ({
      plugins: installed
        ? [{ id: "gitbutler", enabled: true }]
        : [{ id: "code-review", enabled: true }],
    }),
  };
}
