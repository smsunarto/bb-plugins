import {
  operationMutationOptions,
  operationQueryOptions,
  type OperationRpcClientFor,
  type QueryClient,
} from "@smsunarto/bb-kit/query";
import { dotfilesOperations } from "./generated/operations.js";

type DotfilesRpcClient = OperationRpcClientFor<typeof dotfilesOperations>;

export const dotfilesKeys = {
  overview: ["dotfiles", "overview"] as const,
  file: (path: string) => ["dotfiles", "file", path] as const,
};

export function overviewQueryOptions(rpc: DotfilesRpcClient) {
  return operationQueryOptions({
    rpc,
    operation: dotfilesOperations.overview,
    input: null,
    queryKey: dotfilesKeys.overview,
  });
}

export function fileQueryOptions(rpc: DotfilesRpcClient, path: string) {
  return operationQueryOptions({
    rpc,
    operation: dotfilesOperations.readFile,
    input: { path },
    queryKey: dotfilesKeys.file(path),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function saveFileMutationOptions(
  rpc: DotfilesRpcClient,
  queryClient: QueryClient,
) {
  return operationMutationOptions({
    rpc,
    operation: dotfilesOperations.saveFile,
    queryClient,
    invalidate: () => [dotfilesKeys.overview],
  });
}

export function runTaskMutationOptions(
  rpc: DotfilesRpcClient,
  queryClient: QueryClient,
) {
  return operationMutationOptions({
    rpc,
    operation: dotfilesOperations.runTask,
    queryClient,
    invalidate: () => [dotfilesKeys.overview],
  });
}

export function publishMutationOptions(
  rpc: DotfilesRpcClient,
  queryClient: QueryClient,
) {
  return operationMutationOptions({
    rpc,
    operation: dotfilesOperations.publish,
    queryClient,
    invalidate: () => [dotfilesKeys.overview],
  });
}

export function removeSkillMutationOptions(
  rpc: DotfilesRpcClient,
  queryClient: QueryClient,
) {
  return operationMutationOptions({
    rpc,
    operation: dotfilesOperations.removeSkill,
    queryClient,
    invalidate: () => [dotfilesKeys.overview],
  });
}
