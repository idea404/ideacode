/**
 * Main REPL UI: input, log viewport, slash/@ suggestions, modals (model picker, palette), API loop and tool dispatch.
 */
import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { globSync } from "glob";
import * as path from "node:path";
import { writeSync } from "node:fs";
import gradient from "gradient-string";

// Custom matcha-themed gradient: matcha green → dark sepia
const matchaGradient = gradient(["#7F9A65", "#5C4033"]);
import { getModel, saveModel, saveBraveSearchApiKey, getBraveSearchApiKey } from "./config.js";
import { loadConversation, saveConversation } from "./conversation.js";
import type { ContentBlock, OpenRouterModel } from "./api.js";
import { callApi, fetchModels } from "./api.js";
import { getVersion, checkForUpdate } from "./version.js";
import { estimateTokens, estimateTokensForString, ensureUnderBudget } from "./context.js";
import { runTool } from "./tools/index.js";
import { COMMANDS, matchCommand, resolveCommand } from "./commands.js";
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

const CONTEXT_WINDOW_K = 128;
const MAX_TOOL_RESULT_CHARS = 3500;
const MAX_AT_SUGGESTIONS = 12;
const INITIAL_BANNER_LINES = 12;
const ENABLE_PARALLEL_TOOL_CALLS = process.env.IDEACODE_PARALLEL_TOOL_CALLS !== "0";
const PARALLEL_SAFE_TOOLS = new Set(["read", "glob", "grep", "web_fetch", "web_search"]);
const LOADING_TICK_MS = 80;
const MAX_EMPTY_ASSISTANT_RETRIES = 3;

