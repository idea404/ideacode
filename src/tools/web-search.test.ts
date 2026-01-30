/**
 * Test module for web_search (Brave Search API only).
 * Requires BRAVE_API_KEY or BRAVE_SEARCH_API_KEY in env or .env (free tier: https://brave.com/search/api).
 * Run: npm run test:web-search
 */
import "dotenv/config";
import { getBraveSearchApiKey } from "../config.js";
import { webSearch } from "./web.js";

const TESTS = [
  {
    name: "single search returns results",
    query: "nodejs typescript",
    expectError: false,
    expectNonEmpty: true,
  },
  {
    name: "empty query returns error",
    query: "",
    expectError: true,
    expectNonEmpty: false,
  },
  {
    name: "whitespace-only query returns error",
    query: "   ",
    expectError: true,
    expectNonEmpty: false,
  },
  {
    name: "specific query returns results",
    query: "ideacode cli openrouter",
    expectError: false,
    expectNonEmpty: true,
  },
];

async function runOne(
  name: string,
  query: string,
  expectError: boolean,
  expectNonEmpty: boolean
): Promise<{ ok: boolean; message: string }> {
  const out = await webSearch({ query });
  const isError = out.startsWith("error:");
  const isEmpty = !out.trim() || out === "No results found.";

  if (expectError && !isError) {
    return { ok: false, message: `expected error, got: ${out.slice(0, 80)}...` };
  }
  if (!expectError && isError) {
    return { ok: false, message: `expected success, got: ${out.slice(0, 120)}` };
  }
  if (!expectError && expectNonEmpty && isEmpty) {
    return { ok: false, message: `expected non-empty results, got: ${out.slice(0, 80)}` };
  }
  return { ok: true, message: isError ? out.slice(0, 60) : `got ${out.split("\n").length} lines` };
}

async function runRapidTwo(): Promise<{ ok: boolean; message: string }> {
  const q1 = await webSearch({ query: "ink react cli" });
  const q2 = await webSearch({ query: "typescript strict" });
  const e1 = q1.startsWith("error:");
  const e2 = q2.startsWith("error:");
  if (e1 && e2) {
    return { ok: false, message: `both rapid searches failed: ${q1.slice(0, 50)}... / ${q2.slice(0, 50)}...` };
  }
  if (e1) return { ok: false, message: `first search failed: ${q1.slice(0, 80)}` };
  if (e2) return { ok: false, message: `second search failed: ${q2.slice(0, 80)}` };
  return { ok: true, message: "both rapid searches succeeded" };
}

async function main(): Promise<void> {
  if (!getBraveSearchApiKey()) {
    console.log("web_search tests require BRAVE_API_KEY or BRAVE_SEARCH_API_KEY (free tier: https://brave.com/search/api).");
    process.exit(1);
  }

  console.log("web_search tests (Brave Search API)\n");

  let failed = 0;
  for (const t of TESTS) {
    process.stdout.write(`  ${t.name} ... `);
    try {
      const result = await runOne(t.name, t.query, t.expectError, t.expectNonEmpty);
      if (result.ok) {
        console.log("ok");
      } else {
        console.log("FAIL");
        console.log(`    ${result.message}`);
        failed++;
      }
    } catch (err) {
      console.log("FAIL");
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  process.stdout.write("  two rapid searches ... ");
  try {
    const result = await runRapidTwo();
    if (result.ok) {
      console.log("ok");
    } else {
      console.log("FAIL");
      console.log(`    ${result.message}`);
      failed++;
    }
  } catch (err) {
    console.log("FAIL");
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log("All web_search tests passed.");
}

main();
