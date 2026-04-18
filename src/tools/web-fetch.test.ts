/**
 * Live HTTP tests for web_fetch (plain fetch + Playwright fallback).
 * Run: npm run test:web-fetch
 */
import "dotenv/config";
import { webFetch } from "./web.js";

type Case = { name: string; url: string; minLen: number; mustNotStartWith?: string };

const CASES: Case[] = [
  { name: "example.com", url: "https://example.com/", minLen: 80 },
  {
    name: "nbcnews article (browser-like fetch)",
    url: "https://www.nbcnews.com/news/us-news/jeffrey-epstein-s-bizarre-blue-striped-building-private-island-raised-n1037511",
    minLen: 400,
    mustNotStartWith: "error:",
  },
];

async function run(): Promise<void> {
  let failed = 0;
  for (const c of CASES) {
    process.stdout.write(`  ${c.name} … `);
    try {
      const out = await webFetch({ url: c.url });
      if (c.mustNotStartWith && out.startsWith(c.mustNotStartWith)) {
        console.log(`FAIL\n${out.slice(0, 500)}`);
        failed++;
        continue;
      }
      if (out.length < c.minLen) {
        console.log(`FAIL (len ${out.length} < ${c.minLen})\n${out.slice(0, 600)}`);
        failed++;
        continue;
      }
      console.log(`ok (${out.length} chars)`);
    } catch (e) {
      console.log(`FAIL (${e instanceof Error ? e.message : String(e)})`);
      failed++;
    }
  }
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void run();
