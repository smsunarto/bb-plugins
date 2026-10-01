/**
 * Desktop and headless-server discovery (design §2.3 C). bb registers the tools
 * and the loopback client never discovers anything, so agent-client's
 * `connectReviewInstance` is never called. Every export throws if it is.
 */
type Discovery = { url: string; token: string };
type Selection = { key: string; discovery?: Discovery };

function unavailable(name: string): never {
  throw new Error(`whiteboard: ${name} is unavailable in bb`);
}

export function reviewServerStateDir(_env?: NodeJS.ProcessEnv): string {
  return unavailable("reviewServerStateDir");
}

export async function readReviewServerDiscovery(_stateDir: string): Promise<Discovery | null> {
  return unavailable("readReviewServerDiscovery");
}

export async function reviewServerIsHealthy(_discovery: Discovery): Promise<boolean> {
  return unavailable("reviewServerIsHealthy");
}

export function serverNotReady(_stateDir: string): Error {
  return unavailable("serverNotReady");
}

export async function selectReviewInstance(_input: {
  env?: NodeJS.ProcessEnv;
}): Promise<Selection> {
  return unavailable("selectReviewInstance");
}

export function healthyReviewInstance(_selection: Selection): Discovery | undefined {
  return unavailable("healthyReviewInstance");
}

export function reviewInstanceUnavailable(_selection: Selection): Error {
  return unavailable("reviewInstanceUnavailable");
}
