import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolArgs } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const TERM_GRACE_MS = 2_000;
const JOBS_DIR = path.join(tmpdir(), "ideacode-jobs");
const JOBS_DB_PATH = path.join(JOBS_DIR, "jobs.json");

type JobRecord = {
  id: string;
  cmd: string;
  pid: number;
  cwd: string;
  startedAt: string;
  logPath: string;
  statusPath: string;
};

function clampTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
}

function resolveTimeoutMs(args: ToolArgs): number {
  const fromArgs = Number(args.timeout_ms);
  if (Number.isFinite(fromArgs) && fromArgs > 0) return clampTimeoutMs(fromArgs);
  const fromEnv = Number.parseInt(process.env.IDEACODE_BASH_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampTimeoutMs(fromEnv);
  return DEFAULT_TIMEOUT_MS;
}

function shSingleQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function makeJobId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${Date.now().toString(36)}_${rand}`;
}

async function ensureJobsDir(): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
}

async function loadJobs(): Promise<Record<string, JobRecord>> {
  try {
    const raw = await readFile(JOBS_DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, JobRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveJobs(db: Record<string, JobRecord>): Promise<void> {
  await ensureJobsDir();
  await writeFile(JOBS_DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readExitCode(statusPath: string): Promise<number | null> {
  try {
    const raw = await readFile(statusPath, "utf8");
    const m = raw.match(/EXIT_CODE:(-?\d+)/);
    if (!m) return null;
    return Number.parseInt(m[1] ?? "", 10);
  } catch {
    return null;
  }
}

export function runBash(args: ToolArgs): Promise<string> {
  return new Promise((resolve) => {
    const cmd = (args.cmd as string) ?? "";
    const proc = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    const outputChunks: string[] = [];
    let resolved = false;
    const done = (out: string) => {
      if (resolved) return;
      resolved = true;
      resolve(out);
    };
    const onData = (s: string) => outputChunks.push(s);
    proc.stdout?.on("data", (chunk: Buffer) => onData(chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => onData(chunk.toString()));
    const timeoutMs = resolveTimeoutMs(args);
    const t = setTimeout(() => {
      proc.kill("SIGTERM");
      outputChunks.push(`\n(timeout ${Math.round(timeoutMs / 1000)}s reached, sending SIGTERM…)`);
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        outputChunks.push("\n(process did not exit after SIGTERM; sent SIGKILL)");
      }, TERM_GRACE_MS);
      proc.on("close", () => clearTimeout(killTimer));
    }, timeoutMs);
    proc.on("close", () => {
      clearTimeout(t);
      done(outputChunks.join("").trim() || "(empty)");
    });
  });
}

export async function runBashDetach(args: ToolArgs): Promise<string> {
  const cmd = String(args.cmd ?? "").trim();
  if (!cmd) return "error: missing cmd";
  await ensureJobsDir();
  const id = makeJobId();
  const cwd = process.cwd();
  const logPath = path.join(JOBS_DIR, `${id}.log`);
  const statusPath = path.join(JOBS_DIR, `${id}.status`);

  await appendFile(logPath, `# ideacode detached job ${id}\n# cwd: ${cwd}\n# cmd: ${cmd}\n\n`);

  const wrapped = [
    cmd,
    "__ec=$?",
    `printf "EXIT_CODE:%s\\n" "$__ec" > ${shSingleQuote(statusPath)}`,
    "exit $__ec",
  ].join("\n");

  const logFd = openSync(logPath, "a");
  const proc = spawn("/bin/sh", ["-lc", wrapped], {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  proc.unref();

  const db = await loadJobs();
  db[id] = {
    id,
    cmd,
    pid: proc.pid ?? -1,
    cwd,
    startedAt: new Date().toISOString(),
    logPath,
    statusPath,
  };
  await saveJobs(db);

  return `ok: ${id} pid=${proc.pid ?? -1}\nlog=${logPath}\nuse bash_status(job_id=${id}) or bash_logs(job_id=${id})`;
}

export async function runBashStatus(args: ToolArgs): Promise<string> {
  const jobId = String(args.job_id ?? "").trim();
  if (!jobId) return "error: missing job_id";
  const db = await loadJobs();
  const job = db[jobId];
  if (!job) return `error: unknown job_id ${jobId}`;
  const running = job.pid > 0 ? isPidRunning(job.pid) : false;
  const exitCode = await readExitCode(job.statusPath);
  const status =
    running ? "running" : exitCode == null ? "unknown (not running, no exit code)" : `finished (exit=${exitCode})`;
  return [
    `job_id: ${job.id}`,
    `status: ${status}`,
    `pid: ${job.pid}`,
    `started_at: ${job.startedAt}`,
    `cwd: ${job.cwd}`,
    `log: ${job.logPath}`,
  ].join("\n");
}

export async function runBashLogs(args: ToolArgs): Promise<string> {
  const jobId = String(args.job_id ?? "").trim();
  if (!jobId) return "error: missing job_id";
  const tailLinesRaw = Number(args.tail_lines);
  const tailLines = Number.isFinite(tailLinesRaw)
    ? Math.max(1, Math.min(500, Math.round(tailLinesRaw)))
    : 80;
  const db = await loadJobs();
  const job = db[jobId];
  if (!job) return `error: unknown job_id ${jobId}`;
  try {
    const content = await readFile(job.logPath, "utf8");
    const lines = content.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - tailLines)).join("\n").trim() || "(empty)";
  } catch (err) {
    return `error: failed to read logs for ${jobId}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
