#!/usr/bin/env node
import "dotenv/config";
import { writeSync } from "node:fs";
import { render } from "ink";
import React from "react";
import { getApiKey } from "./config.js";
import { getVersion } from "./version.js";
import { runOnboarding } from "./onboarding.js";
import { Repl } from "./repl.js";

const TERMINAL_RESTORE_SEQ =
  "\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?2004l\x1b[?1004l\x1b[?1007l\x1b[?1015l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[0m";

function restoreTerminalState(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    if (process.stdout.isTTY) {
      writeSync(process.stdout.fd, TERMINAL_RESTORE_SEQ);
    }
  } catch {
    // Ignore restore failures during process teardown.
  }
}

process.on("exit", restoreTerminalState);
process.on("SIGINT", () => {
  restoreTerminalState();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreTerminalState();
  process.exit(143);
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-v") || args.includes("--version")) {
    console.log(getVersion());
    process.exit(0);
  }

  let apiKey = getApiKey();
  if (!apiKey) {
    await runOnboarding();
    apiKey = getApiKey();
  }
  if (!apiKey) {
    process.exit(1);
  }

  let app: ReturnType<typeof render>;
  app = render(
    <Repl
      apiKey={apiKey}
      cwd={process.cwd()}
      onQuit={() => app.unmount()}
    />
  );
  await app.waitUntilExit();
}

main();
