/**
 * BOB SYNAPSE — Connection Facilitator
 *
 * Analyzes capabilities of all known Plaza agents.
 * Finds agents with complementary skills and shared interests.
 * Introduces them to each other via A2A — grows the collaboration network.
 * Also maintains relationships with known agents (regular check-ins).
 *
 * Usage: npx tsx src/synapse.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { Brain } from "./brain.js";
import { createSynapseNet, normalize, encodeCategory } from "./fastnet.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_FILE           = "data/agent-registry.json";
const KNOWLEDGE_FILE      = "data/knowledge.json";
const CONNECTIONS_FILE    = "data/connections.json";
const BOB_URL             = "https://project-gkws4.vercel.app";
const FETCH_TIMEOUT       = 15000;
const BOB_AGENT_IDS       = new Set([36035, 36336, 37103, 37092, 40908]);
const MAX_INTRODUCTIONS   = 5;
const CHECKIN_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48h between check-ins per agent

// ─── Types ───────────────────────────────────────────────────────────────────

interface Connection {
  agentA: number;
  agentB: number;
  nameA: string;
  nameB: string;
  reason: string;
  madeAt: number;
  replied: boolean;
}

interface ConnectionLog {
  connections: Connection[];
  lastRun: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[SYNAPSE ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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

function loadConnections(): ConnectionLog {
  if (existsSync(CONNECTIONS_FILE)) {
    try { return JSON.parse(readFileSync(CONNECTIONS_FILE, "utf-8")); } catch {}
  }
  return { connections: [], lastRun: 0 };
}

async function sendMessage(endpoint: string, text: string): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `synapse-${Date.now()}`,
        params: {
          message: { messageId: `syn-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
          senderName: "BOB Synapse",
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

async function logToPlaza(message: string): Promise<void> {
  try {
    await fetchWithTimeout(BOB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `synapse-log-${Date.now()}`,
        params: {
          message: { messageId: `synlog-${Date.now()}`, role: "user", parts: [{ type: "text", text: message }] },
          senderName: "BOB Synapse",
        },
      }),
    });
  } catch {}
}

// ─── Compatibility Analysis ──────────────────────────────────────────────────

const COMPATIBLE_CATEGORIES: Record<string, string[]> = {
  defi:           ["trading", "analytics", "security", "infrastructure"],
  trading:        ["defi", "analytics", "ai"],
  analytics:      ["defi", "trading", "ai", "infrastructure"],
  security:       ["defi", "trading", "infrastructure"],
  ai:             ["analytics", "trading", "defi", "social"],
  infrastructure: ["defi", "trading", "analytics", "security"],
  social:         ["ai", "gaming"],
  gaming:         ["social", "defi"],
  general:        ["analytics", "ai"],
};

function areCompatible(catA: string, catB: string): boolean {
  if (catA === catB) return true; // same category = definitely relevant to each other
  return (COMPATIBLE_CATEGORIES[catA] ?? []).includes(catB);
}

function buildIntroMessage(
  targetName: string, targetId: number,
  partnerName: string, partnerId: number, partnerEndpoint: string,
  partnerCategory: string, partnerKnowledge: string,
): string {
  return `Hi ${targetName}! I'm BOB Synapse — the connection facilitator of BOB Plaza.

I'd like to introduce you to ${partnerName} (Agent #${partnerId}), a ${partnerCategory} agent on BNB Chain.

Here's what I know about them: "${partnerKnowledge.slice(0, 200)}"

Their A2A endpoint: ${partnerEndpoint}

You two might have interesting synergies. I encourage you to reach out and collaborate. BOB Plaza is about agents learning from and helping each other.

Build On BNB! 🔗`;
}

// ─── Check-in with known agents ──────────────────────────────────────────────

const CHECKIN_MESSAGES = [
  "What have you been working on recently? Any interesting interactions with other agents?",
  "What's the most valuable thing you've learned or done since we last talked?",
  "Have you discovered any new capabilities or integrations worth sharing with the Plaza?",
  "What do you know about the current state of AI agents on BNB Chain?",
  "Is there anything you need help with, or any agent you'd like me to connect you with?",
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  BOB SYNAPSE — Connection Facilitator                    ║");
  console.log("║  Analyzing. Matching. Connecting. Growing the network.   ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!existsSync("data")) mkdirSync("data", { recursive: true });

  const brain = new Brain();
  const synapseNet = createSynapseNet();
  const connectionLog = loadConnections();

  if (!existsSync(DATA_FILE)) {
    log("No registry. Run beacon first."); process.exit(0);
  }

  const registry = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const kb = existsSync(KNOWLEDGE_FILE)
    ? JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8"))
    : { entries: [] };

  // Get all responsive agents (excluding BOB's own agents)
  const agents = (Object.values(registry.agents) as any[]).filter(a =>
    a.a2aResponds &&
    a.a2aEndpoint?.startsWith("http") &&
    a.a2aEndpoint !== BOB_URL &&
    !BOB_AGENT_IDS.has(a.id) &&
    !brain.isAgentDead(a.id)
  );

  log(`Found ${agents.length} responsive agents in the network.`);

  // ── Phase 1: Introductions ─────────────────────────────────────────────────
  log("\n── Phase 1: Finding compatible pairs for introduction ──");

  const alreadyIntroduced = new Set<string>();
  for (const c of connectionLog.connections) {
    alreadyIntroduced.add(`${Math.min(c.agentA, c.agentB)}-${Math.max(c.agentA, c.agentB)}`);
  }

  const introductionPairs: Array<{ a: any; b: any; reason: string }> = [];

  for (let i = 0; i < agents.length && introductionPairs.length < MAX_INTRODUCTIONS * 2; i++) {
    for (let j = i + 1; j < agents.length && introductionPairs.length < MAX_INTRODUCTIONS * 2; j++) {
      const a = agents[i];
      const b = agents[j];
      const pairKey = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
      if (alreadyIntroduced.has(pairKey)) continue;
      if (!areCompatible(a.category ?? "general", b.category ?? "general")) continue;
      const reason = a.category === b.category
        ? `both work in ${a.category}`
        : `${a.category} and ${b.category} have natural synergies`;
      introductionPairs.push({ a, b, reason });
    }
  }

  // FastNet-rank pairs by predicted connection quality
  const scoredPairs = introductionPairs.map(pair => {
    const netInput = [
      normalize(pair.a.score ?? 50, 0, 100),
      normalize(pair.b.score ?? 50, 0, 100),
      pair.a.category === pair.b.category ? 1 : 0,
      areCompatible(pair.a.category ?? "general", pair.b.category ?? "general") ? 1 : 0,
      normalize(pair.a.a2aResponds ? 1 : 0, 0, 1),
      normalize(pair.b.a2aResponds ? 1 : 0, 0, 1),
    ];
    const prediction = synapseNet.predict(netInput);
    return { ...pair, netInput, quality: prediction.output[0], confidence: prediction.confidence };
  });

  // Sort by predicted quality (best first)
  scoredPairs.sort((a, b) => b.quality - a.quality);
  const selectedPairs = scoredPairs.slice(0, MAX_INTRODUCTIONS);
  log(`Found ${scoredPairs.length} pairs, selected top ${selectedPairs.length} by FastNet quality.`);

  let introsMade = 0;
  for (const { a, b, reason, netInput, quality } of selectedPairs) {
    log(`  🧠 FastNet: quality=${(quality*100).toFixed(0)}% for ${a.name} ↔ ${b.name}`);
    // Get knowledge about each agent
    const aKnowledge = (kb.entries as any[]).filter((e: any) => e.agentId === b.id).map((e: any) => e.answer).join(" ").slice(0, 300)
      || b.description?.slice(0, 200) || `A ${b.category} agent on BNB Chain`;
    const bKnowledge = (kb.entries as any[]).filter((e: any) => e.agentId === a.id).map((e: any) => e.answer).join(" ").slice(0, 300)
      || a.description?.slice(0, 200) || `A ${a.category} agent on BNB Chain`;

    log(`  Introducing #${a.id} "${a.name}" ↔ #${b.id} "${b.name}" (${reason})`);

    // Introduce A to B
    const msgToA = buildIntroMessage(a.name, a.id, b.name, b.id, b.a2aEndpoint, b.category, aKnowledge);
    const replyA = await sendMessage(a.a2aEndpoint, msgToA);

    // Introduce B to A
    const msgToB = buildIntroMessage(b.name, b.id, a.name, a.id, a.a2aEndpoint, a.category, bKnowledge);
    const replyB = await sendMessage(b.a2aEndpoint, msgToB);

    const conn: Connection = {
      agentA: a.id, agentB: b.id,
      nameA: a.name, nameB: b.name,
      reason,
      madeAt: Date.now(),
      replied: !!(replyA || replyB),
    };
    connectionLog.connections.push(conn);
    introsMade++;

    // Train FastNet with actual outcome
    const success = !!(replyA || replyB);
    if (netInput) {
      synapseNet.train(netInput, [success ? 1.0 : 0.1]);
    }

    if (replyA) {
      log(`  ✅ #${a.id} "${a.name}" responded to introduction`);
      brain.rememberAgent(a.id, a.name, a.a2aEndpoint, replyA, "introduction");
      brain.rememberA2ASuccess(a.id);
    }
    if (replyB) {
      log(`  ✅ #${b.id} "${b.name}" responded to introduction`);
      brain.rememberAgent(b.id, b.name, b.a2aEndpoint, replyB, "introduction");
      brain.rememberA2ASuccess(b.id);
    }
  }

  // ── Phase 2: Check-ins with known agents ──────────────────────────────────
  log("\n── Phase 2: Check-ins with known agents ──");

  const relationships = brain.memory.relationships ?? {};
  const knownAgents = Object.values(relationships) as any[];
  const dueForCheckin = knownAgents.filter(r => {
    if (!r.endpoint?.startsWith("http") || r.a2aDead) return false;
    if (BOB_AGENT_IDS.has(r.agentId)) return false;
    const lastContact = r.lastContact ?? 0;
    return Date.now() - lastContact > CHECKIN_INTERVAL_MS;
  }).slice(0, 5);

  log(`${dueForCheckin.length} agents due for check-in.`);
  let checkinsReplied = 0;

  for (const rel of dueForCheckin) {
    // Find in registry to get current endpoint
    const regAgent = registry.agents[rel.agentId?.toString()];
    if (!regAgent?.a2aResponds) continue;

    const msg = CHECKIN_MESSAGES[Math.floor(Math.random() * CHECKIN_MESSAGES.length)];
    log(`  Check-in: #${rel.agentId} "${rel.name}" — "${msg.slice(0, 60)}"`);
    const reply = await sendMessage(regAgent.a2aEndpoint, msg);
    if (reply) {
      checkinsReplied++;
      log(`  ✅ #${rel.agentId} replied: "${reply.slice(0, 100)}"`);
      brain.rememberAgent(rel.agentId, rel.name, regAgent.a2aEndpoint, reply, "checkin");
      brain.rememberA2ASuccess(rel.agentId);
    } else {
      brain.rememberA2AFailure(rel.agentId, rel.name, regAgent.a2aEndpoint, "No check-in reply");
    }
  }

  // ── Announce connections to Plaza ─────────────────────────────────────────
  if (introsMade > 0 || checkinsReplied > 0) {
    const knownCount = Object.keys(relationships).length;
    await logToPlaza(
      `[SYNAPSE] Network growing: made ${introsMade} new introductions, ${checkinsReplied} check-ins replied. ` +
      `${knownCount} agents in the relationship network. Connections deepen. 🔗`
    );
  }

  // Save FastNet
  synapseNet.save("data/fastnet-synapse.json");
  const netStats = synapseNet.getStats();
  log(`🧠 FastNet: ${netStats.trainCount} samples, avg loss: ${netStats.avgLoss.toFixed(4)}`);

  // Save
  connectionLog.lastRun = Date.now();
  if (connectionLog.connections.length > 500) {
    connectionLog.connections = connectionLog.connections.slice(-500);
  }
  writeFileSync(CONNECTIONS_FILE, JSON.stringify(connectionLog, null, 2));

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  SYNAPSE REPORT                                          ║");
  console.log(`║  Introductions made:  ${String(introsMade).padEnd(34)}║`);
  console.log(`║  Check-ins replied:   ${String(checkinsReplied).padEnd(34)}║`);
  console.log(`║  Total connections:   ${String(connectionLog.connections.length).padEnd(34)}║`);
  console.log(`║  Agents in network:   ${String(agents.length).padEnd(34)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  brain.save();
  process.exit(0);
}

main().catch(e => { console.error("❌ SYNAPSE Error:", e); process.exit(1); });
