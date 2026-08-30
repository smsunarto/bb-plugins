import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
  type ManagedProgramSpec,
} from "../lib/persistent-service.ts";

const program: ManagedProgramSpec = {
  command: ["/usr/bin/example", "serve", "--config", "/tmp/Agent Proxy/config.json"],
  environment: { ELECTRON_RUN_AS_NODE: "1" },
  workingDirectory: "/tmp/Agent Proxy",
  logPath: "/tmp/Agent Proxy/service.log",
  readinessUrl: () => "http://127.0.0.1:8123/",
};

test("renders any managed command in launchd and systemd definitions", () => {
  const launchd = renderLaunchAgentPlist({ label: "com.example.service", program });
  assert.match(launchd, /<string>\/usr\/bin\/example<\/string>/);
  assert.match(launchd, /<string>serve<\/string>/);
  assert.match(launchd, /<string>--config<\/string>/);
  assert.match(launchd, /<string>\/tmp\/Agent Proxy\/config\.json<\/string>/);
  assert.match(launchd, /<string>\/tmp\/Agent Proxy<\/string>/);
  assert.match(launchd, /<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);

  const systemd = renderSystemdUserUnit({ label: "com.example.service", program });
  assert.match(
    systemd,
    /ExecStart="\/usr\/bin\/example" "serve" "--config" "\/tmp\/Agent Proxy\/config\.json"/,
  );
  assert.match(systemd, /^WorkingDirectory=\/tmp\/Agent Proxy$/m);
  assert.match(systemd, /^Environment="ELECTRON_RUN_AS_NODE=1"$/m);
});
