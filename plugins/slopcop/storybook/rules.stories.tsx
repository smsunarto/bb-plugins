import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
import { shows } from "../../../.storybook/ready";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

const source = () => import("../app");
const meta = {
  title: "Screens/SlopCop/Rules",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app) },
  play: shows("New rule"),
  parameters: {
    host: {
      pluginId: "slopcop",
      sdk: { hosts: { list: async () => [] }, projects: { list: async () => [] } },
      rpc: {
        listRules: () => ({ rules: [] }),
        listRuns: () => ({ runs: [] }),
        status: () => ({
          ghAvailable: false,
          ghLogin: null,
          watchedRepos: [],
          pollSeconds: 60,
          defaultThreadSection: "",
        }),
      },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};

const rule = {
  id: "rule_exclusion",
  name: "Internal PR reviews",
  repo: "example/repo",
  enabled: true,
  mode: "shadow",
  triggers: ["ready_for_review", "new_commits"],
  commentKeywords: [],
  conditions: [
    { kind: "has_label", labels: ["security"] },
    { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
  ],
  authorTrust: "org_members",
  requesterTrust: "org_members",
  prompt: "Review the pull request.",
  request: {
    projectId: "proj_story",
    providerId: "codex",
    model: "gpt-6.1-sol",
    permissionMode: "auto",
    environment: { type: "reuse", environmentId: "env_story" },
  },
  dedupe: "once_per_head_sha",
  reviewStrategy: "update",
  visibility: "visible",
  dangerous: false,
};
const saveRule = fn(async () => ({ rule }));
const populatedHost = {
  ...meta.parameters.host,
  rpc: { ...meta.parameters.host.rpc, listRules: () => ({ rules: [rule] }), saveRule },
};

export const WithAuthorExclusion: Story = {
  parameters: { host: populatedHost },
  play: shows("exclude PR author @dana, @dependabot[bot]"),
};

export const EditAuthorExclusion: Story = {
  name: "(Test) Edit author exclusion",
  parameters: { host: populatedHost },
  play: async ({ canvasElement }) => {
    saveRule.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Internal PR reviews/ }));
    await userEvent.click(canvas.getByText("Filters & author exclusions"));
    await canvas.findByLabelText("Exclude PR authors", { exact: false });
    const field = () => canvas.getByLabelText("Exclude PR authors", { exact: false });
    await expect(field()).toHaveValue("dana, dependabot[bot]");
    await userEvent.click(field());
    await userEvent.clear(field());
    await userEvent.type(field(), "@");
    await expect(canvas.getByRole("alert")).toHaveTextContent("Add a GitHub username after @.");
    await userEvent.click(field());
    await userEvent.clear(field());
    await userEvent.type(field(), "@Other");
    await userEvent.click(canvas.getByRole("button", { name: "Save rule" }));
    await waitFor(() =>
      expect(saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          id: rule.id,
          rule: expect.objectContaining({
            conditions: [
              { kind: "has_label", labels: ["security"] },
              { kind: "exclude_author", logins: ["@Other"] },
            ],
          }),
        }),
      ),
    );
    await expect(canvas.getByText("Internal PR reviews")).toBeVisible();
  },
};
