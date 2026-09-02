import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { completeCodexInference } from "./host/inference/chatgpt-client.ts";
import { toAiServiceFailure } from "./host/inference/failure.ts";
import { parseGitButlerBranchSummary } from "./lib/gitbutler.ts";
import {
  GTD_SIDEBAR_AI_SERVICE_ID,
  gtdSidebarHostContract,
  type GtdSidebarAiInferenceCompleteOutput,
  type GtdSidebarAiVoiceTranscribeOutput,
} from "./lib/host-contract.ts";

const execFileAsync = promisify(execFile);

export default experimental_defineHostEntry({
  contract: gtdSidebarHostContract,
  handlers: {
    async branchSummary({ cwd }, context) {
      try {
        const { stdout } = await execFileAsync("but", ["status", "--json"], {
          cwd,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          signal: context.signal,
          timeout: 5_000,
        });
        return { label: parseGitButlerBranchSummary(stdout)?.label ?? null };
      } catch {
        // A regular repository, a host without `but`, and a stopped GitButler
        // project all keep bb's own branch label. This probe is an enhancement.
        return { label: null };
      }
    },
    "ai.inference.complete": async (input): Promise<GtdSidebarAiInferenceCompleteOutput> => {
      if (input.serviceId !== GTD_SIDEBAR_AI_SERVICE_ID) {
        return {
          ok: false,
          code: "request_failed",
          message: `This plugin serves no AI service "${input.serviceId}".`,
        };
      }
      try {
        return await completeCodexInference(input);
      } catch (error) {
        return toAiServiceFailure(error);
      }
    },
    "ai.voice.transcribe": async (): Promise<GtdSidebarAiVoiceTranscribeOutput> => ({
      ok: false,
      code: "request_failed",
      message: "GTD Sidebar provides inference only.",
    }),
  },
});
