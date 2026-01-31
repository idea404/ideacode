import { getBraveSearchApiKey } from "../config.js";
import { readFile, writeFile, editFile } from "./file.js";
import { globFiles, grepFiles } from "./search.js";
import { runBash } from "./bash.js";
import { webFetch, webSearch } from "./web.js";
import type { ToolArgs, ToolDef } from "./types.js";

export const TOOLS: Record<string, ToolDef> = {
  read: [
    "Read file with line numbers (file path, not directory). Use limit and offset to read a portion; avoid reading huge files in one go. Long output is truncated; use offset/limit to get more.",
    { path: "string", offset: "number?", limit: "number?" },
    readFile,
  ],
  write: ["Write content to file", { path: "string", content: "string" }, writeFile],
  edit: [
    "Replace old with new in file (old must be unique unless all=true)",
    { path: "string", old: "string", new: "string", all: "boolean?" },
    editFile,
  ],
  glob: [
    "Find files by pattern, sorted by mtime. With path '.' (default), .gitignore entries (e.g. node_modules, dist) are excluded; use path node_modules/<pkg> to search inside a single package.",
    { pat: "string", path: "string?" },
    globFiles,
  ],
  grep: [
    "Search files for regex. Prefer specific patterns and narrow path; search for the most recent or relevant occurrence by keyword. With path '.' (default), .gitignore entries are excluded; use path node_modules/<pkg> to search one package. Returns at most limit matches (default 50, max 100). Long output is truncated.",
    { pat: "string", path: "string?", limit: "number?" },
    grepFiles,
  ],
  bash: [
    "Run shell command. Use for things the other tools don't cover (e.g. running tests, installs, one-off commands, ephemeral << PY scripts, etc.). Always avoid dump outputs. Prefer read/grep/glob for file content and search; use targeted commands and avoid dumping huge output.",
    { cmd: "string" },
    runBash,
  ],
  web_fetch: [
    "Fetch a URL and return the main text content (handles JS-rendered pages). Use for docs, raw GitHub, any web page.",
    { url: "string" },
    webFetch,
  ],
  web_search: [
    "Search the web and return ranked results (title, url, snippet). Use for current info, docs, GitHub repos.",
    { query: "string" },
    webSearch,
  ],
};

function getTools(): Record<string, ToolDef> {
  const braveKey = getBraveSearchApiKey();
  if (braveKey) return TOOLS;
  const { web_search: _, ...rest } = TOOLS;
  return rest;
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export async function runTool(name: string, args: ToolArgs): Promise<string> {
  const canonical = normalizeToolName(name);
  if (canonical === "web_search" && !getBraveSearchApiKey()) {
    return "error: Brave Search API key not set. Use /brave or set BRAVE_API_KEY to enable web search.";
  }
  const tools = getTools();
  const def = tools[canonical];
  if (!def) return `error: Unknown tool: ${canonical}`;
  try {
    const result = await def[2](args);
    return result;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : err}`;
  }
}

export function makeSchema(): Array<{
  name: string;
  description: string;
  input_schema: { type: string; properties: Record<string, { type: string }>; required: string[] };
}> {
  return Object.entries(getTools()).map(([name, [description, params]]) => {
    const properties: Record<string, { type: string }> = {};
    const required: string[] = [];
    for (const [paramName, paramType] of Object.entries(params)) {
      const isOptional = paramType.endsWith("?");
      const baseType = paramType.replace(/\?$/, "");
      properties[paramName] = { type: baseType === "number" ? "integer" : baseType };
      if (!isOptional) required.push(paramName);
    }
    return {
      name,
      description,
      input_schema: { type: "object", properties, required },
    };
  });
}
