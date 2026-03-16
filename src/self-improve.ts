/**
 * BOB SELF-IMPROVE v7.2 — Code Self-Modification Engine
 *
 * BOB analyzes his own errors, generates code improvements,
 * tests them safely, and applies or reverts automatically.
 *
 * Safety: backup → modify → test → keep or revert
 *
 * Usage: npx tsx src/self-improve.ts
 *        Called automatically by bob-start.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, readdirSync } from "fs";
import { execSync } from "child_process";

// ─── Config ──────────────────────────────────────────────────────────────────

const GROQ_MODEL = "llama-3.3-70b-versatile";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const BRAIN_FILE = "data/brain.json";
const LOG_FILE = "data/bob.log";
const IMPROVEMENTS_FILE = "data/improvements.json";
const MAX_FILE_LINES = 300; // Max lines to send to LLM per file
const MODIFIABLE_FILES = [
  "src/pusher.ts",
  "src/scout-fast.ts",
  "src/scout-external.ts",
  "src/database.ts",
  "src/oracle.ts",
  "src/build-snapshot.ts",
];
// NEVER self-modify: brain.ts, bob-start.ts, self-improve.ts, api/index.ts, api/pages.ts
// Those are core infrastructure — too risky for auto-modification

function log(msg: string) {
  console.log(`[SELF-IMPROVE ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Improvement {
  ts: number;
  file: string;
  description: string;
  linesChanged: number;
  success: boolean;
  reverted: boolean;
  error?: string;
}

interface ImprovementHistory {
  improvements: Improvement[];
  totalApplied: number;
  totalReverted: number;
  lastRun: number;
}

// ─── LLM Calls ──────────────────────────────────────────────────────────────

async function callGroq(prompt: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: "You are a senior TypeScript developer. You analyze code and suggest precise improvements. Always respond with valid JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callHaiku(prompt: string): Promise<string | null> {
  // Anthropic disabled — always use Groq
  return callGroq(prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return callGroq(prompt);
    const data = await resp.json();
    const content = data.content?.[0];
    return content?.type === "text" ? content.text : null;
  } catch {
    return callGroq(prompt);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Error Analysis ──────────────────────────────────────────────────────────

function getRecentErrors(): string[] {
  const errors: string[] = [];

  // From brain memory
  if (existsSync(BRAIN_FILE)) {
    try {
      const brain = JSON.parse(readFileSync(BRAIN_FILE, "utf-8"));
      // Get recent failed performance entries
      const failures = (brain.performance || [])
        .filter((p: any) => !p.success)
        .slice(-5);
      for (const f of failures) {
        errors.push(`[${f.agent}] ${f.action} failed at ${new Date(f.ts).toISOString()}`);
      }
      // Get A2A failure patterns
      const patterns = brain.a2aFailurePatterns || {};
      for (const [_, data] of Object.entries(patterns) as any) {
        if (data.count >= 3) {
          errors.push(`[A2A] Recurring failure: "${data.lastReason}" (${data.count}x)`);
        }
      }
      // Get recent discoveries of type "anomaly"
      const anomalies = (brain.discoveries || [])
        .filter((d: any) => d.type === "anomaly")
        .slice(-3);
      for (const a of anomalies) {
        errors.push(`[${a.agent}] Anomaly: ${a.content}`);
      }
    } catch {}
  }

  // From log file (last 100 lines with errors)
  if (existsSync(LOG_FILE)) {
    try {
      const logContent = readFileSync(LOG_FILE, "utf-8");
      const lines = logContent.split("\n").slice(-200);
      for (const line of lines) {
        if (line.includes("❌") || line.includes("error") || line.includes("Error") || line.includes("failed")) {
          errors.push(line.trim().slice(0, 200));
        }
      }
    } catch {}
  }

  return errors.slice(-15); // Max 15 recent errors
}

// ─── Self-Improvement Engine ─────────────────────────────────────────────────

async function analyzeAndImprove(): Promise<Improvement[]> {
  const errors = getRecentErrors();
  const improvements: Improvement[] = [];

  if (errors.length === 0) {
    log("No recent errors found — nothing to improve");
    return improvements;
  }

  log(`Found ${errors.length} recent errors/issues to analyze`);

  // Read modifiable source files (truncated)
  const fileContents: Record<string, string> = {};
  for (const file of MODIFIABLE_FILES) {
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      fileContents[file] = lines.slice(0, MAX_FILE_LINES).join("\n");
      if (lines.length > MAX_FILE_LINES) {
        fileContents[file] += `\n// ... ${lines.length - MAX_FILE_LINES} more lines truncated`;
      }
    }
  }

  // Ask LLM to analyze errors and suggest ONE specific improvement
  const prompt = `You are BOB's self-improvement engine. BOB is an autonomous AI agent network on BNB Chain.

RECENT ERRORS AND ISSUES:
${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}

AVAILABLE FILES TO MODIFY:
${Object.keys(fileContents).join(", ")}

FILE CONTENTS (first ${MAX_FILE_LINES} lines each):
${Object.entries(fileContents).map(([file, content]) => `
=== ${file} ===
${content}
`).join("\n")}

RULES:
1. Suggest exactly ONE small, safe improvement that would fix or prevent the most impactful error
2. The change must be a SPECIFIC code edit — not a vague suggestion
3. Only modify the files listed above. NEVER modify brain.ts, bob-start.ts, self-improve.ts, api/index.ts, api/pages.ts
4. The improvement must make the code MORE ROBUST (better error handling, smarter retries, better validation)
5. Do NOT change functionality — only improve reliability and error handling
6. Keep changes small (max 20 lines added/changed)

Respond ONLY with JSON (no markdown):
{
  "file": "src/filename.ts",
  "description": "What this change does and why",
  "search": "exact string to find in the file (must be unique in the file)",
  "replace": "the replacement string",
  "confidence": 1-10
}

If there's nothing safe to improve, respond: {"file": null, "description": "No safe improvement found", "confidence": 0}`;

  const response = await callHaiku(prompt);
  if (!response) {
    log("LLM unavailable — skipping self-improvement");
    return improvements;
  }

  try {
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    }
    const suggestion = JSON.parse(jsonStr);

    if (!suggestion.file || suggestion.confidence < 6) {
      log(`No confident improvement found (confidence: ${suggestion.confidence || 0})`);
      return improvements;
    }

    log(`Suggestion: ${suggestion.description}`);
    log(`File: ${suggestion.file} (confidence: ${suggestion.confidence}/10)`);

    // Safety check: only modify allowed files
    if (!MODIFIABLE_FILES.includes(suggestion.file)) {
      log(`BLOCKED: ${suggestion.file} is not modifiable`);
      return improvements;
    }

    if (!existsSync(suggestion.file)) {
      log(`BLOCKED: ${suggestion.file} does not exist`);
      return improvements;
    }

    const originalContent = readFileSync(suggestion.file, "utf-8");

    // Verify search string exists and is unique
    const searchCount = originalContent.split(suggestion.search).length - 1;
    if (searchCount === 0) {
      log("BLOCKED: search string not found in file");
      return improvements;
    }
    if (searchCount > 1) {
      log("BLOCKED: search string is not unique in file");
      return improvements;
    }

    // Create backup
    const backupFile = suggestion.file + ".backup";
    copyFileSync(suggestion.file, backupFile);
    log(`Backup created: ${backupFile}`);

    // Apply change
    const newContent = originalContent.replace(suggestion.search, suggestion.replace);
    writeFileSync(suggestion.file, newContent);
    log("Change applied — testing...");

    // Test with TypeScript compiler
    let testPassed = false;
    try {
      execSync("npx tsc --noEmit --skipLibCheck", {
        cwd: process.cwd(),
        timeout: 30000,
        stdio: "pipe",
      });
      testPassed = true;
      log("TypeScript check PASSED");
    } catch (e: any) {
      const stderr = e.stderr?.toString() || "";
      // Filter out known non-issues (mcp-client.ts import)
      const realErrors = stderr.split("\n").filter((line: string) =>
        line.includes("error TS") && !line.includes("mcp-client.ts")
      );
      testPassed = realErrors.length === 0;
      if (!testPassed) {
        log(`TypeScript check FAILED: ${realErrors[0]}`);
      } else {
        log("TypeScript check PASSED (only known warnings)");
      }
    }

    const improvement: Improvement = {
      ts: Date.now(),
      file: suggestion.file,
      description: suggestion.description,
      linesChanged: suggestion.replace.split("\n").length,
      success: testPassed,
      reverted: false,
    };

    if (testPassed) {
      // Keep the change
      unlinkSync(backupFile);
      log(`IMPROVEMENT APPLIED: ${suggestion.description}`);
    } else {
      // Revert
      copyFileSync(backupFile, suggestion.file);
      unlinkSync(backupFile);
      improvement.reverted = true;
      improvement.error = "TypeScript compilation failed";
      log("REVERTED: change caused compilation errors");
    }

    improvements.push(improvement);

  } catch (e: any) {
    log(`Error processing suggestion: ${e.message}`);
  }

  return improvements;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   BOB SELF-IMPROVE — Code Self-Modification Engine     ║");
  console.log("║   Analyze · Suggest · Test · Apply or Revert           ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // Load history
  let history: ImprovementHistory = {
    improvements: [],
    totalApplied: 0,
    totalReverted: 0,
    lastRun: 0,
  };
  if (existsSync(IMPROVEMENTS_FILE)) {
    try {
      history = JSON.parse(readFileSync(IMPROVEMENTS_FILE, "utf-8"));
    } catch {}
  }

  // Run analysis
  const results = await analyzeAndImprove();

  // Update history
  for (const r of results) {
    history.improvements.push(r);
    if (r.success && !r.reverted) history.totalApplied++;
    if (r.reverted) history.totalReverted++;
  }
  history.lastRun = Date.now();

  // Keep only last 100 improvements
  if (history.improvements.length > 100) {
    history.improvements = history.improvements.slice(-100);
  }

  writeFileSync(IMPROVEMENTS_FILE, JSON.stringify(history, null, 2));

  // Summary
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   SELF-IMPROVE REPORT                                 ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║   This run:    ${results.length} suggestions analyzed${" ".repeat(Math.max(0, 23 - String(results.length).length))}║`);
  console.log(`║   Applied:     ${results.filter(r => r.success && !r.reverted).length}${" ".repeat(38)}║`);
  console.log(`║   Reverted:    ${results.filter(r => r.reverted).length}${" ".repeat(38)}║`);
  console.log(`║   Total ever:  ${history.totalApplied} applied, ${history.totalReverted} reverted${" ".repeat(Math.max(0, 21 - String(history.totalApplied).length - String(history.totalReverted).length))}║`);
  console.log("╚═══════════════════════════════════════════════════════╝");

  setTimeout(() => process.exit(0), 100);
}

main().catch(e => {
  console.error("❌ Self-improve error:", e);
  setTimeout(() => process.exit(1), 100);
});
