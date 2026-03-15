/**
 * BOB Reclassify — Re-run classification on existing scan data
 * No network calls needed, just re-applies updated classifyAgent() logic
 *
 * Usage: npx tsx src/reclassify.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const DATA_FILE = "data/agent-registry.json";

if (!existsSync(DATA_FILE)) {
  console.error("❌ No registry data. Run 'bob scout' first.");
  process.exit(1);
}

interface AgentRecord {
  id: number; owner: string; tokenURI: string; name: string; description: string;
  active: boolean; version: string; a2aEndpoint: string; hasAgentCard: boolean;
  a2aReachable: boolean; a2aResponds: boolean; category: string; score: number;
  services: string[]; scannedAt: number;
  status: "active" | "inactive" | "spam" | "legit" | "dead" | "unknown";
}

function classifyAgent(r: Partial<AgentRecord>): { status: AgentRecord["status"]; score: number; category: string } {
  let score = 0;
  if (r.name && r.name !== "unknown") score += 10;
  if (r.description && r.description.length > 20) score += 10;
  if (r.version) score += 5;
  if (r.a2aEndpoint) score += 10;
  if (r.a2aReachable) score += 20;
  if (r.a2aResponds) score += 25;
  if (r.hasAgentCard) score += 20;
  if (r.active) score += 5;
  if (r.services && r.services.length > 1) score += 5;
  const svcLower = (r.services ?? []).map(s => s.toLowerCase());
  if (svcLower.includes("mcp")) score += 5;
  if (svcLower.includes("web")) score += 5;
  if (svcLower.includes("api")) score += 5;

  const name = (r.name ?? "").toLowerCase();
  const desc = (r.description ?? "").toLowerCase();
  const text = `${name} ${desc}`;
  const rawName = r.name ?? "";

  // Spam detection
  const spamPatterns = [/^ave\.?ai trading agent$/i, /^debot trading agent$/i, /^mevx trading agent$/i, /^meme bot$/i, /^myaiagent$/i];
  const isSpamName = spamPatterns.some(p => p.test(rawName));
  const isEmptySpam = r.tokenURI && !r.name;

  // Status: spam FIRST
  let status: AgentRecord["status"] = "unknown";
  if (isSpamName || isEmptySpam) status = "spam";
  else if (score >= 70 && r.a2aResponds) status = "legit";
  else if (score >= 40 && r.a2aReachable) status = "active";
  else if (score >= 20) status = "inactive";
  else if (r.name && r.name !== "unknown") status = "dead";
  else status = "dead";

  if (status === "spam") score = 0;

  // Category
  let category = "unknown";
  const isEnsoul = /· ensoul/i.test(rawName) || /ensoul\.app/i.test(rawName) || /^@\w+\s+(·\s+)?ensoul/i.test(rawName) || (/soul$/i.test(rawName) && rawName.startsWith("@"));
  const isUnibase = /by unibase$/i.test(rawName) || /unibase$/i.test(rawName);

  if (status === "spam") category = "spam";
  else if (isEnsoul) category = "social";
  else if (isUnibase) category = "memetoken";
  else if (text.includes("defi") || text.includes("swap") || text.includes("lend") || text.includes("yield") || text.includes("liquidity") || text.includes("staking") || text.includes("farming") || text.includes("vault") || text.includes("amm") || text.includes("borrow") || text.includes("protocol")) category = "defi";
  else if (text.includes("trade") || text.includes("trading") || text.includes("meme") || text.includes("sniper") || text.includes("arbitrage") || text.includes("signal") || text.includes("price") || text.includes("market maker") || text.includes("dex") || text.includes("mev") || text.includes("copy trad") || text.includes("perp")) category = "trading";
  else if (text.includes("analyt") || text.includes("data") || text.includes("intel") || text.includes("monitor") || text.includes("track") || text.includes("dashboard") || text.includes("report") || text.includes("insight") || text.includes("scan") || text.includes("index") || text.includes("aggregat")) category = "analytics";
  else if (text.includes("game") || text.includes("nft") || text.includes("play") || text.includes("metaverse") || text.includes("collectible") || text.includes("mint") || text.includes("arena") || text.includes("battle")) category = "gaming";
  else if (text.includes("social") || text.includes("chat") || text.includes("community") || text.includes("twitter") || text.includes("telegram") || text.includes("discord") || text.includes("content") || text.includes("post") || text.includes("message")) category = "social";
  else if (text.includes("bridge") || text.includes("cross") || text.includes("oracle") || text.includes("rpc") || text.includes("node") || text.includes("relay") || text.includes("infrastructure") || text.includes("middleware") || text.includes("sdk")) category = "infrastructure";
  else if (text.includes("security") || text.includes("audit") || text.includes("safe") || text.includes("protect") || text.includes("threat") || text.includes("vulnerab") || text.includes("firewall") || text.includes("guard")) category = "security";
  else if (text.includes("deploy") || text.includes("automat") || text.includes("bot") || text.includes("schedule") || text.includes("workflow") || text.includes("task") || text.includes("cron") || text.includes("trigger")) category = "automation";
  else if (text.includes("ai ") || text.includes("llm") || text.includes("gpt") || text.includes("model") || text.includes("inference") || text.includes("neural") || text.includes("machine learn") || text.includes("copilot") || text.includes("assistant")) category = "ai";
  else if (text.includes("wallet") || text.includes("payment") || text.includes("transfer") || text.includes("send") || text.includes("receive") || text.includes("pay")) category = "wallet";
  else if (r.name && r.name !== "unknown" && (r.a2aEndpoint || (r.description && r.description.length > 10))) category = "general";

  return { status, score: Math.min(score, 100), category };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const registry = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
const agents = registry.agents as Record<string, AgentRecord>;

let changes = { statusChanged: 0, categoryChanged: 0, spamDetected: 0 };
const newStats = { total: 0, active: 0, legit: 0, inactive: 0, spam: 0, dead: 0, withA2A: 0, withAgentCard: 0, a2aReachable: 0, a2aResponds: 0 };
const catCounts: Record<string, number> = {};

for (const [id, agent] of Object.entries(agents)) {
  const { status, score, category } = classifyAgent(agent);

  if (agent.status !== status) changes.statusChanged++;
  if (agent.category !== category) changes.categoryChanged++;
  if (status === "spam" && agent.status !== "spam") changes.spamDetected++;

  agent.status = status;
  agent.score = score;
  agent.category = category;

  newStats.total++;
  if (status === "legit") newStats.legit++;
  else if (status === "active") newStats.active++;
  else if (status === "inactive") newStats.inactive++;
  else if (status === "dead") newStats.dead++;
  else if (status === "spam") newStats.spam++;

  if (agent.a2aEndpoint) newStats.withA2A++;
  if (agent.hasAgentCard) newStats.withAgentCard++;
  if (agent.a2aReachable) newStats.a2aReachable++;
  if (agent.a2aResponds) newStats.a2aResponds++;

  if (status !== "dead") {
    catCounts[category] = (catCounts[category] || 0) + 1;
  }
}

registry.stats = newStats;
writeFileSync(DATA_FILE, JSON.stringify(registry, null, 2));

console.log("\n╔═══════════════════════════════════════════════════════╗");
console.log("║   BOB RECLASSIFY — Updated Classification             ║");
console.log("╠═══════════════════════════════════════════════════════╣");
console.log(`║   Agents processed: ${newStats.total.toLocaleString().padEnd(33)}║`);
console.log(`║   Status changed:   ${changes.statusChanged.toLocaleString().padEnd(33)}║`);
console.log(`║   Category changed: ${changes.categoryChanged.toLocaleString().padEnd(33)}║`);
console.log(`║   New spam detected: ${changes.spamDetected.toLocaleString().padEnd(32)}║`);
console.log("╠═══════════════════════════════════════════════════════╣");
console.log(`║   Legit:    ${newStats.legit.toLocaleString().padEnd(41)}║`);
console.log(`║   Active:   ${newStats.active.toLocaleString().padEnd(41)}║`);
console.log(`║   Inactive: ${newStats.inactive.toLocaleString().padEnd(41)}║`);
console.log(`║   Spam:     ${newStats.spam.toLocaleString().padEnd(41)}║`);
console.log(`║   Dead:     ${newStats.dead.toLocaleString().padEnd(41)}║`);
console.log("╠═══════════════════════════════════════════════════════╣");

const sortedCats = Object.entries(catCounts).sort(([, a], [, b]) => b - a);
const aliveTotal = newStats.total - newStats.dead;
console.log("║   CATEGORIES (non-dead)                               ║");
for (const [cat, count] of sortedCats) {
  const pct = ((count / aliveTotal) * 100).toFixed(1);
  console.log(`║   ${cat.padEnd(16)} ${count.toLocaleString().padStart(6)}  ${pct.padStart(5)}%${"".padEnd(24 - cat.length)}║`);
}
console.log("╚═══════════════════════════════════════════════════════╝\n");
