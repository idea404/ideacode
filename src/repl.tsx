/**
 * Main REPL UI: input, log viewport, slash/@ suggestions, modals (model picker, palette), API loop and tool dispatch.
 */
import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { Key } from "ink";
import { globSync } from "glob";
import * as path from "node:path";
import { writeSync } from "node:fs";
import gradient from "gradient-string";

// Custom matcha-themed gradient: matcha green → dark sepia
const matchaGradient = gradient(["#7F9A65", "#5C4033"]);
import {
  getModel,
  saveModel,
  saveBraveSearchApiKey,
  getBraveSearchApiKey,
  saveSearxngUrl,
  getStoredSearxngUrl,
  getSearxngUrl,
  saveActiveChatId,
  getOpenAiCompatProviders,
  upsertOpenAiCompatProvider,
  removeOpenAiCompatProvider,
  type OpenAiCompatProvider,
} from "./config.js";
import {
  createNewChat,
  forkChat,
  deleteChatFile,
  firstUserTextSnippet,
  formatChatRelativeTime,
  listChatSummaries,
  loadChatRecord,
  resolveActiveChatIdOnStartup,
  saveChatMessages,
  saveChatRecord,
  type ChatRecord,
  type ChatSummary,
} from "./chats.js";
import type { ContentBlock, OpenRouterModel } from "./api.js";
import {
  callApi,
  fetchAllModels,
  fetchKeyCreditsRemaining,
  maybeMigrateOaicModelId,
  normalizeOpenAiBaseUrl,
  parseOaicModelId,
  resolveOaicProvider,
  type CallApiRoute,
  type SummarizeRoute,
} from "./api.js";
import { getVersion, checkForUpdate } from "./version.js";
import {
  estimateTokens,
  estimateTokensForString,
  ensureUnderBudget,
  compressConversationToTargetBudget,
  manualCompressTargetMaxTokens,
  sanitizeMessagesForApi,
} from "./context.js";
import { runTool } from "./tools/index.js";
import { COMMANDS, matchCommand, resolveSlashCommand } from "./commands.js";
import {
  colors,
  icons,
  separator,
  agentMessage,
  toolCallBox,
  toolResultLine,
  toolResultTokenLine,
  userPromptBox,
  inkColors,
  expandLogLinesToVisual,
} from "./ui/index.js";

function wordStartBackward(value: string, cursor: number): number {
  let i = cursor - 1;
  while (i >= 0 && /\s/.test(value[i]!)) i--;
  while (i >= 0 && /[\w]/.test(value[i]!)) i--;
  return i + 1;
}

function wordEndForward(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && !/[\w]/.test(value[i]!)) i++;
  while (i < value.length && /[\w]/.test(value[i]!)) i++;
  return i;
}

/** Split a string into log rows; mirrors appendLog newline handling. */
function splitLogLines(line: string): string[] {
  const lines = line.split("\n");
  if (lines.length > 1 && lines[0] === "") lines.shift();
  return lines;
}

const CONTEXT_WINDOW_K = 128;
const MAX_TOOL_RESULT_CHARS = 3500;
const MAX_AT_SUGGESTIONS = 12;
const INITIAL_BANNER_LINES = 12;
const ENABLE_PARALLEL_TOOL_CALLS = process.env.IDEACODE_PARALLEL_TOOL_CALLS !== "0";
const PARALLEL_SAFE_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "bash_status",
  "bash_logs",
]);
const LOADING_TICK_MS = 80;
const MAX_EMPTY_ASSISTANT_RETRIES = 3;
const TYPING_LAYOUT_FREEZE_MS = 120;

function resolveLlmTargets(
  apiKey: string,
  currentModel: string,
  providers: OpenAiCompatProvider[]
): { callRoute: CallApiRoute; summarizeRoute: SummarizeRoute; requestModel: string } {
  const oaic = parseOaicModelId(currentModel);
  if (oaic) {
    const p = resolveOaicProvider(providers, oaic.providerKey);
    if (!p) {
      throw new Error(
        "This model uses a custom provider that is no longer configured. Use /models to pick another model or /new-provider to add the endpoint again."
      );
    }
    const baseUrl = normalizeOpenAiBaseUrl(p.baseUrl);
    return {
      callRoute: { kind: "oaic", baseUrl, apiKey: p.apiKey },
      summarizeRoute: { kind: "oaic", baseUrl, apiKey: p.apiKey },
      requestModel: oaic.openAiModelId,
    };
  }
  return {
    callRoute: { kind: "openrouter", apiKey },
    summarizeRoute: { kind: "openrouter", apiKey },
    requestModel: currentModel,
  };
}

type InputDraft = { value: string; cursor: number };
const SLASH_SUGGESTION_ROWS = Math.max(1, COMMANDS.length);

/** Normalizes pasted Windows / old-Mac line endings so multiline prompts round-trip. */
function normalizeSubmittedInput(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

const TRUNCATE_NOTE =
  "\n\n(Output truncated to save context. Use read with offset/limit, grep with a specific pattern, or tail with fewer lines to get more.)";

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return content.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATE_NOTE;
}

function listFilesWithFilter(cwd: string, filter: string): string[] {
  try {
    const pattern = path.join(cwd, "**", "*").replace(/\\/g, "/");
    const files = globSync(pattern, { cwd, nodir: true, dot: true });
    const rel = files.map((f) => path.relative(cwd, f).replace(/\\/g, "/"));
    const f = filter.toLowerCase();
    if (!f) return rel.slice(0, MAX_AT_SUGGESTIONS);
    return rel.filter((p) => p.toLowerCase().includes(f)).slice(0, MAX_AT_SUGGESTIONS);
  } catch {
    return [];
  }
}

type InputSegment = { type: "normal" | "path"; text: string };
type PlannedToolCall = {
  block: ContentBlock;
  toolName: string;
  toolArgs: Record<string, string | number | boolean | undefined>;
  argPreview: string;
};

function stripHeredocBodies(cmdRaw: string): string {
  const lines = cmdRaw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    out.push(line);
    const markerMatch = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!markerMatch) {
      i += 1;
      continue;
    }
    const marker = markerMatch[2] ?? "";
    i += 1;
    while (i < lines.length) {
      const bodyLine = lines[i] ?? "";
      if (bodyLine.trim() === marker) {
        out.push(bodyLine);
        break;
      }
      i += 1;
    }
    i += 1;
  }
  return out.join("\n");
}

function summarizeBashCommand(cmdRaw: string): string {
  const sanitized = stripHeredocBodies(cmdRaw);
  const parts = sanitized
    .split(/\n|&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const skipTokens = new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "do",
    "done",
    "case",
    "esac",
    "in",
    "function",
    "{",
    "}",
    "(",
    ")",
  ]);
  const commands: string[] = [];
  for (const part of parts) {
    let s = part.replace(/^\(+/, "").trim();
    if (!s || s.toUpperCase() === "EOF") continue;
    // Strip simple environment assignments at the front: FOO=bar CMD
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
      const idx = s.indexOf(" ");
      if (idx === -1) {
        s = "";
        break;
      }
      s = s.slice(idx + 1).trim();
    }
    if (!s) continue;
    const token = (s.split(/\s+/)[0] ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
    if (!/^[A-Za-z0-9_./-]+$/.test(token)) continue;
    if (skipTokens.has(token)) continue;
    if (token === "echo") continue;
    if (token === "cat" && /<<\s*['"]?EOF/i.test(s)) continue;
    if (!commands.includes(token)) commands.push(token);
  }
  if (commands.length === 0) return "bash";
  const shown = commands.slice(0, 5);
  const suffix = commands.length > 5 ? `, +${commands.length - 5}` : "";
  return (shown.join(", ") + suffix).slice(0, 140);
}

function toolArgPreview(
  toolName: string,
  toolArgs: Record<string, string | number | boolean | undefined>
): string {
  if (toolName === "bash" || toolName === "bash_detach") {
    const cmd = String(toolArgs.cmd ?? "").trim();
    return cmd ? summarizeBashCommand(cmd) : "—";
  }
  if ("path" in toolArgs && typeof toolArgs.path === "string") {
    return toolArgs.path.slice(0, 140) || "—";
  }
  const firstVal = Object.values(toolArgs)[0];
  return String(firstVal ?? "").slice(0, 140) || "—";
}

function parseEditDelta(result: string): { added: number; removed: number } | undefined {
  const both = result.match(/ok\s*\(\+(\d+)\s*-(\d+)\)/i);
  if (both) {
    return { added: Number.parseInt(both[1] ?? "0", 10), removed: Number.parseInt(both[2] ?? "0", 10) };
  }
  const addOnly = result.match(/ok\s*\(\+(\d+)\)/i);
  if (addOnly) {
    return { added: Number.parseInt(addOnly[1] ?? "0", 10), removed: 0 };
  }
  return undefined;
}

function parseAtSegments(value: string): InputSegment[] {
  const segments: InputSegment[] = [];
  let pos = 0;
  while (pos < value.length) {
    const at = value.indexOf("@", pos);
    if (at === -1) {
      segments.push({ type: "normal", text: value.slice(pos) });
      break;
    }
    segments.push({ type: "normal", text: value.slice(pos, at) });
    let end = at + 1;
    while (end < value.length && value[end] !== " " && value[end] !== "\n") end++;
    segments.push({ type: "path", text: value.slice(at, end) });
    pos = end;
  }
  return segments;
}

const PROMPT_INDENT_LEN = 2;

function wrapLine(line: string, width: number): string[] {
  if (width < 1) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    out.push(line.slice(i, i + width));
  }
  return out.length > 0 ? out : [""];
}

/** Inverse block at cursor (static — no interval re-renders; avoids idle TUI flicker). */
const InputCaret = React.memo(function InputCaret({
  char,
  color,
  bold,
}: {
  char: string;
  color?: string;
  bold?: boolean;
}) {
  return (
    <Text inverse color={color} bold={bold}>
      {char}
    </Text>
  );
});

function replayMessagesToLogLines(
  messages: Array<{ role: string; content: unknown }>
): string[] {
  const sanitizePrompt = (value: string): string =>
    value
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim();
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const prompt = sanitizePrompt(msg.content);
        if (!prompt) continue;
        lines.push("", ...userPromptBox(prompt).split("\n"), "");
      } else if (Array.isArray(msg.content)) {
        const prev = messages[i - 1];
        const toolResults = msg.content as Array<{ tool_use_id?: string; content?: string }>;
        if (prev?.role === "assistant" && Array.isArray(prev.content)) {
          const blocks = prev.content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
          const toolUses = blocks.filter((b) => b.type === "tool_use");
          for (const tr of toolResults) {
            const block = toolUses.find((b) => b.id === tr.tool_use_id);
            if (block?.name) {
              const name = block.name.trim().toLowerCase();
              const args =
                block.input && typeof block.input === "object"
                  ? (block.input as Record<string, string | number | boolean | undefined>)
                  : {};
              const argPreview = toolArgPreview(name, args).slice(0, 60);
              const content = tr.content ?? "";
              const ok = !content.startsWith("error:");
              lines.push(
                toolCallBox(
                  name,
                  argPreview,
                  ok,
                  0,
                  name === "edit" || name === "write" ? parseEditDelta(content) : undefined
                )
              );
              const tokens = estimateTokensForString(content);
              lines.push(toolResultTokenLine(tokens, ok));
            }
          }
        }
      }
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type?: string; text?: string }>;
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          if (lines[lines.length - 1] !== "") lines.push("");
          lines.push(...agentMessage(block.text).trimEnd().split("\n"));
        }
      }
    }
  }
  return lines;
}

type ReplProps = {
  apiKey: string;
  cwd: string;
  onQuit: (transcriptLines: string[]) => void;
};

function buildAgentSystemPrompt(cwd: string): string {
  return [
    `You are a concise coding assistant. cwd: ${cwd}. Use tools to ground answers in the repo and the web; do not guess when a quick read or fetch would settle it.`,
    `Repository: PRIORITIZE grep to locate symbols and paths; then read with offset and limit for only the relevant stretch. Do not read whole large files unless the user asks. Use focused patterns and narrow paths; for dependencies, scope to that package (e.g. node_modules/<pkg>). Prefer the most relevant occurrence, not huge tail dumps. If a result says it was truncated, call again with offset/limit or a tighter pattern.`,
    `Web: Prefer web_fetch for HTTP(S) URLs. read is for local disk paths; http(s) in read is a shortcut (same as web_fetch). If web_fetch or read returns an error: line or obviously thin content, change tactic once—e.g. web_search for another URL or a print/mobile variant—not the same failing call repeated.`,
    `Tools vs shell: Prefer grep, read, write, edit over bash when they fit the job (avoid !cat / !rg when those tools apply). Bash: no decorative echo headers; direct commands. Long-running work: bash_detach, then bash_status and bash_logs.`,
    `Parallelism: Use many parallel independent tool calls in one turn when useful (often >3 for broad research), but keep each call high-signal, non-redundant, and small in output.`,
    `Anti-loop: Before calling a tool, check recent turns. If you already used the same tool with the same arguments and the result was thin or duplicate, do not repeat—synthesize from what you have, try a materially different query or URL, or say what cannot be verified.`,
    `Unless the user clearly wants only a plan or discussion with no investigation, use tools to answer; do not replace missing evidence with a long speculative essay.`,
    `Keep assistant text brief (at most a sentence or two before tool rounds when needed).`,
  ].join("\n\n");
}

