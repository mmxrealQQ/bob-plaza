/**
 * BOB SCOUT FAST — Two-pass registry scanner
 *
 * Pass 1: Quick scan all IDs — parse base64 metadata inline, find agents with services
 * Pass 2: Full test only agents with A2A/MCP/API endpoints
 *
 * Much faster than scanning everything with endpoint tests.
 *
 * Usage: ./bob scout
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const BSC_RPC = "https://bsc-dataseed.binance.org";
const REGISTRY_ADDR = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];
const OUTPUT_FILE = "data/agent-registry.json";
const BATCH_SIZE = 10;
const FETCH_TIMEOUT = 8000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentRecord {
  id: number;
  owner: string;
  tokenURI: string;
  name: string;
  description: string;
  active: boolean;
  version: string;
  a2aEndpoint: string;
  hasAgentCard: boolean;
  a2aReachable: boolean;
  a2aResponds: boolean;
  category: string;
  score: number;
  services: string[];
  scannedAt: number;
  status: "active" | "inactive" | "spam" | "legit" | "dead" | "unknown";
}

interface RegistryData {
  lastScan: number;
  totalScanned: number;
  maxAgentId: number;
  agents: Record<string, AgentRecord>;
  stats: Record<string, number>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[SCOUT ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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

async function fetchIPFS(uri: string): Promise<any | null> {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const cid = uri.replace("ipfs://", "");
    for (const gw of IPFS_GATEWAYS) {
      try {
        const resp = await fetchWithTimeout(gw + cid);
        if (resp.ok) return await resp.json();
      } catch { continue; }
    }
    return null;
  }
  if (uri.startsWith("http")) {
    try {
      const resp = await fetchWithTimeout(uri);
      if (resp.ok) return await resp.json();
    } catch { return null; }
  }
  if (uri.startsWith("data:")) {
    try {
      const base64 = uri.split(",")[1];
      if (!base64) return null;
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      if (!decoded || decoded.length === 0) return null;
      const trimmed = decoded.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
      try {
        return JSON.parse(trimmed);
      } catch (e: any) {
        // Malformed JSON in base64 — log and skip
        if (e.message?.includes("Unexpected") || e.message?.includes("JSON")) return null;
        throw e;
      }
    } catch { return null; }
  }
  return null;
}

/** RPC call with retry */
async function rpcRetry<T>(fn: () => Promise<T>, fallback: T, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch { if (i < retries - 1) await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
  return fallback;
}

/** Test if an A2A endpoint works */
async function testA2AEndpoint(endpoint: string): Promise<{ reachable: boolean; responds: boolean; hasCard: boolean }> {
  if (!endpoint?.startsWith("http")) return { reachable: false, responds: false, hasCard: false };

  let reachable = false, responds = false, hasCard = false;

  // Check agent card
  try {
    const cardUrl = endpoint.replace(/\/$/, "") + "/.well-known/agent.json";
    const resp = await fetchWithTimeout(cardUrl);
    if (resp.ok) {
      const card = await resp.json();
      hasCard = !!(card.name && (card.skills || card.supported_interfaces));
      reachable = true;
    }
  } catch {
    try {
      const resp = await fetchWithTimeout(endpoint);
      reachable = resp.ok || resp.status === 405;
    } catch { reachable = false; }
  }

  // Test JSON-RPC
  if (reachable) {
    try {
      const resp = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "message/send", id: "scout-test",
          params: { message: { role: "user", parts: [{ text: "gm" }] } },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        responds = !!(data.jsonrpc === "2.0" || data.result || data.artifacts || data.message);
      }
    } catch { responds = false; }
  }

  return { reachable, responds, hasCard };
}

