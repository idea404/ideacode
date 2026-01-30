import { spawn } from "node:child_process";
import type { ToolArgs } from "./types.js";

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
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      outputChunks.push("\n(timed out after 30s)");
      done(outputChunks.join("").trim() || "(empty)");
    }, 30_000);
    proc.on("close", () => {
      clearTimeout(t);
      done(outputChunks.join("").trim() || "(empty)");
    });
  });
}