const IDENTICAL_ASSISTANT_TOOL_ROUNDS = 3;

/** Stable fingerprint of all tool_use blocks in one assistant message (order-independent for parallel batches). */
function assistantToolRoundSignature(m: { role: string; content: unknown }): string | null {
  if (m.role !== "assistant") return null;
  const c = m.content;
  if (!Array.isArray(c)) return null;
  const uses = c.filter(
    (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_use"
  ) as Array<{ name?: string; input?: Record<string, unknown> }>;
  if (uses.length === 0) return null;
  const parts = uses.map((u) => {
    const name = (u.name ?? "").trim().toLowerCase();
    const input = u.input ?? {};
    const keys = Object.keys(input).sort();
    const norm: Record<string, unknown> = {};
    for (const k of keys) norm[k] = input[k]!;
    return `${name}\0${JSON.stringify(norm)}`;
  });
  parts.sort();
  return parts.join("|");
}

/**
 * If the last N assistant tool rounds are identical, return a one-shot system nudge (perseveration on e.g. web_search).
 */
function identicalToolLoopNudge(
  state: Array<{ role: string; content: unknown }>
): string | undefined {
  const sigs: string[] = [];
  for (let i = state.length - 1; i >= 0 && sigs.length < IDENTICAL_ASSISTANT_TOOL_ROUNDS; i--) {
    if (state[i]!.role !== "assistant") continue;
    const sig = assistantToolRoundSignature(state[i]!);
    if (sig) sigs.push(sig);
  }
  if (sigs.length < IDENTICAL_ASSISTANT_TOOL_ROUNDS) return undefined;
  const [a, b, c] = sigs;
  if (a === b && b === c) {
    return `URGENT — The last ${IDENTICAL_ASSISTANT_TOOL_ROUNDS} assistant tool rounds used the exact same tool call(s). Do not repeat them. Stop searching with the same query. Either answer using evidence already in this conversation or change strategy (different keywords, web_fetch a specific URL, or explain what cannot be verified).`;
  }
  return undefined;
}

function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  }));
  useEffect(() => {
    if (!stdout?.isTTY) return;
    const onResize = () => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

const LogViewport = React.memo(function LogViewport({
  lines,
  startIndex,
  height,
  width,
}: {
  lines: string[];
  startIndex: number;
  height: number;
  width: number;
}) {
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {lines.map((line, i) => (
        <Box key={`log-${startIndex + i}`} width={width} flexShrink={0} overflow="hidden">
          <Text>{line === "" ? "\u00A0" : line}</Text>
        </Box>
      ))}
    </Box>
  );
});

function orbitDots(frame: number): string {
  const phase = frame % 6;
  const activeIndex = phase <= 3 ? phase : 6 - phase;
  const slots = ["·", "·", "·", "·"];
  slots[activeIndex] = "●";
  return slots
    .map((ch, i) => (i === activeIndex ? colors.gray(ch) : colors.mutedDark(ch)))
    .join("");
}

const BANNER_LOGO = `
  ██╗██████╗ ███████╗ █████╗  ██████╗ ██████╗ ██████╗ ███████╗
  ██║██╔══██╗██╔════╝██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██║██║  ██║█████╗  ███████║██║     ██║   ██║██║  ██║█████╗  
  ██║██║  ██║██╔══╝  ██╔══██║██║     ██║   ██║██║  ██║██╔══╝  
  ██║██████╔╝███████╗██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
`;

/** Strip only outer newlines — `.trim()` would eat the first line’s leading spaces after the opening `\n`. */
function trimBannerNewlines(s: string): string {
  return s.replace(/^\r?\n+/, "").replace(/\r?\n+$/, "");
}

/** One log row per line — Ink multi-line <Text> collapses leading spaces on rows after the first. */
function bannerLogoLines(): string[] {
  return matchaGradient(trimBannerNewlines(BANNER_LOGO)).split("\n");
}

export function Repl({ apiKey, cwd, onQuit }: ReplProps) {
  const { rows: termRows, columns: termColumns } = useTerminalSize();

  const initialChatBootstrapRef = useRef<{ id: string; record: ChatRecord } | null>(null);
  if (initialChatBootstrapRef.current === null) {
    initialChatBootstrapRef.current = resolveActiveChatIdOnStartup(cwd);
  }
  const chatBoot = initialChatBootstrapRef.current;

  const [activeChatId, setActiveChatId] = useState(() => chatBoot!.id);
  const activeChatIdRef = useRef(chatBoot!.id);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const [logLines, setLogLines] = useState<string[]>(() => {
    const model = getModel();
    const version = getVersion();
    const banner = [
      "",
      ...bannerLogoLines(),
      colors.accent(`  ideacode v${version}`) + colors.dim(" · ") + colors.accentPale(model) + colors.dim(" · ") + colors.bold("OpenRouter") + colors.dim(` · ${cwd}`),
      colors.mutedDark("  / commands  ! shell  @ files · Ctrl+P palette · Ctrl+C or /q to quit"),
      "",
    ];
    const loaded = chatBoot!.record.messages;
    if (loaded.length > 0) {
      return [...banner, ...replayMessagesToLogLines(loaded)];
    }
    return banner;
  });
  const logLinesRef = useRef(logLines);
  useEffect(() => {
    logLinesRef.current = logLines;
  }, [logLines]);
  const [inputDraft, setInputDraft] = useState<InputDraft>({ value: "", cursor: 0 });
  const [currentModel, setCurrentModel] = useState(getModel);
  const [messages, setMessages] = useState<Array<{ role: string; content: unknown }>>(
    () => chatBoot!.record.messages
  );
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushChatSave = useCallback(() => {
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    const id = activeChatIdRef.current;
    saveChatMessages(id, messagesRef.current, loadChatRecord(id), cwd);
  }, [cwd]);

  useEffect(() => {
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(() => {
      saveDebounceRef.current = null;
      const id = activeChatIdRef.current;
      saveChatMessages(id, messages, loadChatRecord(id), cwd);
    }, 500);
    return () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    };
  }, [messages, cwd]);

  const handleQuit = useCallback(() => {
    flushChatSave();
    // Best-effort terminal mode reset in case process exits before React cleanup runs.
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      if (process.stdout.isTTY) {
        writeSync(
          process.stdout.fd,
          "\x1b[?2004l\x1b[?1004l\x1b[?1007l\x1b[?1015l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[0m"
        );
      }
    } catch {
      // Ignore restore failures during teardown.
    }
    onQuit(logLinesRef.current);
  }, [flushChatSave, onQuit]);

  const [loading, setLoading] = useState(false);
  const [keyCreditsFooter, setKeyCreditsFooter] = useState("…");
  const [loadingLabel, setLoadingLabel] = useState("Thinking…");
  const loadingActiveRef = useRef(false);
  const loadingLabelRef = useRef(loadingLabel);
  const loadingFooterLinesRef = useRef(2);
  const loadingRenderRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [modelList, setModelList] = useState<OpenRouterModel[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [modelSearchFilter, setModelSearchFilter] = useState("");
  const [showBraveKeyModal, setShowBraveKeyModal] = useState(false);
  const [braveKeyInput, setBraveKeyInput] = useState("");
  const [showSearxngModal, setShowSearxngModal] = useState(false);
  const [searxngInput, setSearxngInput] = useState("");
  const [oaicProviders, setOaicProviders] = useState<OpenAiCompatProvider[]>(getOpenAiCompatProviders);
  const [showProviderWizardModal, setShowProviderWizardModal] = useState(false);
  const [providerWizardStep, setProviderWizardStep] = useState(0);
  const [providerWizardUrl, setProviderWizardUrl] = useState("");
  const [providerWizardName, setProviderWizardName] = useState("");
  const [providerWizardKey, setProviderWizardKey] = useState("");
  const [showProviderRemoveModal, setShowProviderRemoveModal] = useState(false);
  const [providerRemoveIndex, setProviderRemoveIndex] = useState(0);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0);
  const inputDraftRef = useRef(inputDraft);
  const [layoutInputLineCount, setLayoutInputLineCount] = useState(1);
  const shrinkLineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isInputLayoutFrozen, setIsInputLayoutFrozen] = useState(false);
  const [frozenFooterLines, setFrozenFooterLines] = useState(2);
  const skipNextSubmitRef = useRef(false);
  const queuedMessageRef = useRef<string | null>(null);
  const lastUserMessageRef = useRef<string>("");
  const [logScrollOffset, setLogScrollOffset] = useState(0);

  const applyChatRecord = useCallback(
    (record: ChatRecord, resetScroll = true) => {
      flushChatSave();
      activeChatIdRef.current = record.id;
      saveActiveChatId(record.id);
      setActiveChatId(record.id);
      setMessages(record.messages);
      const model = getModel();
      const version = getVersion();
      const banner = [
        "",
        ...bannerLogoLines(),
        colors.accent(`  ideacode v${version}`) + colors.dim(" · ") + colors.accentPale(model) + colors.dim(" · ") + colors.bold("OpenRouter") + colors.dim(` · ${cwd}`),
        colors.mutedDark("  / commands  ! shell  @ files · Ctrl+P palette · Ctrl+C or /q to quit"),
        "",
      ];
      setLogLines(
        record.messages.length > 0 ? [...banner, ...replayMessagesToLogLines(record.messages)] : banner
      );
      if (resetScroll) setLogScrollOffset(0);
    },
    [cwd, flushChatSave]
  );

  const [showChatSelector, setShowChatSelector] = useState(false);
  const [chatSummariesForPicker, setChatSummariesForPicker] = useState<ChatSummary[]>([]);
  const [chatPickerIndex, setChatPickerIndex] = useState(0);
  const [chatSearchFilter, setChatSearchFilter] = useState("");
  const [showRenameChatModal, setShowRenameChatModal] = useState(false);
  const [renameChatInput, setRenameChatInput] = useState("");

  const scrollBoundsRef = useRef({ maxLogScrollOffset: 0, logViewportHeight: 1 });
  /** One entry per terminal row after hard-wrapping (avoids Ink multi-row overlap in the log viewport). */
  const visualLogLines = useMemo(
    () => expandLogLinesToVisual(logLines, termColumns),
    [logLines, termColumns]
  );
  const prevEscRef = useRef(false);
  const typingFreezeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ink re-subscribes stdin whenever `useInput`'s callback identity changes; keep a stable wrapper. */
  const replStdinHandlerRef = useRef<(input: string, key: Key) => void>(() => {});
  const dispatchReplStdin = useCallback((input: string, key: Key) => {
    replStdinHandlerRef.current(input, key);
  }, []);

  useEffect(() => {
    // Enable SGR mouse + basic tracking so trackpad wheel scrolling works.
    process.stdout.write("\x1b[?1006h\x1b[?1000h\x1b[?12h");
    return () => {
      process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?12l");
    };
  }, []);

  useEffect(() => {
    loadingActiveRef.current = loading;
    loadingLabelRef.current = loadingLabel;
    if (!process.stdout.isTTY) return;

    const clearLoadingLine = () => {
      const up = Math.max(1, loadingFooterLinesRef.current);
      try {
        writeSync(process.stdout.fd, `\x1b7\x1b[${up}A\r\x1b[2K\x1b8`);
      } catch {
        // Best effort only.
      }
    };

    if (!loading) {
      if (loadingRenderRef.current) {
        clearInterval(loadingRenderRef.current);
        loadingRenderRef.current = null;
      }
      clearLoadingLine();
      return;
    }

    const startedAt = Date.now();
    let frame = 0;
    const renderTick = () => {
      if (!loadingActiveRef.current || !process.stdout.isTTY) return;
      const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
      const elapsedText =
        elapsedSeconds < 10 ? `${elapsedSeconds.toFixed(1)}s` : `${Math.floor(elapsedSeconds)}s`;
      const line = ` ${orbitDots(frame)} ${colors.gray(elapsedText)}`;
      const up = Math.max(1, loadingFooterLinesRef.current);
      try {
        writeSync(process.stdout.fd, `\x1b7\x1b[${up}A\r\x1b[2K${line}\x1b8`);
      } catch {
        // Best effort only.
      }
      frame = (frame + 1) % 6;
    };

    renderTick();
    loadingRenderRef.current = setInterval(renderTick, LOADING_TICK_MS);
    return () => {
      if (loadingRenderRef.current) {
        clearInterval(loadingRenderRef.current);
        loadingRenderRef.current = null;
      }
      clearLoadingLine();
    };
  }, [loading, loadingLabel]);

  const estimatedTokens = useMemo(() => estimateTokens(messages, undefined), [messages]);
  const contextWindowK = useMemo(() => {
    const ctx = modelList.find((m) => m.id === currentModel)?.context_length;
    return ctx != null ? Math.round(ctx / 1024) : CONTEXT_WINDOW_K;
  }, [modelList, currentModel]);
  const tokenDisplay = `${Math.round(estimatedTokens / 1000)}K / ${contextWindowK}K`;
  /** OpenRouter balance is N/A for local OpenAI-compatible endpoints. */
  const balanceFooterDisplay = useMemo(
    () => (parseOaicModelId(currentModel) ? "\u221E" : keyCreditsFooter),
    [currentModel, keyCreditsFooter]
  );

  const filteredModelList = useMemo(() => {
    const q = modelSearchFilter.trim().toLowerCase();
    if (!q) return modelList;
    return modelList.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q)
    );
  }, [modelList, modelSearchFilter]);

  const filteredChatList = useMemo(() => {
    const q = chatSearchFilter.trim().toLowerCase();
    if (!q) return chatSummariesForPicker;
    return chatSummariesForPicker.filter(
      (s) => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    );
  }, [chatSummariesForPicker, chatSearchFilter]);

  const wrapWidth = Math.max(10, termColumns - PROMPT_INDENT_LEN - 2);
  const inputLineCount = useMemo(() => {
    const lines = inputDraft.value.split("\n");
    return lines.reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / wrapWidth)),
      0
    );
  }, [inputDraft.value, wrapWidth]);
  useEffect(() => {
    if (inputLineCount >= layoutInputLineCount) {
      if (shrinkLineTimerRef.current) {
        clearTimeout(shrinkLineTimerRef.current);
        shrinkLineTimerRef.current = null;
      }
      setLayoutInputLineCount(inputLineCount);
      return;
    }
    if (shrinkLineTimerRef.current) {
      clearTimeout(shrinkLineTimerRef.current);
    }
    shrinkLineTimerRef.current = setTimeout(() => {
      setLayoutInputLineCount(inputLineCount);
      shrinkLineTimerRef.current = null;
    }, 120);
    return () => {
      if (shrinkLineTimerRef.current) {
        clearTimeout(shrinkLineTimerRef.current);
      }
    };
  }, [inputLineCount, layoutInputLineCount]);

  const applyInputDraft = useCallback((next: InputDraft) => {
    const clamped: InputDraft = {
      value: next.value,
      cursor: Math.max(0, Math.min(next.cursor, next.value.length)),
    };
    inputDraftRef.current = clamped;
    setInputDraft(clamped);
  }, []);

  const applyInputMutation = useCallback(
    (nextValue: string, nextCursor: number) => {
      applyInputDraft({ value: nextValue, cursor: nextCursor });
    },
    [applyInputDraft]
  );

  const clearInputDraft = useCallback(() => {
    const empty: InputDraft = { value: "", cursor: 0 };
    inputDraftRef.current = empty;
    setInputDraft(empty);
  }, []);

  const updateInputDraft = useCallback((fn: (prev: InputDraft) => InputDraft) => {
    setInputDraft((prev) => {
      const raw = fn(prev);
      const next: InputDraft = {
        value: raw.value,
        cursor: Math.max(0, Math.min(raw.cursor, raw.value.length)),
      };
      inputDraftRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (inputLineCount > layoutInputLineCount) {
      setIsInputLayoutFrozen(false);
      if (typingFreezeTimerRef.current) {
        clearTimeout(typingFreezeTimerRef.current);
        typingFreezeTimerRef.current = null;
      }
      return;
    }
    setIsInputLayoutFrozen(true);
    if (typingFreezeTimerRef.current) {
      clearTimeout(typingFreezeTimerRef.current);
    }
    typingFreezeTimerRef.current = setTimeout(() => {
      setIsInputLayoutFrozen(false);
      typingFreezeTimerRef.current = null;
    }, TYPING_LAYOUT_FREEZE_MS);
  }, [inputLineCount, layoutInputLineCount]);

  useEffect(() => {
    return () => {
      if (typingFreezeTimerRef.current) {
        clearTimeout(typingFreezeTimerRef.current);
        typingFreezeTimerRef.current = null;
      }
      if (shrinkLineTimerRef.current) {
        clearTimeout(shrinkLineTimerRef.current);
        shrinkLineTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setModelList(await fetchAllModels(apiKey, oaicProviders));
      } catch {
        setModelList([]);
      }
    })();
  }, [apiKey, oaicProviders]);

  const refreshKeyCredits = useCallback(async () => {
    if (!apiKey.trim()) {
      setKeyCreditsFooter("—");
      return;
    }
    const usd = await fetchKeyCreditsRemaining(apiKey);
    if (usd === null) {
      setKeyCreditsFooter("—");
      return;
    }
    setKeyCreditsFooter(
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(usd)
    );
  }, [apiKey]);

  useEffect(() => {
    void refreshKeyCredits();
  }, [refreshKeyCredits]);

  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      void refreshKeyCredits();
    }
    prevLoadingRef.current = loading;
  }, [loading, refreshKeyCredits]);

  useEffect(() => {
    if (showModelSelector) {
      setModelSearchFilter("");
      setModelIndex(0);
    }
  }, [showModelSelector]);

  useEffect(() => {
    if (showModelSelector && filteredModelList.length > 0)
      setModelIndex((i) => Math.min(i, filteredModelList.length - 1));
  }, [showModelSelector, filteredModelList.length]);

  useEffect(() => {
    if (showChatSelector) {
      setChatSearchFilter("");
      setChatPickerIndex(0);
    }
  }, [showChatSelector]);

  useEffect(() => {
    if (showProviderRemoveModal && oaicProviders.length > 0) {
      setProviderRemoveIndex((i) => Math.min(i, oaicProviders.length - 1));
    }
  }, [showProviderRemoveModal, oaicProviders.length]);

  useEffect(() => {
    const m = getModel();
    const next = maybeMigrateOaicModelId(m, oaicProviders);
    if (next !== m) {
      saveModel(next);
      setCurrentModel(next);
    }
  }, [oaicProviders]);

  useEffect(() => {
    if (showChatSelector && filteredChatList.length > 0) {
      setChatPickerIndex((i) => Math.min(i, filteredChatList.length - 1));
    }
  }, [showChatSelector, filteredChatList.length]);

  const showSlashSuggestions = inputDraft.value.startsWith("/");
  const filteredSlashCommands = useMemo(() => {
    const filter = inputDraft.value.slice(1).trim();
    return COMMANDS.filter((c) => matchCommand(filter, c));
  }, [inputDraft.value]);
  const clampedSlashIndex = Math.min(
    Math.max(0, slashSuggestionIndex),
    Math.max(0, filteredSlashCommands.length - 1)
  );
  useEffect(() => {
    setSlashSuggestionIndex(0);
  }, [inputDraft.value]);

  const lastAtIndex = inputDraft.value.lastIndexOf("@");
  const atPathEnd =
    lastAtIndex < 0
      ? -1
      : (() => {
          let end = lastAtIndex + 1;
          while (
            end < inputDraft.value.length &&
            inputDraft.value[end] !== " " &&
            inputDraft.value[end] !== "\n"
          )
            end++;
          return end;
        })();
  const cursorInAtSegment =
    lastAtIndex >= 0 &&
    inputDraft.cursor >= lastAtIndex &&
    inputDraft.cursor <= atPathEnd;
  const hasCharsAfterAt = atPathEnd > lastAtIndex + 1;
  const atFilter = cursorInAtSegment
    ? inputDraft.value.slice(lastAtIndex + 1, inputDraft.cursor)
    : "";
  const lastAtPath =
    lastAtIndex >= 0 && atPathEnd > lastAtIndex
      ? inputDraft.value.slice(lastAtIndex + 1, atPathEnd).trim()
      : "";
  const filteredFilePaths = useMemo(
    () => (cursorInAtSegment ? listFilesWithFilter(cwd, atFilter) : []),
    [cwd, cursorInAtSegment, atFilter]
  );
  const lastAtPathMatches = useMemo(
    () =>
      lastAtPath.length > 0 ? listFilesWithFilter(cwd, lastAtPath).includes(lastAtPath) : false,
    [cwd, lastAtPath]
  );
  const showAtSuggestions =
    cursorInAtSegment && hasCharsAfterAt && filteredFilePaths.length > 0;
  const [atSuggestionIndex, setAtSuggestionIndex] = useState(0);
  const clampedAtFileIndex = Math.min(
    Math.max(0, atSuggestionIndex),
    Math.max(0, filteredFilePaths.length - 1)
  );
  useEffect(() => {
    setAtSuggestionIndex(0);
  }, [atFilter]);

  const lastLogLineRef = useRef("");

  const appendLog = useCallback((line: string) => {
    const lines = splitLogLines(line);
    setLogLines((prev) => {
      const next = [...prev, ...lines];
      lastLogLineRef.current = next[next.length - 1] ?? "";
      return next;
    });
  }, []);

  /**
   * Status / feedback lines: insert a blank row above when the committed log’s last line has visible
   * content. Uses functional `setLogLines` so spacing is correct even if `lastLogLineRef` has not
   * flushed yet after the previous `appendLog`.
   */
  const appendNotifyLog = useCallback((line: string) => {
    const incoming = splitLogLines(line);
    setLogLines((prev) => {
      const lastRow = prev[prev.length - 1] ?? "";
      const spacerNeeded = lastRow.trim() !== "";
      const next = spacerNeeded ? [...prev, "", ...incoming] : [...prev, ...incoming];
      lastLogLineRef.current = next[next.length - 1] ?? "";
      return next;
    });
  }, []);

  useEffect(() => {
    const version = getVersion();
    checkForUpdate(version, (latest) => {
      appendNotifyLog(
        colors.warn(`  Update available: ideacode ${latest} (you have ${version}). Run: npm i -g ideacode`)
      );
      appendLog("");
    });
  }, [appendLog, appendNotifyLog]);

  /** Trimmed key shown when modal opened (env or file); used to detect real changes on Enter. */
  const braveKeyInitialRef = useRef("");
  /** True after user edits the Brave key field. */
  const braveKeyDirtyRef = useRef(false);

  const openBraveKeyModal = useCallback(() => {
    const initial = getBraveSearchApiKey()?.trim() ?? "";
    braveKeyInitialRef.current = initial;
    braveKeyDirtyRef.current = false;
    setBraveKeyInput(initial);
    setShowBraveKeyModal(true);
  }, []);

  const openSearxngModal = useCallback(() => {
    setSearxngInput(getStoredSearxngUrl() ?? "");
    setShowSearxngModal(true);
  }, []);

  const openHelpModal = useCallback(() => setShowHelpModal(true), []);

  const openModelSelector = useCallback(async () => {
    setShowPalette(false);
    try {
      setModelList(await fetchAllModels(apiKey, oaicProviders));
    } catch {
      // keep existing list
    }
    setModelIndex(0);
    setShowModelSelector(true);
  }, [apiKey, oaicProviders]);

  const openProviderWizard = useCallback(() => {
    setShowPalette(false);
    setProviderWizardStep(0);
    setProviderWizardUrl("");
    setProviderWizardName("");
    setProviderWizardKey("");
    setShowProviderWizardModal(true);
  }, []);

  const openProviderRemoveModalFn = useCallback(() => {
    setShowPalette(false);
    if (getOpenAiCompatProviders().length === 0) return;
    setProviderRemoveIndex(0);
    setShowProviderRemoveModal(true);
  }, []);

  const openChatSelector = useCallback(() => {
    setShowPalette(false);
    setShowModelSelector(false);
    setChatSummariesForPicker(listChatSummaries());
    setChatSearchFilter("");
    setChatPickerIndex(0);
    setShowChatSelector(true);
  }, []);

  const processInput = useCallback(
    async (value: string): Promise<boolean> => {
      const userInput = normalizeSubmittedInput(value);
      if (!userInput) return true;

      const isShellCommand = userInput[0] === "!" || userInput[0] === "\uFF01";
      if (isShellCommand) {
        const cmd = userInput.slice(1).trim();
        if (!cmd) return true;
        appendLog(separator());
        appendLog(colors.accent(icons.prompt) + " ! " + cmd);
        appendLog(separator());
        const output = await runTool("bash", { cmd });
        const maxShellOutput = 2000;
        const outPreview =
          output.length > maxShellOutput
            ? output.slice(0, maxShellOutput) + "\n... (" + (output.length - maxShellOutput) + " more chars)"
            : output;
        for (const line of outPreview.split("\n")) {
          appendLog(toolResultLine(line));
        }
        appendLog("");
        setMessages((prev) => [
          ...prev,
          { role: "user", content: userInput + "\n---\n" + output },
        ]);
        return true;
      }

      const { canonical, rest: slashRest } = resolveSlashCommand(userInput);
      if (canonical === "/q") return false;
      if (canonical === "/clear") {
        setMessages([]);
        setLogScrollOffset(0);
        const model = getModel();
        const version = getVersion();
        const banner = [
          "",
          ...bannerLogoLines(),
          colors.accent(`  ideacode v${version}`) + colors.dim(" · ") + colors.accentPale(model) + colors.dim(" · ") + colors.bold("OpenRouter") + colors.dim(` · ${cwd}`),
          colors.mutedDark("  / commands  ! shell  @ files · Ctrl+P palette · Ctrl+C or /q to quit"),
          "",
        ];
        setLogLines(banner);
        return true;
      }
      if (canonical === "/palette" || userInput === "/") {
        setShowPalette(true);
        return true;
      }
      if (canonical === "/models") {
        await openModelSelector();
        return true;
      }
      if (canonical === "/providers") {
        const list = getOpenAiCompatProviders();
        if (list.length === 0) {
          appendNotifyLog(
            colors.muted(
              "  No custom OpenAI-compatible providers. Use /new-provider to add one (expects GET/POST …/v1/models and …/v1/chat/completions)."
            )
          );
        } else {
          appendNotifyLog(colors.muted("  OpenAI-compatible providers:"));
          for (const p of list) {
            appendLog(
              colors.muted(`    · ${p.name}`) +
                colors.dim(`  oaic:${p.slug}/<model>  ·  ${p.baseUrl}`)
            );
          }
        }
        appendLog("");
        return true;
      }
      if (
        canonical === "/new-provider" ||
        canonical === "/add-provider" ||
        canonical === "/openai-provider"
      ) {
        openProviderWizard();
        return true;
      }
      if (canonical === "/remove-provider") {
        const list = getOpenAiCompatProviders();
        if (list.length === 0) {
          appendNotifyLog(colors.muted("  No custom providers. Use /new-provider to add one."));
          appendLog("");
          return true;
        }
        openProviderRemoveModalFn();
        return true;
      }
      if (canonical === "/chats") {
        openChatSelector();
        return true;
      }
      if (canonical === "/new") {
        const rec = createNewChat(cwd);
        applyChatRecord(rec);
        appendNotifyLog(colors.muted(`  Started new chat “${rec.title}”.`));
        appendLog("");
        return true;
      }
      if (canonical === "/fork") {
        flushChatSave();
        const parent = loadChatRecord(activeChatIdRef.current);
        try {
          const rec = forkChat(messagesRef.current, cwd, {
            customTitle: slashRest.trim() || undefined,
            sourceTitle: parent?.title,
          });
          applyChatRecord(rec);
          appendNotifyLog(
            colors.muted(
              `  Forked into new chat “${rec.title}” (${rec.messages.length} messages). Original chat is unchanged.`
            )
          );
          appendLog("");
        } catch (err) {
          appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
          appendLog("");
        }
        return true;
      }
      if (canonical === "/rename") {
        const rest = slashRest.trim();
        if (rest) {
          const id = activeChatIdRef.current;
          const prev = loadChatRecord(id);
          if (prev) {
            const title = rest.slice(0, 120);
            saveChatRecord({
              ...prev,
              title,
              titleManuallySet: true,
              updatedAt: new Date().toISOString(),
            });
          }
          appendNotifyLog(colors.muted(`  Chat title set to “${rest.slice(0, 120)}”.`));
          appendLog("");
          return true;
        }
        const cur = loadChatRecord(activeChatIdRef.current);
        setRenameChatInput(cur?.title ?? "");
        setShowRenameChatModal(true);
        return true;
      }
      if (canonical === "/delete") {
        const id = activeChatIdRef.current;
        flushChatSave();
        deleteChatFile(id);
        const rest = listChatSummaries();
        let nextRecord: ChatRecord;
        if (rest.length > 0) {
          const picked = rest[0]!;
          const rec = loadChatRecord(picked.id);
          nextRecord = rec ?? createNewChat(cwd);
        } else {
          nextRecord = createNewChat(cwd);
        }
        applyChatRecord(nextRecord);
        appendNotifyLog(colors.muted(`  Chat deleted. Now in “${nextRecord.title}”.`));
        appendLog("");
        return true;
      }
      if (canonical === "/searxng") {
        openSearxngModal();
        return true;
      }
      if (canonical === "/brave") {
        openBraveKeyModal();
        return true;
      }
      if (canonical === "/help") {
        openHelpModal();
        return true;
      }
      if (canonical === "/status") {
        const rec = loadChatRecord(activeChatIdRef.current);
        const title = rec?.title ?? "(unknown)";
        const shortId = activeChatIdRef.current.slice(0, 8);
        const searxEff = getSearxngUrl();
        const searchBits: string[] = [];
        if (searxEff) {
          const u = searxEff.length > 56 ? `${searxEff.slice(0, 56)}…` : searxEff;
          searchBits.push(`SearXNG (${u})`);
        }
        if (getBraveSearchApiKey()) searchBits.push("Brave fallback");
        const searchLine =
          searchBits.length > 0
            ? colors.muted(`  web_search: ${searchBits.join(" · ")}`)
            : colors.muted("  web_search: (not configured — /searxng or /brave)");
        appendNotifyLog(
          colors.muted(`  Chat: ${title}`) +
            colors.dim(` · ${shortId}…`) +
            colors.dim(" · ") +
            colors.muted(`${currentModel}`) +
            colors.dim(" · ") +
            colors.accent(cwd) +
            colors.dim(` · ${messages.length} messages`)
        );
        const oaicCount = getOpenAiCompatProviders().length;
        appendLog(
          oaicCount > 0
            ? colors.muted(
                `  LLM: OpenRouter + ${oaicCount} custom OpenAI-compatible endpoint(s) (/providers · /new-provider)`
              )
            : colors.muted("  LLM: OpenRouter (/new-provider to add OpenAI-compatible endpoints)")
        );
        appendLog(searchLine);
        appendLog("");
        return true;
      }
      if (canonical === "/compress") {
        if (messages.length === 0) {
          appendNotifyLog(colors.muted("  Nothing to compress (no messages yet)."));
          appendLog("");
          return true;
        }
        let models = modelList;
        if (models.length === 0) {
          try {
            models = await fetchAllModels(apiKey, oaicProviders);
            setModelList(models);
          } catch (err) {
            appendNotifyLog(
              colors.warn(
                `  Could not load model list (${err instanceof Error ? err.message : String(err)}); using 128K default for compress target.`
              )
            );
            models = [];
          }
        }
        const ctxLen = models.find((m) => m.id === currentModel)?.context_length;
        const targetMaxTokens = manualCompressTargetMaxTokens(ctxLen);
        const systemPrompt = buildAgentSystemPrompt(cwd);
        let summarizeRoute: SummarizeRoute;
        let requestModel: string;
        try {
          ({ summarizeRoute, requestModel } = resolveLlmTargets(apiKey, currentModel, oaicProviders));
        } catch (err) {
          appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
          appendLog("");
          return true;
        }
        setLoadingLabel("Compressing context…");
        setLoading(true);
        try {
          const result = await compressConversationToTargetBudget(
            summarizeRoute,
            requestModel,
            messages,
            systemPrompt,
            {
              targetMaxTokens,
              modelContextLength: ctxLen,
            }
          );
          setMessages(result.messages);
          const kb = (n: number) => `${Math.round(n / 1000)}K`;
          if (!result.changed) {
            appendNotifyLog(
              colors.muted(
                `  Context already within budget (~${kb(result.tokensAfter)} est. tokens, target ≤${kb(result.targetMaxTokens)}).`
              )
            );
          } else {
            appendNotifyLog(
              colors.muted(
                `  Compressed ~${kb(result.tokensBefore)} → ~${kb(result.tokensAfter)} est. tokens (target ≤${kb(result.targetMaxTokens)}).`
              ) +
                colors.dim(
                  "\n  Older turns are summarized (with pinned paths/facts); recent messages kept verbatim."
                )
            );
          }
          appendLog("");
        } catch (err) {
          appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
          appendLog("");
        } finally {
          setLoading(false);
        }
        return true;
      }

      lastUserMessageRef.current = userInput;

      const cleanedHistory = sanitizeMessagesForApi(messages);
      if (cleanedHistory.length !== messages.length) {
        setMessages(cleanedHistory);
      }

      appendLog("");
      appendLog(userPromptBox(userInput));
      appendLog("");

      let state: Array<{ role: string; content: unknown }> = [
        ...cleanedHistory,
        { role: "user", content: userInput },
      ];
      const systemPrompt = buildAgentSystemPrompt(cwd);

      let llm: ReturnType<typeof resolveLlmTargets>;
      try {
        llm = resolveLlmTargets(apiKey, currentModel, oaicProviders);
      } catch (err) {
        appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
        appendLog("");
        setLoading(false);
        return true;
      }

      const modelContext = modelList.find((m) => m.id === currentModel)?.context_length;
      const maxContextTokens = Math.floor((modelContext ?? CONTEXT_WINDOW_K * 1024) * 0.85);
      const stateBeforeCompress = state;
      setLoadingLabel("Compressing context…");
      setLoading(true);
      state = await ensureUnderBudget(llm.summarizeRoute, llm.requestModel, state, systemPrompt, {
        maxTokens: maxContextTokens,
        keepLast: 8,
        modelContextLength: modelContext,
      });
      // Keep React `messages` in sync with what we send to the API so the footer token meter
      // updates as soon as compression runs (otherwise it stays stale until setMessages at turn end).
      setMessages(state);
      if (state.length < stateBeforeCompress.length) {
        appendNotifyLog(colors.muted("  (context compressed to stay under limit)\n"));
      }

      setLoadingLabel("Thinking…");
      let emptyAssistantRetries = 0;
      for (;;) {
        setLoading(true);
        setLoadingLabel("Thinking…");

        const loopNudge = identicalToolLoopNudge(state);
        const apiSystemPrompt = loopNudge ? `${systemPrompt}\n\n${loopNudge}` : systemPrompt;

        const response = await callApi(llm.callRoute, state, apiSystemPrompt, llm.requestModel, {
          onRetry: ({ attempt, maxAttempts, waitMs, status }) => {
            const detail =
              status === 0
                ? "connection dropped"
                : `HTTP ${status}`;
            setLoadingLabel(
              `${detail}, retry ${attempt}/${maxAttempts} in ${(waitMs / 1000).toFixed(1)}s…`
            );
          },
        });
        const contentBlocks = response.content ?? [];
        const hasMeaningfulAssistantOutput = contentBlocks.some(
          (block) => block.type === "tool_use" || (block.type === "text" && !!block.text?.trim())
        );
        if (!hasMeaningfulAssistantOutput) {
          emptyAssistantRetries += 1;
          if (emptyAssistantRetries <= MAX_EMPTY_ASSISTANT_RETRIES) {
            setLoadingLabel(`No output yet, retrying ${emptyAssistantRetries}/${MAX_EMPTY_ASSISTANT_RETRIES}…`);
            appendNotifyLog(
              colors.muted(
                `  ${icons.tool} model returned an empty turn, retrying (${emptyAssistantRetries}/${MAX_EMPTY_ASSISTANT_RETRIES})…`
              )
            );
            continue;
          }
          appendNotifyLog(
            colors.error(
              `${icons.error} model returned empty output repeatedly. Stopping this turn; you can submit "continue" to resume.`
            )
          );
          appendLog("");
          setMessages(state);
          break;
        }
        emptyAssistantRetries = 0;
        const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
        const renderToolOutcome = (
          planned: PlannedToolCall,
          result: string,
          extraIndent = 0
        ): void => {
          const ok = !result.startsWith("error:");
          appendLog(
            toolCallBox(
              planned.toolName,
              planned.argPreview,
              ok,
              extraIndent,
              planned.toolName === "edit" || planned.toolName === "write" ? parseEditDelta(result) : undefined
            )
          );
          const contentForApi = truncateToolResult(result);
          const tokens = estimateTokensForString(contentForApi);
          appendLog(toolResultTokenLine(tokens, ok, extraIndent));
          if (planned.block.id) {
            toolResults.push({ type: "tool_result", tool_use_id: planned.block.id, content: contentForApi });
          }
        };

        const runParallelBatch = async (batch: PlannedToolCall[]): Promise<void> => {
          if (batch.length === 0) return;
          if (batch.length === 1) {
            const planned = batch[0]!;
            setLoadingLabel(`Running ${planned.toolName}…`);
            const result = await runTool(planned.toolName, planned.toolArgs);
            renderToolOutcome(planned, result);
            return;
          }
          setLoadingLabel(`Running ${batch.length} tools in parallel…`);
          const started = Date.now();
          const groupedTools = Array.from(
            batch.reduce((acc, planned) => {
              acc.set(planned.toolName, (acc.get(planned.toolName) ?? 0) + 1);
              return acc;
            }, new Map<string, number>())
          )
            .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
            .join(", ");
          appendLog(
            colors.gray(`  ${icons.tool} parallel batch (${batch.length}): ${groupedTools}`)
          );
          const settled = await Promise.all(
            batch.map(async (planned) => ({ planned, result: await runTool(planned.toolName, planned.toolArgs) }))
          );
          const elapsed = Date.now() - started;
          appendLog(colors.gray(`    completed in ${elapsed}ms`));
          for (const { planned, result } of settled) {
            renderToolOutcome(planned, result, 1);
          }
        };

        let parallelBatch: PlannedToolCall[] = [];
        for (const block of contentBlocks) {
          if (block.type === "text" && block.text?.trim()) {
            const payload = agentMessage(block.text).trimEnd();
            const textLines = splitLogLines(payload);
            setLogLines((prev) => {
              const lastRow = prev[prev.length - 1] ?? "";
              const spacerNeeded = lastRow.trim() !== "";
              const next = spacerNeeded ? [...prev, "", ...textLines] : [...prev, ...textLines];
              lastLogLineRef.current = next[next.length - 1] ?? "";
              return next;
            });
            continue;
          }
          if (block.type !== "tool_use" || !block.name || !block.input) continue;

          const toolName = block.name.trim().toLowerCase();
          const toolArgs = block.input as Record<string, string | number | boolean | undefined>;
          const planned: PlannedToolCall = {
            block,
            toolName,
            toolArgs,
            argPreview: toolArgPreview(toolName, toolArgs),
          };

          if (ENABLE_PARALLEL_TOOL_CALLS && PARALLEL_SAFE_TOOLS.has(toolName)) {
            parallelBatch.push(planned);
            continue;
          }

          await runParallelBatch(parallelBatch);
          parallelBatch = [];
          setLoadingLabel(`Running ${planned.toolName}…`);
          const result = await runTool(planned.toolName, planned.toolArgs);
          renderToolOutcome(planned, result);
        }
        await runParallelBatch(parallelBatch);

        state = [...state, { role: "assistant", content: contentBlocks }];
        if (toolResults.length === 0) {
          setMessages(state);
          break;
        }
        state = [...state, { role: "user", content: toolResults }];
        setMessages(state);
      }
      setLoading(false);

      return true;
    },
    [
      apiKey,
      cwd,
      currentModel,
      messages,
      modelList,
      oaicProviders,
      appendLog,
      appendNotifyLog,
      openModelSelector,
      openChatSelector,
      openBraveKeyModal,
      openSearxngModal,
      openHelpModal,
      openProviderWizard,
      openProviderRemoveModalFn,
      flushChatSave,
      applyChatRecord,
    ]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      if (skipNextSubmitRef.current) {
        skipNextSubmitRef.current = false;
        return;
      }
      const trimmed = value.trim();
      if (trimmed === "/models") {
        clearInputDraft();
        openModelSelector();
        return;
      }
      if (trimmed === "/chats" || trimmed === "/chat") {
        clearInputDraft();
        openChatSelector();
        return;
      }
      if (trimmed === "/new" || trimmed === "/new-session") {
        clearInputDraft();
        await processInput(trimmed);
        return;
      }
      if (trimmed.startsWith("/rename")) {
        clearInputDraft();
        await processInput(value);
        return;
      }
      if (trimmed.startsWith("/fork") || trimmed.startsWith("/duplicate")) {
        clearInputDraft();
        await processInput(value);
        return;
      }
      if (trimmed === "/delete") {
        clearInputDraft();
        await processInput(trimmed);
        return;
      }
      if (trimmed === "/providers") {
        clearInputDraft();
        await processInput("/providers");
        return;
      }
      if (
        trimmed === "/new-provider" ||
        trimmed === "/add-provider" ||
        trimmed === "/openai-provider"
      ) {
        clearInputDraft();
        openProviderWizard();
        return;
      }
      if (trimmed === "/remove-provider") {
        clearInputDraft();
        if (getOpenAiCompatProviders().length === 0) {
          appendNotifyLog(colors.muted("  No custom providers. Use /new-provider to add one."));
          appendLog("");
          return;
        }
        openProviderRemoveModalFn();
        return;
      }
      if (trimmed === "/searxng" || trimmed === "/searx") {
        clearInputDraft();
        openSearxngModal();
        return;
      }
      if (trimmed === "/brave") {
        clearInputDraft();
        openBraveKeyModal();
        return;
      }
      if (trimmed === "/help" || trimmed === "/?") {
        clearInputDraft();
        openHelpModal();
        return;
      }
      clearInputDraft();
      try {
        const cont = await processInput(value);
        if (!cont) {
          handleQuit();
          return;
        }
        const queued = queuedMessageRef.current;
        if (queued) {
          queuedMessageRef.current = null;
          await processInput(queued);
        }
      } catch (err) {
        setLoading(false);
        appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
        appendLog("");
      }
    },
    [
      processInput,
      handleQuit,
      appendLog,
      appendNotifyLog,
      openModelSelector,
      openChatSelector,
      openBraveKeyModal,
      openSearxngModal,
      openHelpModal,
      openProviderWizard,
      openProviderRemoveModalFn,
      clearInputDraft,
    ]
  );

  replStdinHandlerRef.current = (input, key) => {
    if (typeof input === "string" && /\[<\d+;\d+;\d+[Mm]/.test(input)) {
      const isWheelUp = input.includes("<64;");
      const isWheelDown = input.includes("<65;");
      if (isWheelUp || isWheelDown) {
        const step = 3;
        const { maxLogScrollOffset: maxOff } = scrollBoundsRef.current;
        if (isWheelUp) {
          setLogScrollOffset((prev) => Math.min(maxOff, prev + step));
        } else {
          setLogScrollOffset((prev) => Math.max(0, prev - step));
        }
      }
      return;
    }
    if (showHelpModal) {
      setShowHelpModal(false);
      return;
    }
    if (showProviderWizardModal) {
      const maxLen = 512;
      if (key.return) {
        if (providerWizardStep === 0) {
          if (!providerWizardUrl.trim()) return;
          setProviderWizardStep(1);
          return;
        }
        if (providerWizardStep === 1) {
          setProviderWizardStep(2);
          return;
        }
        try {
          const baseUrl = normalizeOpenAiBaseUrl(providerWizardUrl);
          let name = providerWizardName.trim();
          if (!name) {
            try {
              const u = new URL(
                /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`
              );
              name = u.hostname || "Custom";
            } catch {
              name = "Custom";
            }
          }
          upsertOpenAiCompatProvider({
            name,
            baseUrl,
            apiKey: providerWizardKey.trim() || undefined,
          });
          setOaicProviders(getOpenAiCompatProviders());
          appendNotifyLog(colors.success(`  Added provider “${name}” → ${baseUrl}`));
          appendLog(colors.muted("  Open /models to choose a model from this endpoint."));
          appendLog("");
        } catch (err) {
          appendNotifyLog(
            colors.error(`  ${icons.error} ${err instanceof Error ? err.message : String(err)}`)
          );
          appendLog("");
        }
        setShowProviderWizardModal(false);
        setProviderWizardStep(0);
        setProviderWizardUrl("");
        setProviderWizardName("");
        setProviderWizardKey("");
        return;
      }
      if (key.escape) {
        setShowProviderWizardModal(false);
        setProviderWizardStep(0);
        setProviderWizardUrl("");
        setProviderWizardName("");
        setProviderWizardKey("");
        return;
      }
      if (key.backspace || key.delete) {
        if (providerWizardStep === 0) setProviderWizardUrl((p) => p.slice(0, -1));
        else if (providerWizardStep === 1) setProviderWizardName((p) => p.slice(0, -1));
        else setProviderWizardKey((p) => p.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        if (providerWizardStep === 0) setProviderWizardUrl((p) => (p + input).slice(0, maxLen));
        else if (providerWizardStep === 1) setProviderWizardName((p) => (p + input).slice(0, 120));
        else setProviderWizardKey((p) => (p + input).slice(0, maxLen));
      }
      return;
    }
    if (showProviderRemoveModal) {
      const list = oaicProviders;
      if (list.length === 0) {
        setShowProviderRemoveModal(false);
        return;
      }
      if (key.escape) {
        setShowProviderRemoveModal(false);
        return;
      }
      if (key.upArrow) setProviderRemoveIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setProviderRemoveIndex((i) => Math.min(list.length - 1, i + 1));
      else if (key.return) {
        const sel = list[providerRemoveIndex];
        if (sel) {
          const removedId = sel.id;
          const parsedRm = parseOaicModelId(currentModel);
          const modelUsesRemoved =
            !!parsedRm && resolveOaicProvider(oaicProviders, parsedRm.providerKey)?.id === removedId;
          removeOpenAiCompatProvider(removedId);
          const next = getOpenAiCompatProviders();
          setOaicProviders(next);
          appendNotifyLog(colors.muted(`  Removed provider “${sel.name}”.`));
          appendLog("");
          void fetchAllModels(apiKey, next).then((refreshed) => {
            setModelList(refreshed);
            if (modelUsesRemoved) {
              const pick =
                refreshed.find((m) => !parseOaicModelId(m.id))?.id ??
                refreshed[0]?.id ??
                "anthropic/claude-sonnet-4";
              saveModel(pick);
              setCurrentModel(pick);
            }
          });
        }
        setShowProviderRemoveModal(false);
      }
      return;
    }
    if (showRenameChatModal) {
      if (key.return) {
        const title = renameChatInput.trim().slice(0, 120);
        const id = activeChatIdRef.current;
        const prev = loadChatRecord(id);
        if (prev && title) {
          saveChatRecord({
            ...prev,
            title,
            titleManuallySet: true,
            updatedAt: new Date().toISOString(),
          });
          appendNotifyLog(colors.muted(`  Chat title set to “${title}”.`));
          appendLog("");
        }
        setShowRenameChatModal(false);
        setRenameChatInput("");
      } else if (key.escape) {
        setShowRenameChatModal(false);
        setRenameChatInput("");
      } else if (key.backspace || key.delete) {
        setRenameChatInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        setRenameChatInput((prev) => (prev + input).slice(0, 120));
      }
      return;
    }
    if (showSearxngModal) {
      if (key.return) {
        const toSave = searxngInput.trim().slice(0, 512);
        saveSearxngUrl(toSave);
        setShowSearxngModal(false);
        setSearxngInput("");
        const envOverride = Boolean(process.env.SEARXNG_URL?.trim());
        if (toSave) {
          appendNotifyLog(
            envOverride
              ? colors.success("SearXNG URL saved to config. SEARXNG_URL in environment still takes priority.")
              : colors.success("SearXNG URL saved. web_search will use this instance first.")
          );
        } else {
          appendNotifyLog(
            envOverride
              ? colors.muted("Cleared saved SearXNG URL. SEARXNG_URL env is still set.")
              : colors.muted("Cleared saved SearXNG URL.")
          );
        }
        appendLog("");
      } else if (key.escape) {
        setShowSearxngModal(false);
        setSearxngInput("");
      } else if (key.backspace || key.delete) {
        setSearxngInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        setSearxngInput((prev) => (prev + input).slice(0, 512));
      }
      return;
    }
    if (showBraveKeyModal) {
      if (key.return) {
        const trimmed = braveKeyInput.trim();
        const unchanged = !braveKeyDirtyRef.current && trimmed === braveKeyInitialRef.current;
        setShowBraveKeyModal(false);
        setBraveKeyInput("");
        if (unchanged) {
          appendNotifyLog(colors.muted("Brave key unchanged."));
        } else {
          saveBraveSearchApiKey(trimmed);
          const envOverride = Boolean(
            process.env.BRAVE_API_KEY?.trim() || process.env.BRAVE_SEARCH_API_KEY?.trim()
          );
          if (trimmed) {
            appendNotifyLog(
              colors.success(
                "Brave Search API key saved. Used as web_search fallback after SearXNG (if configured)."
              )
            );
          } else {
            appendNotifyLog(
              envOverride
                ? colors.muted(
                    "Brave key removed from config. BRAVE_API_KEY / BRAVE_SEARCH_API_KEY in environment still applies."
                  )
                : colors.success("Brave Search API key removed from config.")
            );
          }
        }
        appendLog("");
      } else if (key.escape) {
        setShowBraveKeyModal(false);
        setBraveKeyInput("");
      } else if (key.backspace || key.delete) {
        braveKeyDirtyRef.current = true;
        setBraveKeyInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        braveKeyDirtyRef.current = true;
        setBraveKeyInput((prev) => (prev + input).slice(0, 512));
      }
      return;
    }
    if (showChatSelector) {
      if (filteredChatList.length === 0) {
        if (key.return || key.escape) setShowChatSelector(false);
        return;
      }
      if (key.upArrow) setChatPickerIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) {
        setChatPickerIndex((i) => Math.min(filteredChatList.length - 1, i + 1));
      } else if (key.return) {
        const selected = filteredChatList[chatPickerIndex];
        if (selected) {
          flushChatSave();
          const rec = loadChatRecord(selected.id);
          if (rec) {
            applyChatRecord(rec);
            appendNotifyLog(colors.success(`Switched to “${rec.title}”`));
            appendLog("");
          }
        }
        setShowChatSelector(false);
      } else if (key.escape) setShowChatSelector(false);
      else if (key.backspace || key.delete) {
        setChatSearchFilter((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        setChatSearchFilter((prev) => prev + input);
        setChatPickerIndex(0);
      }
      return;
    }
    if (showModelSelector) {
      if (key.upArrow) setModelIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setModelIndex((i) => Math.min(filteredModelList.length - 1, i + 1));
      else if (key.return) {
        const selected = filteredModelList[modelIndex]?.id;
        if (selected) {
          saveModel(selected);
          setCurrentModel(selected);
          appendNotifyLog(colors.success(`Model set to ${selected}`));
          appendLog("");
        }
        setShowModelSelector(false);
      } else if (key.escape) setShowModelSelector(false);
      else if (key.backspace || key.delete) {
        setModelSearchFilter((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        setModelSearchFilter((prev) => prev + input);
        setModelIndex(0);
      }
      return;
    }
    if (showPalette) {
      const paletteCount = COMMANDS.length + 1;
      if (key.upArrow) setPaletteIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPaletteIndex((i) => Math.min(paletteCount - 1, i + 1));
      else if (key.return) {
        if (paletteIndex < COMMANDS.length) {
          const selected = COMMANDS[paletteIndex];
          if (selected) {
            setShowPalette(false);
            processInput(selected.cmd).then((cont) => {
              if (!cont) handleQuit();
            }).catch((err) => {
              appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
              appendLog("");
            });
          }
        }
        setShowPalette(false);
        return;
      } else if (key.escape) setShowPalette(false);
      return;
    }
    if (showSlashSuggestions && filteredSlashCommands.length > 0) {
      if (key.upArrow) {
        setSlashSuggestionIndex((i) => Math.min(filteredSlashCommands.length - 1, i + 1));
        return;
      }
      if (key.downArrow) {
        setSlashSuggestionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.tab) {
        const selected = filteredSlashCommands[clampedSlashIndex];
        if (selected) {
          applyInputDraft({ value: selected.cmd, cursor: selected.cmd.length });
        }
        return;
      }
      if (key.return) {
        const selected = filteredSlashCommands[clampedSlashIndex];
        if (selected) {
          clearInputDraft();
          if (selected.cmd === "/models") {
            openModelSelector();
            return;
          }
          if (selected.cmd === "/chats") {
            openChatSelector();
            return;
          }
          if (selected.cmd === "/providers") {
            clearInputDraft();
            processInput("/providers").catch((err) => {
              appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
              appendLog("");
            });
            return;
          }
          if (selected.cmd === "/new-provider") {
            openProviderWizard();
            return;
          }
          if (selected.cmd === "/remove-provider") {
            if (getOpenAiCompatProviders().length === 0) {
              appendNotifyLog(colors.muted("  No custom providers to remove."));
              appendLog("");
              return;
            }
            openProviderRemoveModalFn();
            return;
          }
          if (selected.cmd === "/searxng") {
            openSearxngModal();
            return;
          }
          if (selected.cmd === "/brave") {
            openBraveKeyModal();
            return;
          }
          if (selected.cmd === "/help") {
            openHelpModal();
            return;
          }
          processInput(selected.cmd).then((cont) => {
            if (!cont) handleQuit();
          }).catch((err) => {
            appendNotifyLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
            appendLog("");
          });
          return;
        }
      }
      if (key.escape) {
        clearInputDraft();
        return;
      }
    }
    if (cursorInAtSegment) {
      if (key.escape) {
        updateInputDraft((d) => {
          const lastAt = d.value.lastIndexOf("@");
          if (lastAt < 0) return d;
          return {
            value: d.value.slice(0, lastAt) + d.value.slice(d.cursor),
            cursor: lastAt,
          };
        });
        return;
      }
      if (filteredFilePaths.length > 0) {
        if (key.upArrow) {
          setAtSuggestionIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setAtSuggestionIndex((i) => Math.min(filteredFilePaths.length - 1, i + 1));
          return;
        }
        if (key.tab) {
          const selected = filteredFilePaths[clampedAtFileIndex];
          if (selected !== undefined) {
            updateInputDraft((d) => {
              const cur = d.cursor;
              const lastAt = d.value.lastIndexOf("@");
              const replacement = "@" + selected;
              const value = d.value.slice(0, lastAt) + replacement + " " + d.value.slice(cur);
              return { value, cursor: lastAt + replacement.length + 1 };
            });
          }
          return;
        }
      }
    }
      if (
        !showModelSelector &&
        !showPalette &&
        !showChatSelector &&
        !showRenameChatModal &&
        !showProviderWizardModal &&
        !showProviderRemoveModal
      ) {
      const inputNow = inputDraftRef.current.value;
      const cursorNow = inputDraftRef.current.cursor;
      const withModifier = key.ctrl || key.meta || key.shift;
      const scrollUp =
        key.pageUp ||
        (key.upArrow && (withModifier || !inputNow.trim()));
      const scrollDown =
        key.pageDown ||
        (key.downArrow && (withModifier || !inputNow.trim()));
      if (scrollUp) {
        setLogScrollOffset((prev) =>
          Math.min(maxLogScrollOffset, prev + logViewportHeight)
        );
        return;
      }
      if (scrollDown) {
        setLogScrollOffset((prev) => Math.max(0, prev - logViewportHeight));
        return;
      }
      if (!key.escape) prevEscRef.current = false;
      const len = inputNow.length;
      const cur = cursorNow;
      if (key.tab) {
        if (inputNow.trim()) {
          queuedMessageRef.current = inputNow;
          applyInputMutation("", 0);
          appendNotifyLog(colors.muted("  Message queued. Send to run after this turn."));
          appendLog("");
        }
        return;
      }
      if (key.escape) {
        if (inputNow.length === 0) {
          if (prevEscRef.current) {
            prevEscRef.current = false;
            const last = lastUserMessageRef.current;
            if (last) {
              applyInputMutation(last, last.length);
              setMessages((prev) => (prev.length > 0 && prev[prev.length - 1]?.role === "user" ? prev.slice(0, -1) : prev));
              appendNotifyLog(colors.muted("  Editing previous message. Submit to replace."));
              appendLog("");
            }
          } else prevEscRef.current = true;
        } else {
          applyInputMutation("", 0);
          prevEscRef.current = false;
        }
        return;
      }
      if (key.return) {
        const inputNow = inputDraftRef.current.value;
        const cur = inputDraftRef.current.cursor;
        // Multiline draft: Enter at end submits; Enter in the middle inserts a newline (same as Ctrl+J).
        if (inputNow.includes("\n") && cur < inputNow.length) {
          applyInputMutation(inputNow.slice(0, cur) + "\n" + inputNow.slice(cur), cur + 1);
          return;
        }
        const toSubmit = inputNow;
        applyInputMutation("", 0);
        handleSubmit(toSubmit);
        return;
      }
      if (key.ctrl && input === "u") {
        applyInputMutation(inputNow.slice(cur), 0);
        return;
      }
      if (key.ctrl && input === "k") {
        applyInputMutation(inputNow.slice(0, cur), cur);
        return;
      }
      const killWordBefore =
        (key.ctrl && input === "w") ||
        (key.meta && key.backspace) ||
        (key.meta && key.delete && cur > 0);
      if (killWordBefore) {
        const start = wordStartBackward(inputNow, cur);
        if (start < cur) {
          applyInputMutation(inputNow.slice(0, start) + inputNow.slice(cur), start);
        }
        return;
      }
      if (key.meta && input === "d") {
        const end = wordEndForward(inputNow, cur);
        if (end > cur) {
          applyInputMutation(inputNow.slice(0, cur) + inputNow.slice(end), cur);
        }
        return;
      }
      if ((key.meta && key.leftArrow) || (key.ctrl && key.leftArrow)) {
        applyInputMutation(inputNow, wordStartBackward(inputNow, cur));
        return;
      }
      if ((key.meta && key.rightArrow) || (key.ctrl && key.rightArrow)) {
        applyInputMutation(inputNow, wordEndForward(inputNow, cur));
        return;
      }
      if (key.meta && (input === "b" || input === "f")) {
        if (input === "b") applyInputMutation(inputNow, wordStartBackward(inputNow, cur));
        else applyInputMutation(inputNow, wordEndForward(inputNow, cur));
        return;
      }
      if (key.ctrl && (input === "f" || input === "b")) {
        if (input === "f") applyInputMutation(inputNow, Math.min(len, cur + 1));
        else applyInputMutation(inputNow, Math.max(0, cur - 1));
        return;
      }
      if (key.ctrl && input === "j") {
        applyInputMutation(inputNow.slice(0, cur) + "\n" + inputNow.slice(cur), cur + 1);
        return;
      }
      if (key.ctrl && input === "a") {
        applyInputMutation(inputNow, 0);
        return;
      }
      if (key.ctrl && input === "e") {
        applyInputMutation(inputNow, len);
        return;
      }
      if (key.ctrl && input === "h") {
        if (cur > 0) {
          applyInputMutation(inputNow.slice(0, cur - 1) + inputNow.slice(cur), cur - 1);
        }
        return;
      }
      if (key.ctrl && input === "d") {
        if (cur < len) {
          applyInputMutation(inputNow.slice(0, cur) + inputNow.slice(cur + 1), cur);
        }
        return;
      }
      if (key.backspace || (key.delete && cur > 0)) {
        if (cur > 0) {
          applyInputMutation(inputNow.slice(0, cur - 1) + inputNow.slice(cur), cur - 1);
        }
        return;
      }
      if (key.delete && cur < len) {
        applyInputMutation(inputNow.slice(0, cur) + inputNow.slice(cur + 1), cur);
        return;
      }
      if (key.leftArrow) {
        applyInputMutation(inputNow, Math.max(0, cur - 1));
        return;
      }
      if (key.rightArrow) {
        applyInputMutation(inputNow, Math.min(len, cur + 1));
        return;
      }
      if (input === "?" && !inputNow.trim()) {
        setShowHelpModal(true);
        return;
      }
      if (input === "[I" || input === "[O") {
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        applyInputMutation(inputNow.slice(0, cur) + input + inputNow.slice(cur), cur + input.length);
        return;
      }
    }
    if (key.ctrl && input === "p") {
      setShowPalette(true);
    }
    if (key.ctrl && input === "c") {
      handleQuit();
    }
  };
  useInput(dispatchReplStdin);

  const slashSuggestionBoxLines = showSlashSuggestions
    ? 3 + SLASH_SUGGESTION_ROWS
    : 0;
  const atSuggestionBoxLines = cursorInAtSegment
    ? 4 + Math.max(1, filteredFilePaths.length)
    : 0;
  const suggestionBoxLines = slashSuggestionBoxLines || atSuggestionBoxLines;
  // Keep a fixed loading row reserved to avoid viewport jumps/flicker when loading starts/stops.
  const reservedLines = 1 + layoutInputLineCount + 2;
  const logViewportHeight = Math.max(1, termRows - reservedLines - suggestionBoxLines);
  const maxLogScrollOffset = Math.max(0, visualLogLines.length - logViewportHeight);
  scrollBoundsRef.current = { maxLogScrollOffset, logViewportHeight };
  const logStartIndex = Math.max(
    0,
    visualLogLines.length - logViewportHeight - Math.min(logScrollOffset, maxLogScrollOffset)
  );
  const sliceEnd = logStartIndex + logViewportHeight;
  const visibleLogLines = useMemo(
    () => visualLogLines.slice(logStartIndex, sliceEnd),
    [visualLogLines, logStartIndex, sliceEnd]
  );
  const useSimpleInputRenderer = inputLineCount > 1;

  const calculatedFooterLines = suggestionBoxLines + 1 + layoutInputLineCount;
  useEffect(() => {
    if (!isInputLayoutFrozen) {
      setFrozenFooterLines(calculatedFooterLines);
    }
  }, [isInputLayoutFrozen, calculatedFooterLines]);
  const footerLines = isInputLayoutFrozen ? frozenFooterLines : calculatedFooterLines;
  loadingFooterLinesRef.current = footerLines;

  if (showChatSelector) {
    const chatModalMaxHeight = 18;
    const chatModalWidth = 118;
    const chatModalHeight = Math.min(Math.max(filteredChatList.length, 1) + 4, chatModalMaxHeight);
    const topPad = Math.max(0, Math.floor((termRows - chatModalHeight) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - chatModalWidth) / 2));
    const visibleChatCount =
      filteredChatList.length === 0
        ? 1
        : Math.min(filteredChatList.length, chatModalHeight - 4);
    const chatScrollOffset =
      filteredChatList.length === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              chatPickerIndex - Math.floor(visibleChatCount / 2),
              filteredChatList.length - visibleChatCount
            )
          );
    const visibleChats = filteredChatList.slice(chatScrollOffset, chatScrollOffset + visibleChatCount);
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={chatModalWidth}
            minHeight={chatModalHeight}
          >
            <Text bold> Select chat </Text>
            <Box flexDirection="row">
              <Text color={inkColors.textSecondary}> Filter: </Text>
              <Text>{chatSearchFilter || " "}</Text>
              {chatSearchFilter.length > 0 && (
                <Text color={inkColors.textDisabled}>
                  {" "}({filteredChatList.length} match{filteredChatList.length !== 1 ? "es" : ""})
                </Text>
              )}
            </Box>
            {filteredChatList.length === 0 ? (
              <Text color={inkColors.textSecondary}> No chats match this filter </Text>
            ) : (
              visibleChats.map((s, i) => {
                const actualIndex = chatScrollOffset + i;
                return (
                  <Text key={s.id} color={actualIndex === chatPickerIndex ? inkColors.primary : undefined}>
                    {actualIndex === chatPickerIndex ? "› " : "  "}
                    {s.title.length > 72 ? `${s.title.slice(0, 69)}…` : s.title}
                    <Text color={inkColors.textDisabled}>
                      {" · "}
                      {formatChatRelativeTime(s.updatedAt)}
                    </Text>
                  </Text>
                );
              })
            )}
            <Text color={inkColors.textSecondary}> ↑/↓ select  Enter confirm  Esc cancel  Type to filter </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showProviderRemoveModal) {
    const rmWidth = Math.min(88, Math.max(64, termColumns - 8));
    const rmHeight = Math.min(oaicProviders.length + 5, 16);
    const topPad = Math.max(0, Math.floor((termRows - rmHeight) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - rmWidth) / 2));
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={rmWidth}
            minHeight={rmHeight}
          >
            <Text bold> Remove OpenAI-compatible provider </Text>
            <Text color={inkColors.textSecondary}> ↑/↓ select · Enter remove · Esc cancel </Text>
            {oaicProviders.map((p, i) => (
              <Text key={p.id} color={i === providerRemoveIndex ? inkColors.primary : undefined}>
                {i === providerRemoveIndex ? "› " : "  "}
                {p.name} — {p.baseUrl}
                <Text color={inkColors.textDisabled}> ({p.slug}) </Text>
              </Text>
            ))}
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showModelSelector) {
    const modelModalMaxHeight = 18;
    const modelModalWidth = 108;
    const modelModalHeight = Math.min(filteredModelList.length + 4, modelModalMaxHeight);
    const topPad = Math.max(0, Math.floor((termRows - modelModalHeight) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - modelModalWidth) / 2));
    const visibleModelCount = Math.min(filteredModelList.length, modelModalHeight - 4);
    const modelScrollOffset = Math.max(0, Math.min(modelIndex - Math.floor(visibleModelCount / 2), filteredModelList.length - visibleModelCount));
    const visibleModels = filteredModelList.slice(modelScrollOffset, modelScrollOffset + visibleModelCount);
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={modelModalWidth}
            minHeight={modelModalHeight}
          >
            <Text bold> Select model </Text>
            <Box flexDirection="row">
              <Text color={inkColors.textSecondary}> Filter: </Text>
              <Text>{modelSearchFilter || " "}</Text>
              {modelSearchFilter.length > 0 && (
                <Text color={inkColors.textDisabled}>
                  {" "}({filteredModelList.length} match{filteredModelList.length !== 1 ? "es" : ""})
                </Text>
              )}
            </Box>
            {visibleModels.length === 0 ? (
              <Text color={inkColors.textSecondary}> No match — type to search by id or name </Text>
            ) : (
              visibleModels.map((m, i) => {
                const actualIndex = modelScrollOffset + i;
                return (
                  <Text key={m.id} color={actualIndex === modelIndex ? inkColors.primary : undefined}>
                    {actualIndex === modelIndex ? "› " : "  "}
                    {m.name ? `${m.id} — ${m.name}` : m.id}
                  </Text>
                );
              })
            )}
            <Text color={inkColors.textSecondary}> ↑/↓ select  Enter confirm  Esc cancel  Type to filter </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showHelpModal) {
    const helpModalWidth = Math.min(88, Math.max(80, termColumns - 4));
    const helpContentRows = 20;
    const helpTopPad = Math.max(0, Math.floor((termRows - helpContentRows) / 2));
    const helpLeftPad = Math.max(0, Math.floor((termColumns - helpModalWidth) / 2));
    const labelWidth = 20;
    const descWidth = helpModalWidth - (2 * 2) - labelWidth - 2;
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={helpTopPad} />
        <Box flexDirection="row">
          <Box width={helpLeftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={helpModalWidth}
          >
            <Text bold> Help </Text>
            <Text color={inkColors.textSecondary}> What you can do </Text>
            <Box marginTop={1} flexDirection="row" alignItems="flex-start">
              <Box width={labelWidth} flexShrink={0}>
                <Text color={inkColors.primary}> Message </Text>
              </Box>
              <Box width={descWidth} flexGrow={0}>
                <Text color={inkColors.textSecondary}> Type and Enter to send to the agent. </Text>
              </Box>
            </Box>
            <Box marginTop={1} flexDirection="row" alignItems="flex-start">
              <Box width={labelWidth} flexShrink={0}>
                <Text color={inkColors.primary}> / </Text>
              </Box>
              <Box width={descWidth} flexGrow={0}>
                <Text color={inkColors.textSecondary}> Commands. Type / then pick: /chats, /new, /fork, /models, /providers, /new-provider, /remove-provider, /rename, /delete, /compress, /searxng, /brave, /help, /clear, /status, /q. Ctrl+P palette. </Text>
              </Box>
            </Box>
            <Box marginTop={1} flexDirection="row" alignItems="flex-start">
              <Box width={labelWidth} flexShrink={0}>
                <Text color={inkColors.primary}> @ </Text>
              </Box>
              <Box width={descWidth} flexGrow={0}>
                <Text color={inkColors.textSecondary}> Attach files. Type @ then path; Tab to complete. </Text>
              </Box>
            </Box>
            <Box marginTop={1} flexDirection="row" alignItems="flex-start">
              <Box width={labelWidth} flexShrink={0}>
                <Text color={inkColors.primary}> ! </Text>
              </Box>
              <Box width={descWidth} flexGrow={0}>
                <Text color={inkColors.textSecondary}> Run a shell command. Type ! then the command. </Text>
              </Box>
            </Box>
            <Box marginTop={1} flexDirection="row" alignItems="flex-start">
              <Box width={labelWidth} flexShrink={0}>
                <Text color={inkColors.primary}> Word / char nav </Text>
              </Box>
              <Box width={descWidth} flexGrow={0}>
                <Text color={inkColors.textSecondary}> Ctrl+←/→ or Meta+←/→ word; Ctrl+F/B char (Emacs). Opt+←/→ needs terminal to send Meta (e.g. iTerm2: Esc+). </Text>
              </Box>
            </Box>
            <Box marginTop={1} flexDirection="row" alignItems="flex-start">
              <Box width={labelWidth} flexShrink={0}>
                <Text color={inkColors.primary}> Scroll </Text>
              </Box>
              <Box width={descWidth} flexGrow={0}>
                <Text color={inkColors.textSecondary}> Trackpad/↑/↓ scroll. To select text: hold Option (iTerm2) or Fn (Terminal.app) or Shift (Windows/Linux). </Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text color={inkColors.textSecondary}> Press any key to close </Text>
            </Box>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showRenameChatModal) {
    const renameModalWidth = Math.min(78, Math.max(52, termColumns - 8));
    const topPad = Math.max(0, Math.floor((termRows - 8) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - renameModalWidth) / 2));
    const cur = loadChatRecord(activeChatId);
    const renameHint =
      cur && !cur.titleManuallySet ? firstUserTextSnippet(cur.messages) : "";
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={renameModalWidth}
          >
            <Text bold> Rename chat </Text>
            {renameHint ? (
              <Text color={inkColors.textSecondary}> From first message: {renameHint} </Text>
            ) : null}
            <Box flexDirection="row" marginTop={1}>
              <Text color={inkColors.primary}> Title: </Text>
              <Text>{renameChatInput || "\u00A0"}</Text>
            </Box>
            <Text color={inkColors.textSecondary}> Enter to save, Esc to cancel </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showSearxngModal) {
    const searxModalWidth = Math.min(72, Math.max(52, termColumns - 8));
    const topPad = Math.max(0, Math.floor((termRows - 8) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - searxModalWidth) / 2));
    const envSet = Boolean(process.env.SEARXNG_URL?.trim());
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={searxModalWidth}
          >
            <Text bold> SearXNG base URL </Text>
            <Text color={inkColors.textSecondary}>
              {" "}
              Example: http://127.0.0.1:8080 — web_search tries SearXNG first, then Brave if configured.
            </Text>
            {envSet ? (
              <Text color={inkColors.textSecondary}> SEARXNG_URL is set in the environment (overrides saved URL). </Text>
            ) : null}
            <Box flexDirection="row" marginTop={1}>
              <Text color={inkColors.primary}> URL: </Text>
              <Text>{searxngInput || "\u00A0"}</Text>
            </Box>
            <Text color={inkColors.textSecondary}> Enter to save (empty clears saved URL), Esc to cancel </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showBraveKeyModal) {
    const braveModalWidth = 52;
    const topPad = Math.max(0, Math.floor((termRows - 6) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - braveModalWidth) / 2));
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={braveModalWidth}
          >
            <Text bold> Brave Search API key </Text>
            <Text color={inkColors.textSecondary}> Get one at https://brave.com/search/api </Text>
            <Text color={inkColors.textSecondary}> Edit or clear and Enter to remove from config. </Text>
            <Box flexDirection="row" marginTop={1}>
              <Text color={inkColors.primary}> Key: </Text>
              <Text>{braveKeyInput || "\u00A0"}</Text>
            </Box>
            <Text color={inkColors.textSecondary}> Enter to save, Esc to cancel </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showProviderWizardModal) {
    const pvWidth = Math.min(78, Math.max(56, termColumns - 8));
    const topPad = Math.max(0, Math.floor((termRows - 12) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - pvWidth) / 2));
    const stepLabel =
      providerWizardStep === 0
        ? "Base URL (e.g. http://127.0.0.1:11434 or …/v1)"
        : providerWizardStep === 1
          ? "Display name (optional — Enter to use hostname)"
          : "API key (optional)";
    const stepValue =
      providerWizardStep === 0
        ? providerWizardUrl
        : providerWizardStep === 1
          ? providerWizardName
          : providerWizardKey;
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={pvWidth}
          >
            <Text bold> Add OpenAI-compatible provider </Text>
            <Text color={inkColors.textSecondary}>
              {" "}
              Must expose GET /v1/models and POST /v1/chat/completions. URL is normalized to …/v1.
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text color={inkColors.primary}>
                {" "}
                {providerWizardStep + 1}/3 {stepLabel}
              </Text>
              <Box flexDirection="row" marginTop={1}>
                <Text>{stepValue || "\u00A0"}</Text>
              </Box>
            </Box>
            <Text color={inkColors.textSecondary}> Enter next / save · Esc cancel </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (showPalette) {
    const paletteModalHeight = COMMANDS.length + 4;
    const paletteModalWidth = 52;
    const topPad = Math.max(0, Math.floor((termRows - paletteModalHeight) / 2));
    const leftPad = Math.max(0, Math.floor((termColumns - paletteModalWidth) / 2));
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Box height={topPad} />
        <Box flexDirection="row">
          <Box width={leftPad} />
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={inkColors.primary}
            paddingX={2}
            paddingY={1}
            width={paletteModalWidth}
            minHeight={paletteModalHeight}
          >
            <Text bold> Command palette </Text>
            {COMMANDS.map((c, i) => (
              <Text key={c.cmd} color={i === paletteIndex ? inkColors.primary : undefined}>
                {i === paletteIndex ? "› " : "  "}
                {c.cmd}
                <Text color={inkColors.textSecondary}> — {c.desc}</Text>
              </Text>
            ))}
            <Text color={paletteIndex === COMMANDS.length ? inkColors.primary : undefined}>
              {paletteIndex === COMMANDS.length ? "› " : "  "}
              Cancel (Esc)
            </Text>
            <Text color={inkColors.textSecondary}> ↑/↓ select, Enter confirm, Esc close </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <LogViewport
          lines={visibleLogLines}
          startIndex={logStartIndex}
          height={logViewportHeight}
          width={termColumns}
        />
        <Box flexDirection="row" marginTop={0} marginBottom={0}>
          <Text color={inkColors.textSecondary}>{"\u00A0"}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0} height={footerLines}>
        {showSlashSuggestions && (
          <Box
            flexDirection="column"
            marginBottom={0}
            paddingLeft={2}
            borderStyle="single"
            borderColor={inkColors.textDisabled}
            height={slashSuggestionBoxLines}
          >
            {filteredSlashCommands.length === 0 ? (
              <Text color={inkColors.textSecondary}> No match </Text>
            ) : (
              [...filteredSlashCommands.slice(0, SLASH_SUGGESTION_ROWS)].reverse().map((c, rev) => {
                const i = Math.min(filteredSlashCommands.length, SLASH_SUGGESTION_ROWS) - 1 - rev;
                return (
                  <Text key={c.cmd} color={i === clampedSlashIndex ? inkColors.primary : undefined}>
                    {i === clampedSlashIndex ? "› " : "  "}
                    {c.cmd}
                    <Text color={inkColors.textSecondary}> — {c.desc}</Text>
                  </Text>
                );
              })
            )}
            {Array.from({
              length: Math.max(0, SLASH_SUGGESTION_ROWS - Math.min(filteredSlashCommands.length, SLASH_SUGGESTION_ROWS)),
            }).map((_, idx) => (
              <Text key={`slash-pad-${idx}`}>{"\u00A0"}</Text>
            ))}
            <Text color={inkColors.textSecondary}> Commands (↑/↓ select, Enter run, Esc clear) </Text>
          </Box>
        )}
        {cursorInAtSegment && !showSlashSuggestions && (
          <Box flexDirection="column" marginBottom={0} paddingLeft={2} borderStyle="single" borderColor={inkColors.textDisabled}>
            {filteredFilePaths.length === 0 ? (
              <Text color={inkColors.textSecondary}> {hasCharsAfterAt ? "No match" : "Type to search files"} </Text>
            ) : (
              [...filteredFilePaths].reverse().map((p, rev) => {
                const i = filteredFilePaths.length - 1 - rev;
                return (
                  <Text key={p} color={i === clampedAtFileIndex ? inkColors.primary : undefined}>
                    {i === clampedAtFileIndex ? "› " : "  "}
                    {p}
                  </Text>
                );
              })
            )}
            <Box flexDirection="row" marginTop={1}>
              <Text color={inkColors.textSecondary}> Files (↑/↓ select, Enter/Tab complete, Esc clear) </Text>
            </Box>
          </Box>
        )}
      <Box flexDirection="row" marginTop={0}>
        <Text color={inkColors.footerHint}>
          {" "}
          {icons.tool} {tokenDisplay}
        </Text>
        <Text color={inkColors.footerHint}>
          {` · ${currentModel} · ${balanceFooterDisplay} · / ! @ trackpad/↑/↓ scroll Ctrl+J newline Tab queue Esc Esc`}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {inputDraft.value.length === 0 ? (
          <Box flexDirection="row">
            <Text color={inkColors.primary}>{icons.prompt} </Text>
            <InputCaret char={"\u00A0"} color={inkColors.primary} />
            <Text color={inkColors.textSecondary}>Message or / for commands, @ for files, ! for shell, ? for help...</Text>
          </Box>
        ) : (
          (() => {
            const lines = inputDraft.value.split("\n");
            let lineStart = 0;
            return (
              <>
                {lines.flatMap((lineText, lineIdx) => {
                  const lineEnd = lineStart + lineText.length;
                  const cursorOnThisLine =
                    inputDraft.cursor >= lineStart && inputDraft.cursor <= lineEnd;
                  const cursorOffsetInLine = cursorOnThisLine ? inputDraft.cursor - lineStart : -1;
                  const currentLineStart = lineStart;
                  lineStart = lineEnd + 1;
                  if (useSimpleInputRenderer) {
                    const visualLines = wrapLine(lineText, wrapWidth);
                    return visualLines.map((visualChunk, v) => {
                      const visualStart = v * wrapWidth;
                      const visualEnd = Math.min((v + 1) * wrapWidth, lineText.length);
                      const isLastVisualOfThisLine = v === visualLines.length - 1;
                      const cursorAtEndOfVisual =
                        isLastVisualOfThisLine && cursorOffsetInLine === visualEnd;
                      const cursorPosInVisual =
                        cursorOnThisLine &&
                        cursorOffsetInLine >= visualStart &&
                        (cursorOffsetInLine < visualEnd || cursorAtEndOfVisual)
                          ? cursorOffsetInLine < visualEnd
                            ? cursorOffsetInLine - visualStart
                            : visualEnd - visualStart
                          : -1;

                      const isFirstRow = lineIdx === 0 && v === 0;
                      const isLastLogicalLine = lineIdx === lines.length - 1;
                      const isLastVisualOfLine = v === visualLines.length - 1;

                      const rowNodes: React.ReactNode[] = [];
                      if (lineText === "" && v === 0 && cursorOnThisLine) {
                        rowNodes.push(
                            <InputCaret key="cursor-empty" char={"\u00A0"} color={inkColors.primary} />
                          );
                      } else if (cursorPosInVisual >= 0) {
                        const before = visualChunk.slice(0, cursorPosInVisual);
                        const curChar =
                          cursorPosInVisual < visualChunk.length
                            ? visualChunk[cursorPosInVisual]
                            : "\u00A0";
                        const after =
                          cursorPosInVisual < visualChunk.length
                            ? visualChunk.slice(cursorPosInVisual + 1)
                            : "";
                        rowNodes.push(<Text key="plain-before">{before}</Text>);
                        rowNodes.push(
                            <InputCaret key="plain-caret" char={curChar} color={inkColors.primary} />
                          );
                        rowNodes.push(<Text key="plain-after">{after}</Text>);
                      } else {
                        rowNodes.push(<Text key="plain">{visualChunk}</Text>);
                      }

                      return (
                        <Box key={`simple-${lineIdx}-${v}`} flexDirection="row">
                          {isFirstRow ? (
                            <Text color={inkColors.primary}>{icons.prompt} </Text>
                          ) : (
                            <Text>{" ".repeat(PROMPT_INDENT_LEN)}</Text>
                          )}
                          {rowNodes}
                          {isLastLogicalLine && isLastVisualOfLine && inputDraft.value.startsWith("!") && (
                            <Text color={inkColors.textDisabled}>
                              {"  — "}type a shell command to run
                            </Text>
                          )}
                        </Box>
                      );
                    });
                  }
                  const segments = parseAtSegments(lineText);
                  let runIdx = 0;
                  const segmentsWithStyle: Array<{
                    start: number;
                    end: number;
                    style: { bold?: boolean; color?: string };
                  }> = [];
                  segments.forEach((seg) => {
                    const start = runIdx;
                    const end = runIdx + seg.text.length;
                    runIdx = end;
                    const segmentStartInInput = currentLineStart + start;
                    const segmentEndInInput = currentLineStart + end;
                    const isCurrentAtSegment =
                      seg.type === "path" &&
                      cursorOnThisLine &&
                      cursorOffsetInLine >= start &&
                      cursorOffsetInLine <= end;
                    const segmentContainsLastAt =
                      lastAtIndex >= segmentStartInInput && lastAtIndex <= segmentEndInInput;
                    const pathPart = seg.text.slice(1).trim();
                    const completedPathMatches =
                      segmentContainsLastAt &&
                      pathPart === lastAtPath &&
                      lastAtPathMatches;
                    const usePathStyle =
                      seg.type === "path" &&
                      seg.text.length > 1 &&
                      ((isCurrentAtSegment && filteredFilePaths.length > 0) ||
                        completedPathMatches);
                    if (
                      seg.type === "normal" &&
                      start === 0 &&
                      seg.text.startsWith("/") &&
                      filteredSlashCommands.length > 0
                    ) {
                      const slashEnd =
                        seg.text.indexOf(" ") === -1 ? seg.text.length : seg.text.indexOf(" ");
                      segmentsWithStyle.push({
                        start: 0,
                        end: slashEnd,
                        style: { bold: true, color: inkColors.path },
                      });
                      if (slashEnd < seg.text.length) {
                        segmentsWithStyle.push({
                          start: slashEnd,
                          end,
                          style: {},
                        });
                      }
                    } else {
                      segmentsWithStyle.push({
                        start,
                        end,
                        style: usePathStyle ? { bold: true, color: inkColors.path } : {},
                      });
                    }
                  });
                  const visualLines = wrapLine(lineText, wrapWidth);
                  return visualLines.map((visualChunk, v) => {
                    const visualStart = v * wrapWidth;
                    const visualEnd = Math.min((v + 1) * wrapWidth, lineText.length);
                    const isLastVisualOfThisLine = v === visualLines.length - 1;
                    const cursorAtEndOfVisual =
                      isLastVisualOfThisLine && cursorOffsetInLine === visualEnd;
                    const cursorPosInVisual =
                      cursorOnThisLine &&
                      cursorOffsetInLine >= visualStart &&
                      (cursorOffsetInLine < visualEnd || cursorAtEndOfVisual)
                        ? cursorOffsetInLine < visualEnd
                          ? cursorOffsetInLine - visualStart
                          : visualEnd - visualStart
                        : -1;
                    const lineNodes: React.ReactNode[] = [];
                    if (lineText === "" && v === 0 && cursorOnThisLine) {
                      lineNodes.push(
                          <InputCaret key="cursor" char={"\u00A0"} color={inkColors.primary} />
                        );
                    } else {
                      let cursorRendered = false;
                      segmentsWithStyle.forEach((seg, segIdx) => {
                        const oStart = Math.max(visualStart, seg.start);
                        const oEnd = Math.min(visualEnd, seg.end);
                        if (oEnd <= oStart) return;
                        const text = lineText.slice(oStart, oEnd);
                        if (cursorPosInVisual >= 0) {
                          const cursorInSeg =
                            cursorPosInVisual >= oStart - visualStart &&
                            cursorPosInVisual < oEnd - visualStart;
                          if (cursorInSeg) {
                            const segRel = cursorPosInVisual - (oStart - visualStart);
                            const before = text.slice(0, segRel);
                            const curChar = text[segRel] ?? "\u00A0";
                            const after = text.slice(segRel + 1);
                            const usePath = "color" in seg.style && !!seg.style.color;
                            lineNodes.push(<Text key={`${segIdx}-a`} {...seg.style}>{before}</Text>);
                            lineNodes.push(
                              <InputCaret
                                key={`${segIdx}-b`}
                                char={curChar}
                                color={usePath ? inkColors.path : inkColors.primary}
                                bold={"bold" in seg.style && !!seg.style.bold}
                              />
                            );
                            lineNodes.push(<Text key={`${segIdx}-c`} {...seg.style}>{after}</Text>);
                            cursorRendered = true;
                          } else {
                            lineNodes.push(<Text key={segIdx} {...seg.style}>{text}</Text>);
                          }
                        } else {
                          lineNodes.push(<Text key={segIdx} {...seg.style}>{text}</Text>);
                        }
                      });
                      if (cursorPosInVisual >= 0 && !cursorRendered) {
                        lineNodes.push(
                            <InputCaret key="cursor-end" char={"\u00A0"} color={inkColors.primary} />
                          );
                      }
                    }
                    const isFirstRow = lineIdx === 0 && v === 0;
                    const isLastLogicalLine = lineIdx === lines.length - 1;
                    const isLastVisualOfLine = v === visualLines.length - 1;
                    return (
                      <Box key={`${lineIdx}-${v}`} flexDirection="row">
                        {isFirstRow ? (
                          <Text color={inkColors.primary}>{icons.prompt} </Text>
                        ) : (
                          <Text>{" ".repeat(PROMPT_INDENT_LEN)}</Text>
                        )}
                        {lineNodes}
                        {isLastLogicalLine && isLastVisualOfLine && inputDraft.value.startsWith("!") && (
                          <Text color={inkColors.textDisabled}>
                            {"  — "}type a shell command to run
                          </Text>
                        )}
                      </Box>
                    );
                  });
                })}
          </>
        );
      })()
        )}
      </Box>
      </Box>
    </Box>
  );
}
