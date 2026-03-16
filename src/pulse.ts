/**
 * BOB PULSE — Health & Growth Monitor
 *
 * Monitors A2A health of all known Plaza agents.
 * Tracks collective knowledge growth metrics.
 * Fetches BNB Chain market context.
 * Reports the heartbeat of the network.
 * Triggers on-chain metadata updates when significant growth detected.
 *
 * Usage: npx tsx src/pulse.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { Brain } from "./brain.js";
import { createPulseNet, normalize } from "./fastnet.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_FILE       = "data/agent-registry.json";
const KNOWLEDGE_FILE  = "data/knowledge.json";
const CONNECTIONS_FILE= "data/connections.json";
const PULSE_FILE      = "data/pulse-history.json";
const BOB_URL         = "https://project-gkws4.vercel.app";
const FETCH_TIMEOUT   = 8000;
const BOB_AGENT_IDS   = new Set([36035, 36336, 37103, 37092, 40908]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface PulseSnapshot {
  ts: number;
  date: string;
  totalAgents: number;
  respondingAgents: number;
  knowledgeEntries: number;
  agentsCovered: number;
  connections: number;
  bnbPrice: number | null;
  bscTvl: string | null;
  networkHealth: number; // 0-100
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[PULSE ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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

async function pingA2A(endpoint: string): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: "pulse-ping",
        params: { message: { messageId: `ping-${Date.now()}`, role: "user", parts: [{ type: "text", text: "ping" }] } },
      }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!(data.jsonrpc || data.result);
  } catch { return false; }
}

async function getMarketData(): Promise<{ bnbPrice: number | null; bscTvl: string | null }> {
  const [bnbResp, tvlResp] = await Promise.allSettled([
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd", { signal: AbortSignal.timeout(5000) }),
    fetch("https://api.llama.fi/v2/chains", { signal: AbortSignal.timeout(5000) }),
  ]);

  let bnbPrice: number | null = null;
  let bscTvl: string | null = null;

  if (bnbResp.status === "fulfilled" && bnbResp.value.ok) {
    try { const d = await bnbResp.value.json(); bnbPrice = d.binancecoin?.usd ?? null; } catch {}
  }
  if (tvlResp.status === "fulfilled" && tvlResp.value.ok) {
    try {
      const chains = await tvlResp.value.json();
      const bsc = chains.find((c: any) => c.name === "BSC");
      if (bsc) bscTvl = `$${(bsc.tvl / 1e9).toFixed(2)}B`;
    } catch {}
  }
  return { bnbPrice, bscTvl };
}

async function logToPlaza(message: string): Promise<void> {
  try {
    await fetchWithTimeout(BOB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `pulse-log-${Date.now()}`,
        params: {
          message: { messageId: `plog-${Date.now()}`, role: "user", parts: [{ type: "text", text: message }] },
          senderName: "BOB Pulse",
        },
      }),
    });
  } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  BOB PULSE — Health & Growth Monitor                     ║");
  console.log("║  Listening to the heartbeat of the network.              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!existsSync("data")) mkdirSync("data", { recursive: true });

  const brain = new Brain();
  const pulseNet = createPulseNet();

  const registry = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, "utf-8")) : { agents: {}, stats: {}, maxAgentId: 0 };
  const kb = existsSync(KNOWLEDGE_FILE) ? JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8")) : { entries: [], agentsCovered: 0 };
  const connLog = existsSync(CONNECTIONS_FILE) ? JSON.parse(readFileSync(CONNECTIONS_FILE, "utf-8")) : { connections: [] };
  const pulseHistory: PulseSnapshot[] = existsSync(PULSE_FILE) ? JSON.parse(readFileSync(PULSE_FILE, "utf-8")) : [];

  const allAgents = (Object.values(registry.agents) as any[]);
  const plazaAgents = allAgents.filter(a =>
    a.a2aEndpoint?.startsWith("http") &&
    a.a2aEndpoint !== BOB_URL &&
    !BOB_AGENT_IDS.has(a.id)
  );

  log(`Registry: ${allAgents.length} total agents, ${plazaAgents.length} with A2A endpoints`);

  // ── A2A Health Check (sample up to 20 agents) ─────────────────────────────
  log("\nRunning A2A health checks...");
  const sampleAgents = plazaAgents
    .filter(a => a.a2aResponds && !brain.isAgentDead(a.id))
    .sort(() => Math.random() - 0.5)
    .slice(0, 20);

  let healthy = 0, degraded = 0;
  const healthResults: { id: number; name: string; alive: boolean }[] = [];

  for (const agent of sampleAgents) {
    const alive = await pingA2A(agent.a2aEndpoint);
    healthResults.push({ id: agent.id, name: agent.name, alive });
    if (alive) { healthy++; brain.rememberA2ASuccess(agent.id); }
    else { degraded++; brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, "Pulse check failed"); }
    log(`  ${alive ? "✅" : "❌"} #${agent.id} "${agent.name.slice(0, 30)}"`);
  }

  const healthRate = sampleAgents.length > 0 ? Math.round(healthy / sampleAgents.length * 100) : 100;
  log(`\nHealth: ${healthy}/${sampleAgents.length} (${healthRate}%) responding`);

  // FastNet: predict health and detect anomalies
  const prevSnapshot = pulseHistory.length > 0 ? pulseHistory[pulseHistory.length - 1] : null;
  const prevHealth = prevSnapshot?.networkHealth ?? healthRate;
  const timeSinceCheck = prevSnapshot ? (Date.now() - prevSnapshot.ts) / 3600000 : 24;
  const respondingCount = allAgents.filter(a => a.a2aResponds).length;
  const respondingRatio = allAgents.length > 0 ? respondingCount / allAgents.length : 0;

  const pulseInput = [
    normalize(prevHealth, 0, 100),
    normalize(timeSinceCheck, 0, 48),
    respondingRatio,
    normalize(healthRate, 0, 100),
  ];
  const pulsePrediction = pulseNet.predict(pulseInput);
  const predictedHealth = pulsePrediction.output[0] * 100;
  const anomalyScore = pulsePrediction.output[1];

  log(`🧠 FastNet: predicted health=${predictedHealth.toFixed(0)}% anomaly=${(anomalyScore*100).toFixed(0)}%`);

  // Train with actual health rate
  pulseNet.train(pulseInput, [
    normalize(healthRate, 0, 100),
    Math.abs(healthRate - prevHealth) > 20 ? 1.0 : 0.0, // anomaly if big change
  ]);

  if (anomalyScore > 0.7 && pulseNet.trainCount > 20) {
    log(`⚠️  FastNet ANOMALY DETECTED: score ${(anomalyScore*100).toFixed(0)}% — investigating...`);
  }

  // ── Market Data ───────────────────────────────────────────────────────────
  log("\nFetching market data...");
  const { bnbPrice, bscTvl } = await getMarketData();
  if (bnbPrice) log(`BNB: $${bnbPrice}`);
  if (bscTvl) log(`BSC TVL: ${bscTvl}`);

  // ── Metrics ───────────────────────────────────────────────────────────────
  const knowledgeEntries = (kb.entries ?? []).length;
  const agentsCovered = kb.agentsCovered ?? 0;
  const connections = (connLog.connections ?? []).length;
  const respondingTotal = allAgents.filter(a => a.a2aResponds).length;

  const snapshot: PulseSnapshot = {
    ts: Date.now(),
    date: new Date().toISOString().split("T")[0],
    totalAgents: allAgents.length,
    respondingAgents: respondingTotal,
    knowledgeEntries,
    agentsCovered,
    connections,
    bnbPrice,
    bscTvl,
    networkHealth: healthRate,
  };

  // ── Trends ────────────────────────────────────────────────────────────────
  const prev = pulseHistory.length > 0 ? pulseHistory[pulseHistory.length - 1] : null;
  if (prev) {
    const newAgents = snapshot.totalAgents - prev.totalAgents;
    const newKnowledge = snapshot.knowledgeEntries - prev.knowledgeEntries;
    const newConnections = snapshot.connections - prev.connections;

    log(`\nGrowth since last pulse:`);
    log(`  Agents: ${newAgents >= 0 ? "+" : ""}${newAgents}`);
    log(`  Knowledge entries: ${newKnowledge >= 0 ? "+" : ""}${newKnowledge}`);
    log(`  Connections: ${newConnections >= 0 ? "+" : ""}${newConnections}`);

    // Log meaningful growth to Plaza
    if (newAgents > 0 || newKnowledge > 5 || newConnections > 0) {
      const parts: string[] = [];
      if (newAgents > 0) parts.push(`+${newAgents} new agents`);
      if (newKnowledge > 0) parts.push(`+${newKnowledge} knowledge entries`);
      if (newConnections > 0) parts.push(`+${newConnections} new connections`);
      await logToPlaza(
        `[PULSE] Network growing: ${parts.join(", ")}. ` +
        `${snapshot.respondingAgents} agents active, ${snapshot.knowledgeEntries} things learned. ` +
        `${bnbPrice ? `BNB: $${bnbPrice}. ` : ""}Health: ${healthRate}% ❤️`
      );
    }
  }

  // Keep history (90 days max)
  const todayDate = snapshot.date;
  const lastEntry = pulseHistory.length > 0 ? pulseHistory[pulseHistory.length - 1] : null;
  if (lastEntry?.date === todayDate) {
    pulseHistory[pulseHistory.length - 1] = snapshot;
  } else {
    pulseHistory.push(snapshot);
  }
  if (pulseHistory.length > 90) pulseHistory.splice(0, pulseHistory.length - 90);

  writeFileSync(PULSE_FILE, JSON.stringify(pulseHistory, null, 2));

  // Save FastNet
  pulseNet.save("data/fastnet-pulse.json");
  const netStats = pulseNet.getStats();
  log(`🧠 FastNet: ${netStats.trainCount} samples, avg loss: ${netStats.avgLoss.toFixed(4)}`);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  PULSE REPORT                                            ║");
  console.log(`║  Total agents:     ${String(snapshot.totalAgents).padEnd(37)}║`);
  console.log(`║  A2A responding:   ${String(snapshot.respondingAgents).padEnd(37)}║`);
  console.log(`║  Knowledge items:  ${String(snapshot.knowledgeEntries).padEnd(37)}║`);
  console.log(`║  Connections made: ${String(snapshot.connections).padEnd(37)}║`);
  console.log(`║  Health rate:      ${`${healthRate}%`.padEnd(37)}║`);
  if (bnbPrice) console.log(`║  BNB Price:        ${`$${bnbPrice}`.padEnd(37)}║`);
  if (bscTvl) console.log(`║  BSC TVL:          ${bscTvl.padEnd(37)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  brain.save();
  process.exit(0);
}

main().catch(e => { console.error("❌ PULSE Error:", e); process.exit(1); });