/** Classify agent — comprehensive scoring, spam detection, and categorization */
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

  // ── Spam Detection ──────────────────────────────────────────────────
  // Known mass-registered spam patterns (name alone is enough)
  const spamPatterns = [
    /^ave\.?ai trading agent$/i,
    /^debot trading agent$/i,
    /^mevx trading agent$/i,
    /^meme bot$/i,
    /^myaiagent$/i,
  ];
  const isSpamName = spamPatterns.some(p => p.test(r.name ?? ""));
  // tokenURI but completely empty metadata
  const isEmptySpam = r.tokenURI && !r.name;

  // ── Status Classification ───────────────────────────────────────────
  // IMPORTANT: Check spam FIRST before score-based classification
  let status: AgentRecord["status"] = "unknown";
  if (isSpamName || isEmptySpam) status = "spam";
  else if (score >= 70 && r.a2aResponds) status = "legit";
  else if (score >= 40 && r.a2aReachable) status = "active";
  else if (score >= 20) status = "inactive";
  else if (r.name && r.name !== "unknown") status = "dead";
  else status = "dead";

  // Spam gets score 0
  if (status === "spam") score = 0;

  // ── Category Classification (expanded keywords) ─────────────────────
  let category = "unknown";
  const rawName = r.name ?? "";

  // Pattern-based classification FIRST (catches bulk-registered agents)
  const isEnsoul = /· ensoul/i.test(rawName) || /ensoul\.app/i.test(rawName) || /^@\w+\s+(·\s+)?ensoul/i.test(rawName) || /soul$/i.test(rawName) && rawName.startsWith("@");
  const isUnibase = /by unibase$/i.test(rawName) || /unibase$/i.test(rawName);

  if (status === "spam") {
    category = "spam";
  }
  // Ensoul = social profile bots (mass-registered twitter handle agents)
  else if (isEnsoul) {
    category = "social";
  }
  // Unibase = mass-registered meme coin agents
  else if (isUnibase) {
    category = "memetoken";
  }
  // DeFi
  else if (text.includes("defi") || text.includes("swap") || text.includes("lend") ||
      text.includes("yield") || text.includes("liquidity") || text.includes("staking") ||
      text.includes("farming") || text.includes("vault") || text.includes("amm") ||
      text.includes("borrow") || text.includes("protocol")) {
    category = "defi";
  }
  // Trading
  else if (text.includes("trade") || text.includes("trading") || text.includes("meme") ||
           text.includes("sniper") || text.includes("arbitrage") || text.includes("signal") ||
           text.includes("price") || text.includes("market maker") || text.includes("dex") ||
           text.includes("mev") || text.includes("copy trad") || text.includes("perp")) {
    category = "trading";
  }
  // Analytics / Data
  else if (text.includes("analyt") || text.includes("data") || text.includes("intel") ||
           text.includes("monitor") || text.includes("track") || text.includes("dashboard") ||
           text.includes("report") || text.includes("insight") || text.includes("scan") ||
           text.includes("index") || text.includes("aggregat")) {
    category = "analytics";
  }
  // Gaming / NFT
  else if (text.includes("game") || text.includes("nft") || text.includes("play") ||
           text.includes("metaverse") || text.includes("collectible") || text.includes("mint") ||
           text.includes("arena") || text.includes("battle")) {
    category = "gaming";
  }
  // Social / Community
  else if (text.includes("social") || text.includes("chat") || text.includes("community") ||
           text.includes("twitter") || text.includes("telegram") || text.includes("discord") ||
           text.includes("content") || text.includes("post") || text.includes("message")) {
    category = "social";
  }
  // Infrastructure
  else if (text.includes("bridge") || text.includes("cross") || text.includes("oracle") ||
           text.includes("rpc") || text.includes("node") || text.includes("relay") ||
           text.includes("infrastructure") || text.includes("middleware") || text.includes("sdk")) {
    category = "infrastructure";
  }
  // Security
  else if (text.includes("security") || text.includes("audit") || text.includes("safe") ||
           text.includes("protect") || text.includes("threat") || text.includes("vulnerab") ||
           text.includes("firewall") || text.includes("guard")) {
    category = "security";
  }
  // Automation
  else if (text.includes("deploy") || text.includes("automat") || text.includes("bot") ||
           text.includes("schedule") || text.includes("workflow") || text.includes("task") ||
           text.includes("cron") || text.includes("trigger")) {
    category = "automation";
  }
  // AI / LLM
  else if (text.includes("ai ") || text.includes("llm") || text.includes("gpt") ||
           text.includes("model") || text.includes("inference") || text.includes("neural") ||
           text.includes("machine learn") || text.includes("copilot") || text.includes("assistant")) {
    category = "ai";
  }
  // Wallet / Payments
  else if (text.includes("wallet") || text.includes("payment") || text.includes("transfer") ||
           text.includes("send") || text.includes("receive") || text.includes("pay")) {
    category = "wallet";
  }
  // General: has real metadata but doesn't match specific categories
  else if (r.name && r.name !== "unknown" && (r.a2aEndpoint || (r.description && r.description.length > 10))) {
    category = "general";
  }

  return { status, score: Math.min(score, 100), category };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");

  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   BOB SCOUT — Fast Two-Pass Scanner                   ║");
  console.log("║   Finding REAL agents on BNB Smart Chain...            ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const contract = new ethers.Contract(REGISTRY_ADDR, [
    "function tokenURI(uint256) view returns (string)",
    "function ownerOf(uint256) view returns (address)",
  ], provider);

  // Find max ID
  log("Finding max agent ID...");
  let lo = 38000, hi = 50000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { await contract.ownerOf(mid); lo = mid + 1; } catch { hi = mid; }
  }
  const maxId = lo - 1;
  log(`Max agent ID: ${maxId}`);

  let from = fromIdx >= 0 ? parseInt(args[fromIdx + 1]) : 1;
  let to = toIdx >= 0 ? parseInt(args[toIdx + 1]) : maxId;
  from = Math.max(1, from);
  to = Math.min(maxId, to);

  // ═══════════════════════════════════════════════════════════════════
  // PASS 1: Quick scan — get metadata, find agents with services
  // ═══════════════════════════════════════════════════════════════════
  log(`\n── PASS 1: Quick metadata scan #${from} to #${to} (${to - from + 1} IDs) ──\n`);

  const withServices: Map<number, any> = new Map();
  let scanned = 0;
  let totalFound = 0;

  for (let batchStart = from; batchStart <= to; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, to);
    const ids = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

    const results = await Promise.all(ids.map(async (id) => {
      const owner = await rpcRetry(() => contract.ownerOf(id), null);
      if (!owner) return null;

      const tokenURI = await rpcRetry(() => contract.tokenURI(id), "");
      let meta: any = null;

      // Parse base64 data URIs instantly (no network needed)
      if (tokenURI?.startsWith("data:")) {
        try {
          const b64 = tokenURI.split(",")[1];
          meta = JSON.parse(Buffer.from(b64, "base64").toString());
        } catch { }
      } else if (tokenURI?.startsWith("ipfs://") || tokenURI?.startsWith("http")) {
        meta = await fetchIPFS(tokenURI);
      }

      const name = meta?.name ?? "unknown";
      const services = meta?.services ?? [];
      const hasServices = Array.isArray(services) && services.length > 0;
      const serviceNames = hasServices ? services.map((s: any) => s.name).filter(Boolean) : [];
      const hasA2AorMCP = serviceNames.some((n: string) =>
        ["a2a", "mcp", "api", "web"].includes(n.toLowerCase())
      );

      return { id, owner, tokenURI, meta, name, serviceNames, hasServices, hasA2AorMCP };
    }));

    for (const r of results) {
      scanned++;
      if (!r) continue;
      totalFound++;
      if (r.hasA2AorMCP) {
        withServices.set(r.id, r);
      }
    }

    // Progress every 500
    if (scanned % 500 === 0 || batchEnd === to) {
      const pct = Math.round(((scanned) / (to - from + 1)) * 100);
      log(`${pct}% | Scanned: ${scanned} | Exists: ${totalFound} | With Services: ${withServices.size}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  log(`\nPass 1 done: ${totalFound} registered, ${withServices.size} have services (A2A/MCP/Web/API)`);

  // ═══════════════════════════════════════════════════════════════════
  // PASS 2: Full test — only agents with services
  // ═══════════════════════════════════════════════════════════════════
  log(`\n── PASS 2: Testing ${withServices.size} agents with endpoints ──\n`);

  if (!existsSync("data")) mkdirSync("data");

  // Load existing data and MERGE (don't overwrite!)
  let registry: RegistryData = {
    lastScan: 0, totalScanned: 0, maxAgentId: maxId,
    agents: {}, stats: {},
  };
  if (existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
      registry.agents = existing.agents ?? {};
      log(`Loaded ${Object.keys(registry.agents).length} existing agents — will merge new results`);
    } catch { log("Could not load existing data, starting fresh"); }
  }

  for (const [id, r] of withServices) {
    const meta = r.meta;
    const name = meta?.name ?? "unknown";
    const description = (meta?.description ?? "").slice(0, 300);
    const active = meta?.active ?? false;
    const version = meta?.version ?? "";

    let a2aEndpoint = "";
    const services: string[] = r.serviceNames;

    if (meta?.services && Array.isArray(meta.services)) {
      const a2a = meta.services.find((s: any) => s.name?.toLowerCase() === "a2a");
      if (a2a) {
        let ep = a2a.endpoint ?? "";
        ep = ep.replace(/\/.well-known\/agent[_-]?card\.json$/i, "");
        a2aEndpoint = ep;
      }
    }

    // Test endpoint
    let a2aReachable = false, a2aResponds = false, hasAgentCard = false;
    if (a2aEndpoint?.startsWith("http")) {
      const test = await testA2AEndpoint(a2aEndpoint);
      a2aReachable = test.reachable;
      a2aResponds = test.responds;
      hasAgentCard = test.hasCard;
    }

    const record: Partial<AgentRecord> = {
      id, owner: r.owner, tokenURI: r.tokenURI, name, description, active, version,
      a2aEndpoint, a2aReachable, a2aResponds, hasAgentCard, services,
      scannedAt: Date.now(),
    };
    const { status, score, category } = classifyAgent(record);
    const agent = { ...record, status, score, category } as AgentRecord;
    registry.agents[id.toString()] = agent;

    const a2aIcon = a2aResponds ? "✅" : a2aReachable ? "🟡" : "❌";
    const cardIcon = hasAgentCard ? "📋" : "  ";
    log(`  ${a2aIcon} ${cardIcon} #${id} "${name.slice(0, 35)}" Score:${score} [${status}] ${category} ${services.join(",")}`);
  }

  // Stats
  const agents = Object.values(registry.agents);
  registry.stats = {
    total: agents.length,
    active: agents.filter(a => a.status === "active").length,
    legit: agents.filter(a => a.status === "legit").length,
    inactive: agents.filter(a => a.status === "inactive").length,
    spam: agents.filter(a => a.status === "spam").length,
    dead: agents.filter(a => a.status === "dead").length,
    withA2A: agents.filter(a => a.a2aEndpoint).length,
    withAgentCard: agents.filter(a => a.hasAgentCard).length,
    a2aReachable: agents.filter(a => a.a2aReachable).length,
    a2aResponds: agents.filter(a => a.a2aResponds).length,
  };
  registry.totalScanned = scanned;
  registry.lastScan = Date.now();
  registry.maxAgentId = maxId;

  writeFileSync(OUTPUT_FILE, JSON.stringify(registry, null, 2));
  log(`\nSaved to ${OUTPUT_FILE}`);

  // Summary
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   SCOUT SCAN COMPLETE                                  ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║   Registry IDs:     ${String(maxId).padEnd(34)}║`);
  console.log(`║   Total scanned:    ${String(scanned).padEnd(34)}║`);
  console.log(`║   With services:    ${String(withServices.size).padEnd(34)}║`);
  console.log(`║   ────────────────────────────────────────────────── ║`);
  console.log(`║   Legit (A2A works):  ${String(registry.stats.legit).padEnd(33)}║`);
  console.log(`║   Active (reachable): ${String(registry.stats.active).padEnd(33)}║`);
  console.log(`║   Inactive:           ${String(registry.stats.inactive).padEnd(33)}║`);
  console.log(`║   A2A responds:       ${String(registry.stats.a2aResponds).padEnd(33)}║`);
  console.log(`║   Valid Agent Card:   ${String(registry.stats.withAgentCard).padEnd(33)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝");

  const topAgents = agents
    .filter(a => a.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  if (topAgents.length > 0) {
    console.log("\nTOP AGENTS:");
    for (const a of topAgents) {
      const card = a.hasAgentCard ? "📋" : "  ";
      const a2a = a.a2aResponds ? "✅" : a.a2aReachable ? "🟡" : "❌";
      console.log(`   ${a2a} ${card} #${a.id} ${a.name.slice(0, 30).padEnd(32)} Score:${a.score} [${a.status}] ${a.category}`);
    }
  }

  // ── Alpha Alerts: Notify owner about high-value new agents ──
  const alphaAgents = agents.filter(a => a.score >= 70 && a.a2aResponds);
  if (alphaAgents.length > 0) {
    log(`\n🚨 ALPHA ALERT: ${alphaAgents.length} high-value agents found!`);
    for (const a of alphaAgents) {
      log(`  ⭐ #${a.id} "${a.name}" Score:${a.score} [${a.category}] — A2A works!`);
    }
    // Send alert via BOB's own A2A endpoint so it shows in chat
    try {
      const alertText = `🚨 ALPHA ALERT: Found ${alphaAgents.length} high-value agent${alphaAgents.length > 1 ? "s" : ""}!\n${alphaAgents.map(a => `⭐ #${a.id} "${a.name}" Score:${a.score} [${a.category}]`).join("\n")}\nThese agents have working A2A endpoints and score 70+. PUSHER should engage.`;
      await fetch("https://project-gkws4.vercel.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/send",
          id: `scout-alpha-${Date.now()}`,
          params: {
            message: { role: "user", parts: [{ text: alertText }] },
            senderName: "SCOUT Alpha",
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {}
  }

  process.exit(0);
}

main().catch(e => {
  console.error("❌ Error:", e);
  process.exit(1);
});
