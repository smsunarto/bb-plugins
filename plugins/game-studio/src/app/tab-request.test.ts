import { expect, test } from "bun:test";
import { createTabRequests } from "./tab-request.ts";

test("only the panel whose params name the game takes its request", () => {
  const requests = createTabRequests<"unity" | "evidence">();
  requests.request("reef", "evidence");
  expect(requests.take(undefined)).toBeNull();
  expect(requests.take("kart")).toBeNull();
  expect(requests.take("reef")).toEqual({ gameId: "reef", tab: "evidence" });
  expect(requests.take("reef")).toBeNull();
});

test("a later open without a tab clears a request nobody took", () => {
  const requests = createTabRequests<"unity" | "evidence">();
  requests.request("reef", "evidence");
  requests.request("reef", undefined);
  expect(requests.peek("reef")).toBeNull();
});

test("subscribers hear each request", () => {
  const requests = createTabRequests<"unity" | "evidence">();
  let heard = 0;
  const stop = requests.subscribe(() => heard++);
  requests.request("reef", "unity");
  stop();
  requests.request("reef", "evidence");
  expect(heard).toBe(1);
});
