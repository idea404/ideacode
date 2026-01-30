# ideacode

CLI TUI for interfacing with AI agents via OpenRouter. Agentic loop with tool use, conversation history, and markdown output.

## Setup

```bash
npm install
```

`npm install` runs `playwright install chromium` automatically (for **web_fetch** on JS-rendered pages). If you skipped install scripts or see "Executable doesn't exist", run `npx playwright install chromium` once.

## Usage

```bash
npm run run
# or after build: npm run build && npm start
```

On first run, you'll be prompted for your OpenRouter API key. Get one at [openrouter.ai/keys](https://openrouter.ai/keys). You can optionally add a Brave Search API key for web search (get one at [brave.com/search/api](https://brave.com/search/api), free tier: 2,000 queries/month). Both are saved to:

- **macOS/Linux:** `~/.config/ideacode/config.json`
- **Windows:** `%LOCALAPPDATA%\ideacode\config.json`

### Environment (optional)

- `OPENROUTER_API_KEY` — API key (skips onboarding if set)
- `MODEL` — Model ID (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-4o`)
- `BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY` — Brave Search API key (enables web_search tool)

## Commands

- **Ctrl+P** — Open command palette (switch model, set Brave key, etc.)
- **Type `/`** — Inline command suggestions with descriptions (arrow keys to select, Enter to run)
- `/` or `/palette` — Same as Ctrl+P (open command palette)
- `/models` — Switch model (opens model selector)
- `/brave` — Set Brave Search API key (enables web_search)
- `/c` or `/clear` — Clear conversation
- `/q` or `exit` — Quit

## Tools

`read`, `write`, `edit`, `glob`, `grep`, `bash`. Plus:

- **web_fetch** — Fetch a URL and return main text. Tries plain `fetch()` first (works for raw GitHub, static HTML, APIs); falls back to Playwright for JS-rendered pages.
- **web_search** — Search the web via [Brave Search API](https://brave.com/search/api). Only available when a Brave API key is set (onboarding or `/brave`). Without a key, the agent is not offered this tool.

**web_fetch** uses Chromium for JS-rendered pages; it is installed automatically via postinstall. If you see "Executable doesn't exist", run `npx playwright install chromium` in the project directory.

## Terminal UI

The REPL uses **Ink** (React for the terminal) with a custom input: full-screen takeover, message log in a fixed viewport, hint row above input, slash/at suggestions above input. Run in an **interactive terminal** (real TTY); piping stdin or non-TTY may show "Raw mode is not supported".

## Project structure

- `src/index.tsx` — Entry: config/onboarding, then renders REPL
- `src/Repl.tsx` — Main UI: input, log, suggestions, modals, API loop
- `src/api.ts` — OpenRouter API (models, chat with tools)
- `src/config.ts` — API key and model (env + `~/.config/ideacode/config.json`)
- `src/commands.ts` — Slash commands and palette
- `src/onboarding.ts` — First-run API key prompt
- `src/tools/` — Agent tools (read, write, grep, bash, web_fetch, web_search, …)
- `src/ui/` — Formatting and theme (markdown, colors, boxes)
