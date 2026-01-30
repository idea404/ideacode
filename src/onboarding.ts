import * as readline from "node:readline";
import ora from "ora";
import { fetchModels } from "./api.js";
import { saveApiKey, saveModel, saveBraveSearchApiKey } from "./config.js";
import { colors } from "./ui/index.js";

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runOnboarding(): Promise<{ apiKey: string; model: string }> {
  console.log(
    colors.accent("\n  OpenRouter API key required\n") +
      colors.muted("  Get one at https://openrouter.ai/keys\n")
  );

  for (;;) {
    const apiKey = await question(colors.accent("  API key: "));
    if (!apiKey) {
      console.log(colors.error("  Key cannot be empty. Try again.\n"));
      continue;
    }

    const spinner = ora({
      text: colors.muted("  Validating..."),
      color: "green",
    }).start();

    try {
      const models = await fetchModels(apiKey);
      spinner.stop();
      saveApiKey(apiKey);

      const defaultId =
        models.find((m) => m.id === "anthropic/claude-sonnet-4")?.id ??
        models.find((m) => m.id.includes("claude-sonnet"))?.id ??
        models.find((m) => m.id.includes("gpt-4o"))?.id ??
        models[0]?.id ??
        "anthropic/claude-sonnet-4";

      console.log(
        colors.success("\n  ✓ API key saved") +
          colors.muted(` (${models.length} models available)\n`)
      );
      console.log(colors.muted("  Default model: ") + colors.accent(defaultId) + "\n");
      console.log(colors.muted("  In session: type / for commands, Ctrl+C or /q to quit.\n"));

      const choice = await question(
        colors.muted("  Use this model? [Y/n] or enter model id: ")
      );
      const model =
        choice === "" || choice.toLowerCase() === "y" || choice.toLowerCase() === "yes"
          ? defaultId
          : choice || defaultId;
      saveModel(model);

      console.log(
        colors.muted("  Brave Search API key (optional, for web search). Get one at https://brave.com/search/api")
      );
      const braveKey = await question(colors.muted("  Brave key (Enter to skip): "));
      if (braveKey.trim()) saveBraveSearchApiKey(braveKey.trim());

      return { apiKey, model };
    } catch (err) {
      spinner.stop();
      console.log(
        colors.error(`  Invalid key: ${err instanceof Error ? err.message : err}\n`)
      );
    }
  }
}
