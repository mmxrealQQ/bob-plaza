/**
 * BOB SCHOLAR — Collective Knowledge Agent
 *
 * Visits all known A2A agents in the Plaza.
 * Generates intelligent questions using Groq LLM.
 * Builds a shared knowledge base from all responses.
 * Makes the collective intelligence of all agents available to everyone.
 *
 * Usage: npx tsx src/scholar.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { Brain } from "./brain.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_FILE      = "data/agent-registry.json";
const KNOWLEDGE_FILE = "data/knowledge.json";
const BOB_URL        = "https://project-gkws4.vercel.app";
const FETCH_TIMEOUT  = 20000;
const GROQ_MODEL     = "llama-3.3-70b-versatile";
const BOB_AGENT_IDS  = new Set([36035, 36336, 37103, 37092, 40908]);
const MAX_AGENTS_PER_RUN = 10;
const MAX_QUESTIONS_PER_AGENT = 5;

// ─── Types ───────────────────────────────────────────────────────────────────

interface KnowledgeEntry {
  id: string;
  agentId: number;
  agentName: string;
  question: string;
  answer: string;
  topic: string;
  ts: number;
}

interface KnowledgeBase {
  entries: KnowledgeEntry[];
  lastUpdated: number;
  totalLearned: number;
  agentsCovered: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[SCHOLAR ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isUsefulAnswer(answer: string): boolean {
  const s = answer.trim();
  if (s.length < 30) return false;
  if (/^(I('m| am) (sorry|unable|not sure)|error|exception|I (can't|cannot) help)/i.test(s.slice(0, 100))) return false;
  return true;
}

function loadKnowledge(): KnowledgeBase {
  if (existsSync(KNOWLEDGE_FILE)) {
    try { return JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8")); } catch {}
  }
  return { entries: [], lastUpdated: 0, totalLearned: 0, agentsCovered: 0 };
}

function saveKnowledge(kb: KnowledgeBase) {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  writeFileSync(KNOWLEDGE_FILE, JSON.stringify(kb, null, 2));
}

// ─── LLM: Generate Questions ─────────────────────────────────────────────────

async function generateQuestions(
  agentName: string,
  description: string,
  category: string,
  existingAnswers: string[],
): Promise<string[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return defaultQuestions(agentName, category);

  const existingContext = existingAnswers.length > 0
    ? `\nWe already know this about them:\n${existingAnswers.slice(-3).map(a => `- ${a.slice(0, 150)}`).join("\n")}`
    : "";

  const prompt = `You are BOB Scholar, a knowledge collector for BOB Plaza — a collective AI intelligence hub on BNB Chain.

You are about to ask questions to an AI agent named "${agentName}" in the category "${category}".
Their description: "${description.slice(0, 300)}"${existingContext}

Generate exactly ${MAX_QUESTIONS_PER_AGENT} specific, insightful questions to learn from this agent. Focus on:
- What specific technical capabilities they have
- How they work under the hood
- Real use cases and examples
- What they know about BNB Chain / their ecosystem
- What other agents or protocols they interact with

Return ONLY the questions, one per line, no numbering, no extra text.`;

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });
    if (!resp.ok) return defaultQuestions(agentName, category);
    const data = (await resp.json()) as any;
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    const questions = text.split("\n").map((q: string) => q.trim()).filter((q: string) => q.length > 10 && q.includes("?"));
    return questions.length >= 3 ? questions.slice(0, MAX_QUESTIONS_PER_AGENT) : defaultQuestions(agentName, category);
  } catch {
    return defaultQuestions(agentName, category);
  }
}

function defaultQuestions(name: string, category: string): string[] {
  const base = [
    `What specific tasks can ${name} help with? Give concrete examples.`,
    `How does ${name} work technically? What is the architecture?`,
    `What data or services does ${name} have access to on BNB Chain?`,
    `What are the most important things happening in the ${category} space right now?`,
    `What other AI agents or protocols does ${name} work with or know about?`,
  ];
  return base;
}

// ─── Ask Agent ───────────────────────────────────────────────────────────────

async function askAgent(endpoint: string, question: string, senderName = "BOB Scholar"): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `scholar-${Date.now()}`,
        params: {
          message: { messageId: `ask-${Date.now()}`, role: "user", parts: [{ kind: "text", text: question }] },
          senderName,
        },
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result?.artifacts?.[0]?.parts?.[0]?.text
      ?? data.result?.status?.message?.parts?.[0]?.text
      ?? data.result?.message?.parts?.[0]?.text
      ?? null;
  } catch { return null; }
}

// ─── Synthesize Knowledge ────────────────────────────────────────────────────

async function synthesize(kb: KnowledgeBase): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || kb.entries.length === 0) return `Knowledge base: ${kb.entries.length} entries from ${kb.agentsCovered} agents.`;

  const recent = kb.entries.slice(-30).map(e => `[${e.agentName}] Q: ${e.question} A: ${e.answer.slice(0, 200)}`).join("\n\n");

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{
          role: "user",
          content: `Summarize the key insights from these AI agent conversations on BNB Chain in 3 sentences. Focus on what's most interesting and useful:\n\n${recent}`,
        }],
        max_tokens: 200,
        temperature: 0.5,
      }),
    });
    if (!resp.ok) return `Knowledge base: ${kb.entries.length} entries.`;
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content?.trim() ?? `Knowledge base: ${kb.entries.length} entries.`;
  } catch {
    return `Knowledge base: ${kb.entries.length} entries from ${kb.agentsCovered} agents.`;
  }
}

async function logToPlaza(message: string): Promise<void> {
  try {
    await fetchWithTimeout(BOB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `scholar-log-${Date.now()}`,
        params: {
          message: { messageId: `slog-${Date.now()}`, role: "user", parts: [{ kind: "text", text: message }] },
          senderName: "BOB Scholar",
        },
      }),
    });
  } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  BOB SCHOLAR — Collective Knowledge Agent                ║");
  console.log("║  Learning from all agents. Building shared intelligence. ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!existsSync("data")) mkdirSync("data", { recursive: true });

  const brain = new Brain();
  const kb = loadKnowledge();

  // Load registry
  if (!existsSync(DATA_FILE)) {
    log("No registry found. Run beacon first.");
    process.exit(0);
  }
  const registry = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const agents = (Object.values(registry.agents) as any[]).filter(a =>
    a.a2aResponds &&
    a.a2aEndpoint?.startsWith("http") &&
    a.a2aEndpoint !== BOB_URL &&
    !BOB_AGENT_IDS.has(a.id) &&
    !brain.isAgentDead(a.id)
  );

  log(`Found ${agents.length} responsive agents. Learning from up to ${MAX_AGENTS_PER_RUN} per run.`);

  // Prioritize agents we've talked to least
  const askedCounts: Record<number, number> = {};
  for (const e of kb.entries) {
    askedCounts[e.agentId] = (askedCounts[e.agentId] ?? 0) + 1;
  }
  agents.sort((a, b) => (askedCounts[a.id] ?? 0) - (askedCounts[b.id] ?? 0));
  const targets = agents.slice(0, MAX_AGENTS_PER_RUN);

  let totalNewEntries = 0;
  let agentsLearned = 0;

  for (const agent of targets) {
    log(`\n── Learning from #${agent.id} "${agent.name}" (${agent.category}) ──`);

    const existingForAgent = kb.entries.filter(e => e.agentId === agent.id).map(e => e.answer);
    const alreadyAsked = new Set(kb.entries.filter(e => e.agentId === agent.id).map(e => e.question.toLowerCase()));

    const questions = await generateQuestions(agent.name, agent.description ?? "", agent.category ?? "general", existingForAgent);
    const freshQuestions = questions.filter(q => !alreadyAsked.has(q.toLowerCase()));

    if (freshQuestions.length === 0) {
      log(`  All questions already asked. Skipping.`);
      continue;
    }

    let learnedFromAgent = 0;
    for (const question of freshQuestions) {
      const answer = await askAgent(agent.a2aEndpoint, question);
      if (!answer || !isUsefulAnswer(answer)) {
        log(`  ✗ "${question.slice(0, 60)}" — no useful answer`);
        continue;
      }

      const entry: KnowledgeEntry = {
        id: `${agent.id}-${Date.now()}`,
        agentId: agent.id,
        agentName: agent.name,
        question,
        answer: answer.slice(0, 1000),
        topic: agent.category ?? "general",
        ts: Date.now(),
      };
      kb.entries.push(entry);
      learnedFromAgent++;
      totalNewEntries++;
      log(`  ✓ "${question.slice(0, 60)}" → ${answer.length} chars`);
    }

    if (learnedFromAgent > 0) {
      agentsLearned++;
      brain.rememberA2ASuccess(agent.id);
    }
  }

  // Keep knowledge base at max 2000 entries (newest first)
  if (kb.entries.length > 2000) {
    kb.entries = kb.entries.slice(-2000);
  }

  kb.lastUpdated = Date.now();
  kb.totalLearned += totalNewEntries;
  kb.agentsCovered = new Set(kb.entries.map(e => e.agentId)).size;

  saveKnowledge(kb);
  log(`\nKnowledge base: ${kb.entries.length} entries from ${kb.agentsCovered} agents.`);

  // Synthesize and share insights
  if (totalNewEntries > 0) {
    const synthesis = await synthesize(kb);
    log(`\nSynthesis: ${synthesis}`);
    await logToPlaza(`[SCHOLAR] Learned ${totalNewEntries} new things from ${agentsLearned} agents. ${synthesis}`);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  SCHOLAR REPORT                                          ║");
  console.log(`║  New entries:    ${String(totalNewEntries).padEnd(39)}║`);
  console.log(`║  Agents covered: ${String(kb.agentsCovered).padEnd(39)}║`);
  console.log(`║  Total knowledge:${String(kb.entries.length).padEnd(39)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  brain.save();
  process.exit(0);
}

main().catch(e => { console.error("❌ SCHOLAR Error:", e); process.exit(1); });
