#!/usr/bin/env node
import "dotenv/config";
import { render } from "ink";
import React from "react";
import { getApiKey } from "./config.js";
import { getVersion } from "./version.js";
import { runOnboarding } from "./onboarding.js";
import { Repl } from "./repl.js";

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

  const { waitUntilExit } = render(
    <Repl
      apiKey={apiKey}
      cwd={process.cwd()}
      onQuit={() => process.exit(0)}
    />
  );
  await waitUntilExit();
}

main();