const TRUNCATE_NOTE =
  "\n\n(Output truncated to save context. Use read with offset/limit, grep with a specific pattern, or tail with fewer lines to get more.)";

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return content.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATE_NOTE;
}
const isMac = process.platform === "darwin";
const pasteShortcut = isMac ? "Cmd+V" : "Ctrl+V";

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
  if (toolName === "bash") {
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
}: {
  lines: string[];
  startIndex: number;
  height: number;
}) {
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {lines.map((line, i) => (
        <Text key={startIndex + i}>{line === "" ? "\u00A0" : line}</Text>
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

const LoadingStatus = React.memo(function LoadingStatus({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  const [frame, setFrame] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      return;
    }
    if (startedAtRef.current == null) {
      startedAtRef.current = Date.now();
      setFrame(0);
    }
    const anim = setInterval(() => setFrame((n) => n + 1), LOADING_TICK_MS);
    return () => {
      clearInterval(anim);
    };
  }, [active]);

  if (!active) return <Text color={inkColors.textSecondary}>{"\u00A0"}</Text>;
  const startedAt = startedAtRef.current ?? Date.now();
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
  const elapsedText =
    elapsedSeconds < 10 ? `${elapsedSeconds.toFixed(1)}s` : `${Math.floor(elapsedSeconds)}s`;

  return (
    <Text color={inkColors.textSecondary}>
      {" "}
      {orbitDots(frame)} {colors.gray(label)} {colors.gray(elapsedText)}
    </Text>
  );
});

export function Repl({ apiKey, cwd, onQuit }: ReplProps) {
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  // Big ASCII art logo for ideacode
  const bigLogo = `
  ██╗██████╗ ███████╗ █████╗  ██████╗ ██████╗ ██████╗ ███████╗
  ██║██╔══██╗██╔════╝██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██║██║  ██║█████╗  ███████║██║     ██║   ██║██║  ██║█████╗  
  ██║██║  ██║██╔══╝  ██╔══██║██║     ██║   ██║██║  ██║██╔══╝  
  ██║██████╔╝███████╗██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
  `;

  const hasRestoredLogRef = useRef(false);
  const restoredCwdRef = useRef<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>(() => {
    const model = getModel();
    const version = getVersion();
    const banner = [
      "",
      matchaGradient(bigLogo),
      colors.accent(`  ideacode v${version}`) + colors.dim(" · ") + colors.accentPale(model) + colors.dim(" · ") + colors.bold("OpenRouter") + colors.dim(` · ${cwd}`),
      colors.mutedDark("  / commands  ! shell  @ files · Ctrl+P palette · Ctrl+C or /q to quit"),
      "",
    ];
    const loaded = loadConversation(cwd);
    if (loaded.length > 0) {
      hasRestoredLogRef.current = true;
      restoredCwdRef.current = cwd;
      return [...banner, ...replayMessagesToLogLines(loaded)];
    }
    return banner;
  });
  const logLinesRef = useRef(logLines);
  useEffect(() => {
    logLinesRef.current = logLines;
  }, [logLines]);
  const [inputValue, setInputValue] = useState("");
  const [currentModel, setCurrentModel] = useState(getModel);
  const [messages, setMessages] = useState<Array<{ role: string; content: unknown }>>(() =>
    loadConversation(cwd)
  );
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (hasRestoredLogRef.current && restoredCwdRef.current === cwd) return;
    const loaded = loadConversation(cwd);
    const model = getModel();
    const version = getVersion();
    const banner = [
      "",
      matchaGradient(bigLogo),
      colors.accent(`  ideacode v${version}`) + colors.dim(" · ") + colors.accent(model) + colors.dim(" · ") + colors.accentPale("OpenRouter") + colors.dim(` · ${cwd}`),
      colors.mutedDark("  / commands  ! shell  @ files · Ctrl+P palette · Ctrl+C or /q to quit"),
      "",
    ];
    if (loaded.length > 0) {
      hasRestoredLogRef.current = true;
      setLogLines([...banner, ...replayMessagesToLogLines(loaded)]);
    } else {
      hasRestoredLogRef.current = false;
      setLogLines(banner);
    }
    restoredCwdRef.current = cwd;
  }, [cwd]);

  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(() => {
      saveDebounceRef.current = null;
      saveConversation(cwd, messages);
    }, 500);
    return () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    };
  }, [cwd, messages]);

  const handleQuit = useCallback(() => {
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveConversation(cwd, messagesRef.current);
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
  }, [cwd, onQuit]);

  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("Thinking…");
  const cursorBlinkOn = true;
  const [showPalette, setShowPalette] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [modelList, setModelList] = useState<OpenRouterModel[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [modelSearchFilter, setModelSearchFilter] = useState("");
  const [showBraveKeyModal, setShowBraveKeyModal] = useState(false);
  const [braveKeyInput, setBraveKeyInput] = useState("");
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0);
  const [inputCursor, setInputCursor] = useState(0);
  const skipNextSubmitRef = useRef(false);
  const queuedMessageRef = useRef<string | null>(null);
  const lastUserMessageRef = useRef<string>("");
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const scrollBoundsRef = useRef({ maxLogScrollOffset: 0, logViewportHeight: 1 });
  const prevEscRef = useRef(false);

  useEffect(() => {
    // Enable SGR mouse + basic tracking so trackpad wheel scrolling works.
    process.stdout.write("\x1b[?1006h\x1b[?1000h");
    return () => {
      process.stdout.write("\x1b[?1006l\x1b[?1000l");
    };
  }, []);

  const estimatedTokens = useMemo(() => estimateTokens(messages, undefined), [messages]);
  const contextWindowK = useMemo(() => {
    const ctx = modelList.find((m) => m.id === currentModel)?.context_length;
    return ctx != null ? Math.round(ctx / 1024) : CONTEXT_WINDOW_K;
  }, [modelList, currentModel]);
  const tokenDisplay = `${Math.round(estimatedTokens / 1000)}K / ${contextWindowK}K`;

  const filteredModelList = useMemo(() => {
    const q = modelSearchFilter.trim().toLowerCase();
    if (!q) return modelList;
    return modelList.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q)
    );
  }, [modelList, modelSearchFilter]);

  const wrapWidth = Math.max(10, termColumns - PROMPT_INDENT_LEN - 2);
  const inputLineCount = useMemo(() => {
    const lines = inputValue.split("\n");
    return lines.reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / wrapWidth)),
      0
    );
  }, [inputValue, wrapWidth]);
  const [stableInputLineCount, setStableInputLineCount] = useState(inputLineCount);
  useEffect(() => {
    if (inputLineCount <= 1) {
      setStableInputLineCount(1);
      return;
    }
    const t = setTimeout(() => setStableInputLineCount(inputLineCount), 90);
    return () => clearTimeout(t);
  }, [inputLineCount]);

  useEffect(() => {
    setInputCursor((c) => Math.min(c, Math.max(0, inputValue.length)));
  }, [inputValue.length]);

  useEffect(() => {
    if (apiKey) fetchModels(apiKey).then(setModelList);
  }, [apiKey]);

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

  const showSlashSuggestions = inputValue.startsWith("/");
  const filteredSlashCommands = useMemo(() => {
    const filter = inputValue.slice(1).trim();
    return COMMANDS.filter((c) => matchCommand(filter, c));
  }, [inputValue]);
  const clampedSlashIndex = Math.min(
    Math.max(0, slashSuggestionIndex),
    Math.max(0, filteredSlashCommands.length - 1)
  );
  useEffect(() => {
    setSlashSuggestionIndex(0);
  }, [inputValue]);

  const lastAtIndex = inputValue.lastIndexOf("@");
  const atPathEnd =
    lastAtIndex < 0
      ? -1
      : (() => {
          let end = lastAtIndex + 1;
          while (end < inputValue.length && inputValue[end] !== " " && inputValue[end] !== "\n") end++;
          return end;
        })();
  const cursorInAtSegment =
    lastAtIndex >= 0 &&
    inputCursor >= lastAtIndex &&
    inputCursor <= atPathEnd;
  const hasCharsAfterAt = atPathEnd > lastAtIndex + 1;
  const atFilter = cursorInAtSegment ? inputValue.slice(lastAtIndex + 1, inputCursor) : "";
  const lastAtPath =
    lastAtIndex >= 0 && atPathEnd > lastAtIndex
      ? inputValue.slice(lastAtIndex + 1, atPathEnd).trim()
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
    const lines = line.split("\n");
    if (lines.length > 1 && lines[0] === "") lines.shift();
    setLogLines((prev) => {
      const next = [...prev, ...lines];
      lastLogLineRef.current = next[next.length - 1] ?? "";
      return next;
    });
  }, []);

  useEffect(() => {
    const version = getVersion();
    checkForUpdate(version, (latest) => {
      appendLog(colors.warn(`  Update available: ideacode ${latest} (you have ${version}). Run: npm i -g ideacode`));
      appendLog("");
    });
  }, [appendLog]);

  const braveKeyHadExistingRef = useRef(false);
  const BRAVE_KEY_PLACEHOLDER = "••••••••";

  const openBraveKeyModal = useCallback(() => {
    const existing = getBraveSearchApiKey();
    braveKeyHadExistingRef.current = !!existing;
    setBraveKeyInput(existing ? BRAVE_KEY_PLACEHOLDER : "");
    setShowBraveKeyModal(true);
  }, []);

  const openHelpModal = useCallback(() => setShowHelpModal(true), []);

  const openModelSelector = useCallback(async () => {
    setShowPalette(false);
    const models = await fetchModels(apiKey);
    setModelList(models);
    setModelIndex(0);
    setShowModelSelector(true);
  }, [apiKey]);

  const processInput = useCallback(
    async (value: string): Promise<boolean> => {
      const userInput = value.trim();
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

      const canonical = resolveCommand(userInput);
      if (canonical === "/q") return false;
      if (canonical === "/clear") {
        setMessages([]);
        setLogScrollOffset(0);
        const model = getModel();
        const version = getVersion();
        const banner = [
          "",
          matchaGradient(bigLogo),
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
      if (canonical === "/brave") {
        openBraveKeyModal();
        return true;
      }
      if (canonical === "/help") {
        openHelpModal();
        return true;
      }
      if (canonical === "/status") {
        appendLog(
          colors.muted(`  ${currentModel}`) +
            colors.dim(" · ") +
            colors.accent(cwd) +
            colors.dim(` · ${messages.length} messages`)
        );
        appendLog("");
        return true;
      }

      lastUserMessageRef.current = userInput;
      appendLog("");
      appendLog(userPromptBox(userInput));
      appendLog("");

      let state: Array<{ role: string; content: unknown }> = [...messages, { role: "user", content: userInput }];
      const systemPrompt = `Concise coding assistant. cwd: ${cwd}. PRIORITIZE grep to locate; then read with offset and limit to fetch only relevant sections. Do not read whole files unless the user explicitly asks. Use focused greps (specific patterns, narrow paths) and read in chunks when files are large; avoid one huge grep or read that floods context. When exploring a dependency, set path to that package (e.g. node_modules/<pkg>) and list/read only what you need. Prefer grep or keyword search for the most recent or specific occurrence; avoid tail/read of thousands of lines. If a tool result says it was truncated, call the tool again with offset, limit, or a narrower pattern to get what you need. Use as many parallel read/search/web tool calls as needed in one turn when they are independent (often more than 3 is appropriate for broad research), but keep each call high-signal, non-redundant, and minimal in output size. For bash tool calls, avoid decorative echo headers; run direct commands and keep commands concise.`;

      const modelContext = modelList.find((m) => m.id === currentModel)?.context_length;
      const maxContextTokens = Math.floor((modelContext ?? CONTEXT_WINDOW_K * 1024) * 0.85);
      const stateBeforeCompress = state;
      setLoadingLabel("Compressing context…");
      setLoading(true);
      state = await ensureUnderBudget(apiKey, state, systemPrompt, currentModel, {
        maxTokens: maxContextTokens,
        keepLast: 8,
      });
      if (state.length < stateBeforeCompress.length) {
        appendLog(colors.muted("  (context compressed to stay under limit)\n"));
      }

      setLoadingLabel("Thinking…");
      let emptyAssistantRetries = 0;
      for (;;) {
        setLoading(true);
        setLoadingLabel("Thinking…");

        const response = await callApi(apiKey, state, systemPrompt, currentModel, {
          onRetry: ({ attempt, maxAttempts, waitMs, status }) => {
            setLoadingLabel(
              `Rate limited (${status}), retry ${attempt}/${maxAttempts} in ${(waitMs / 1000).toFixed(1)}s…`
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
            appendLog(
              colors.muted(
                `  ${icons.tool} model returned an empty turn, retrying (${emptyAssistantRetries}/${MAX_EMPTY_ASSISTANT_RETRIES})…`
              )
            );
            continue;
          }
          appendLog(
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
            if (lastLogLineRef.current !== "") appendLog("");
            appendLog(agentMessage(block.text).trimEnd());
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
    [apiKey, cwd, currentModel, messages, modelList, appendLog, openModelSelector, openBraveKeyModal, openHelpModal]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      if (skipNextSubmitRef.current) {
        skipNextSubmitRef.current = false;
        return;
      }
      const trimmed = value.trim();
      if (trimmed === "/models") {
        setInputValue("");
        setInputCursor(0);
        openModelSelector();
        return;
      }
      if (trimmed === "/brave") {
        setInputValue("");
        setInputCursor(0);
        openBraveKeyModal();
        return;
      }
      if (trimmed === "/help" || trimmed === "/?") {
        setInputValue("");
        setInputCursor(0);
        openHelpModal();
        return;
      }
      setInputValue("");
      setInputCursor(0);
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
        appendLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
        appendLog("");
      }
    },
    [processInput, handleQuit, appendLog, openModelSelector, openBraveKeyModal, openHelpModal]
  );

  useInput((input, key) => {
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
    if (showBraveKeyModal) {
      if (key.return) {
        const isPlaceholder = braveKeyInput === BRAVE_KEY_PLACEHOLDER;
        const isEmpty = !braveKeyInput.trim();
        const unchanged = isPlaceholder || (braveKeyHadExistingRef.current && isEmpty);
        const keyToSave = unchanged ? "" : braveKeyInput.trim();
        if (keyToSave) saveBraveSearchApiKey(keyToSave);
        setShowBraveKeyModal(false);
        setBraveKeyInput("");
        appendLog(keyToSave ? colors.success("Brave Search API key saved. web_search is now available.") : colors.muted("Brave key unchanged."));
        appendLog("");
      } else if (key.escape) {
        setShowBraveKeyModal(false);
        setBraveKeyInput("");
      } else if (key.backspace || key.delete) {
        setBraveKeyInput((prev) => (prev === BRAVE_KEY_PLACEHOLDER ? "" : prev.slice(0, -1)));
      } else if (input && !key.ctrl && !key.meta && input !== "\b" && input !== "\x7f") {
        setBraveKeyInput((prev) => (prev === BRAVE_KEY_PLACEHOLDER ? input : prev + input));
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
          appendLog(colors.success(`Model set to ${selected}`));
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
              appendLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
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
        setSlashSuggestionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSuggestionIndex((i) => Math.min(filteredSlashCommands.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const selected = filteredSlashCommands[clampedSlashIndex];
        if (selected) {
          setInputValue(selected.cmd);
          setInputCursor(selected.cmd.length);
        }
        return;
      }
      if (key.return) {
        const selected = filteredSlashCommands[clampedSlashIndex];
        if (selected) {
          setInputValue("");
          setInputCursor(0);
          if (selected.cmd === "/models") {
            openModelSelector();
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
            appendLog(colors.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`));
            appendLog("");
          });
          return;
        }
      }
      if (key.escape) {
        setInputValue("");
        setInputCursor(0);
        return;
      }
    }
    if (cursorInAtSegment) {
      if (key.escape) {
        setInputValue((prev) => {
          const lastAt = prev.lastIndexOf("@");
          return lastAt >= 0 ? prev.slice(0, lastAt) + prev.slice(inputCursor) : prev;
        });
        setInputCursor(lastAtIndex);
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
            const cur = inputCursor;
            const lastAt = inputValue.lastIndexOf("@");
            const replacement = "@" + selected;
            setInputValue((prev) => prev.slice(0, lastAt) + replacement + " " + prev.slice(cur));
            setInputCursor(lastAt + replacement.length + 1);
          }
          return;
        }
      }
    }
    if (!showModelSelector && !showPalette) {
      const withModifier = key.ctrl || key.meta || key.shift;
      const scrollUp =
        key.pageUp ||
        (key.upArrow && (withModifier || !inputValue.trim()));
      const scrollDown =
        key.pageDown ||
        (key.downArrow && (withModifier || !inputValue.trim()));
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
      const len = inputValue.length;
      const cur = inputCursor;
      if (key.tab) {
        if (inputValue.trim()) {
          queuedMessageRef.current = inputValue;
          setInputValue("");
          setInputCursor(0);
          appendLog(colors.muted("  Message queued. Send to run after this turn."));
          appendLog("");
        }
        return;
      }
      if (key.escape) {
        if (inputValue.length === 0) {
          if (prevEscRef.current) {
            prevEscRef.current = false;
            const last = lastUserMessageRef.current;
            if (last) {
              setInputValue(last);
              setInputCursor(last.length);
              setMessages((prev) => (prev.length > 0 && prev[prev.length - 1]?.role === "user" ? prev.slice(0, -1) : prev));
              appendLog(colors.muted("  Editing previous message. Submit to replace."));
              appendLog("");
            }
          } else prevEscRef.current = true;
        } else {
          setInputValue("");
          setInputCursor(0);
          prevEscRef.current = false;
        }
        return;
      }
      if (key.return) {
        handleSubmit(inputValue);
        setInputValue("");
        setInputCursor(0);
        return;
      }
      if (key.ctrl && input === "u") {
        setInputValue((prev) => prev.slice(cur));
        setInputCursor(0);
        return;
      }
      if (key.ctrl && input === "k") {
        setInputValue((prev) => prev.slice(0, cur));
        return;
      }
      const killWordBefore =
        (key.ctrl && input === "w") ||
        (key.meta && key.backspace) ||
        (key.meta && key.delete && cur > 0);
      if (killWordBefore) {
        const start = wordStartBackward(inputValue, cur);
        if (start < cur) {
          setInputValue((prev) => prev.slice(0, start) + prev.slice(cur));
          setInputCursor(start);
        }
        return;
      }
      if (key.meta && input === "d") {
        const end = wordEndForward(inputValue, cur);
        if (end > cur) {
          setInputValue((prev) => prev.slice(0, cur) + prev.slice(end));
        }
        return;
      }
      if ((key.meta && key.leftArrow) || (key.ctrl && key.leftArrow)) {
        setInputCursor(wordStartBackward(inputValue, cur));
        return;
      }
      if ((key.meta && key.rightArrow) || (key.ctrl && key.rightArrow)) {
        setInputCursor(wordEndForward(inputValue, cur));
        return;
      }
      if (key.meta && (input === "b" || input === "f")) {
        if (input === "b") setInputCursor(wordStartBackward(inputValue, cur));
        else setInputCursor(wordEndForward(inputValue, cur));
        return;
      }
      if (key.ctrl && (input === "f" || input === "b")) {
        if (input === "f") setInputCursor(Math.min(len, cur + 1));
        else setInputCursor(Math.max(0, cur - 1));
        return;
      }
      if (key.ctrl && input === "j") {
        setInputValue((prev) => prev.slice(0, cur) + "\n" + prev.slice(cur));
        setInputCursor(cur + 1);
        return;
      }
      if (key.ctrl && input === "a") {
        setInputCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setInputCursor(len);
        return;
      }
      if (key.ctrl && input === "h") {
        if (cur > 0) {
          setInputValue((prev) => prev.slice(0, cur - 1) + prev.slice(cur));
          setInputCursor(cur - 1);
        }
        return;
      }
      if (key.ctrl && input === "d") {
        if (cur < len) {
          setInputValue((prev) => prev.slice(0, cur) + prev.slice(cur + 1));
        }
        return;
      }
      if (key.backspace || (key.delete && cur > 0)) {
        if (cur > 0) {
          setInputValue((prev) => prev.slice(0, cur - 1) + prev.slice(cur));
          setInputCursor(cur - 1);
        }
        return;
      }
      if (key.delete && cur < len) {
        setInputValue((prev) => prev.slice(0, cur) + prev.slice(cur + 1));
        return;
      }
      if (key.leftArrow) {
        setInputCursor(Math.max(0, cur - 1));
        return;
      }
      if (key.rightArrow) {
        setInputCursor(Math.min(len, cur + 1));
        return;
      }
      if (input === "?" && !inputValue.trim()) {
        setShowHelpModal(true);
        return;
      }
      if (input === "[I" || input === "[O") {
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputValue((prev) => prev.slice(0, cur) + input + prev.slice(cur));
        setInputCursor(cur + input.length);
        return;
      }
    }
    if (key.ctrl && input === "p") {
      setShowPalette(true);
    }
    if (key.ctrl && input === "c") {
      handleQuit();
    }
  });

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

  const slashSuggestionBoxLines = showSlashSuggestions
    ? 3 + Math.max(1, filteredSlashCommands.length)
    : 0;
  const atSuggestionBoxLines = cursorInAtSegment
    ? 4 + Math.max(1, filteredFilePaths.length)
    : 0;
  const suggestionBoxLines = slashSuggestionBoxLines || atSuggestionBoxLines;
  // Keep a fixed loading row reserved to avoid viewport jumps/flicker when loading starts/stops.
  const reservedLines = 1 + stableInputLineCount + 2;
  const logViewportHeight = Math.max(1, termRows - reservedLines - suggestionBoxLines);
  const effectiveLogLines = logLines;
  const maxLogScrollOffset = Math.max(0, effectiveLogLines.length - logViewportHeight);
  scrollBoundsRef.current = { maxLogScrollOffset, logViewportHeight };
  let logStartIndex = Math.max(
    0,
    effectiveLogLines.length - logViewportHeight - Math.min(logScrollOffset, maxLogScrollOffset)
  );
  if (logScrollOffset >= maxLogScrollOffset - 1 && maxLogScrollOffset > 0) {
    logStartIndex = 0;
  }
  const sliceEnd = logStartIndex + logViewportHeight;
  const visibleLogLines = useMemo(
    () => effectiveLogLines.slice(logStartIndex, sliceEnd),
    [effectiveLogLines, logStartIndex, sliceEnd]
  );
  const useSimpleInputRenderer = inputLineCount > 1;

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
                <Text color={inkColors.textSecondary}> Commands. Type / then pick: /models, /brave, /help, /clear, /status, /q. Ctrl+P palette. </Text>
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
            {braveKeyInput === BRAVE_KEY_PLACEHOLDER && (
              <Text color={inkColors.textSecondary}> Key already set. Type or paste to replace. </Text>
            )}
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

  const footerLines = suggestionBoxLines + 1 + stableInputLineCount;
  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <LogViewport lines={visibleLogLines} startIndex={logStartIndex} height={logViewportHeight} />
        <Box flexDirection="row" marginTop={1} marginBottom={0}>
          <LoadingStatus active={loading} label={loadingLabel} />
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0} height={footerLines}>
        {showSlashSuggestions && (
          <Box flexDirection="column" marginBottom={0} paddingLeft={2} borderStyle="single" borderColor={inkColors.textDisabled}>
            {filteredSlashCommands.length === 0 ? (
              <Text color={inkColors.textSecondary}> No match </Text>
            ) : (
              [...filteredSlashCommands].reverse().map((c, rev) => {
                const i = filteredSlashCommands.length - 1 - rev;
                return (
                  <Text key={c.cmd} color={i === clampedSlashIndex ? inkColors.primary : undefined}>
                    {i === clampedSlashIndex ? "› " : "  "}
                    {c.cmd}
                    <Text color={inkColors.textSecondary}> — {c.desc}</Text>
                  </Text>
                );
              })
            )}
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
        <Text color="gray">
          {" "}
          {icons.tool} {tokenDisplay}
        </Text>
        <Text color="gray">
          {`  ·  / ! @  trackpad/↑/↓ scroll  Opt/Fn+select  Ctrl+J newline  Tab queue  Esc Esc edit  ${pasteShortcut} paste  Ctrl+C exit`}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {inputValue.length === 0 ? (
          <Box flexDirection="row">
            <Text color={inkColors.primary}>{icons.prompt} </Text>
            {cursorBlinkOn ? (
              <Text inverse color={inkColors.primary}> </Text>
            ) : (
              <Text color={inkColors.primary}> </Text>
            )}
            <Text color={inkColors.textSecondary}>Message or / for commands, @ for files, ! for shell, ? for help...</Text>
          </Box>
        ) : (
          (() => {
            const lines = inputValue.split("\n");
            let lineStart = 0;
            return (
              <>
                {lines.flatMap((lineText, lineIdx) => {
                  const lineEnd = lineStart + lineText.length;
                  const cursorOnThisLine = inputCursor >= lineStart && inputCursor <= lineEnd;
                  const cursorOffsetInLine = cursorOnThisLine ? inputCursor - lineStart : -1;
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
                        rowNodes.push(cursorBlinkOn
                          ? (
                            <Text key="cursor-empty-on" inverse color={inkColors.primary}>
                              {"\u00A0"}
                            </Text>
                          )
                          : (
                            <Text key="cursor-empty-off" color={inkColors.primary}>
                              {"\u00A0"}
                            </Text>
                          ));
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
                        rowNodes.push(cursorBlinkOn
                          ? (
                            <Text key="plain-caret-on" inverse color={inkColors.primary}>
                              {curChar}
                            </Text>
                          )
                          : (
                            <Text key="plain-caret-off">{curChar}</Text>
                          ));
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
                          {isLastLogicalLine && isLastVisualOfLine && inputValue.startsWith("!") && (
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
                      lineNodes.push(cursorBlinkOn
                        ? (
                          <Text key="cursor-on" inverse color={inkColors.primary}>
                            {"\u00A0"}
                          </Text>
                        )
                        : (
                          <Text key="cursor-off" color={inkColors.primary}>
                            {"\u00A0"}
                          </Text>
                        ));
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
                            if (cursorBlinkOn) {
                              lineNodes.push(
                                <Text
                                  key={`${segIdx}-b-on`}
                                  inverse
                                  color={usePath ? inkColors.path : inkColors.primary}
                                  bold={"bold" in seg.style && !!seg.style.bold}
                                >
                                  {curChar}
                                </Text>
                              );
                            } else {
                              lineNodes.push(
                                <Text key={`${segIdx}-b-off`} {...seg.style}>
                                  {curChar}
                                </Text>
                              );
                            }
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
                        lineNodes.push(cursorBlinkOn
                          ? (
                            <Text key="cursor-end-on" inverse color={inkColors.primary}>
                              {"\u00A0"}
                            </Text>
                          )
                          : (
                            <Text key="cursor-end-off" color={inkColors.primary}>
                              {"\u00A0"}
                            </Text>
                          ));
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
                        {isLastLogicalLine && isLastVisualOfLine && inputValue.startsWith("!") && (
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
