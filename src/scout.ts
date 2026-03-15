/**
 * BOB SCOUT — ERC-8004 Registry Scanner
 *
 * Scans the BNB Smart Chain ERC-8004 registry, checks each agent:
 * - Has tokenURI? → fetch metadata from IPFS/HTTP
 * - Has a2a endpoint? → test if reachable
 * - Has valid Agent Card? → check /.well-known/agent.json
 * - Classify: active / inactive / spam / legit / dead
 *
 * Output: data/agent-registry.json
 *
 * Usage: npm run scout
 *        npm run scout -- --from 36000 --to 37000   (scan range)
 *        npm run scout -- --quick                    (only check endpoints, skip metadata)
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const BSC_RPC = "https://bsc-dataseed.binance.org";
const REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];
const OUTPUT_FILE = "data/agent-registry.json";
const BATCH_SIZE = 5; // concurrent RPC calls (low to avoid throttling)
const FETCH_TIMEOUT = 8000; // 8s timeout for HTTP fetches
const MAX_RETRIES = 3; // retry failed RPC calls

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
  stats: {
    total: number;
    active: number;
    legit: number;
    inactive: number;
    spam: number;
    dead: number;
    withA2A: number;
    withAgentCard: number;
    a2aReachable: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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

  let url = uri;
  if (uri.startsWith("ipfs://")) {
    const cid = uri.replace("ipfs://", "");
    // Try multiple gateways
    for (const gw of IPFS_GATEWAYS) {
      try {
        const resp = await fetchWithTimeout(gw + cid);
        if (resp.ok) return await resp.json();
      } catch {
        continue;
      }
    }
    return null;
  }

  if (uri.startsWith("http")) {
    try {
      const resp = await fetchWithTimeout(url);
      if (resp.ok) return await resp.json();
    } catch {
      return null;
    }
  }

  // base64 data URI
  if (uri.startsWith("data:")) {
    try {
      const base64 = uri.split(",")[1];
      return JSON.parse(Buffer.from(base64, "base64").toString());
    } catch {
      return null;
    }
  }

  return null;
}

/** Test if an A2A endpoint is reachable and responds to JSON-RPC */
async function testA2AEndpoint(endpoint: string): Promise<{ reachable: boolean; responds: boolean; hasCard: boolean }> {
  if (!endpoint || !endpoint.startsWith("http")) {
    return { reachable: false, responds: false, hasCard: false };
  }

  let reachable = false;
  let responds = false;
  let hasCard = false;

  // 1. Check /.well-known/agent.json
  try {
    const cardUrl = endpoint.replace(/\/$/, "") + "/.well-known/agent.json";
    const resp = await fetchWithTimeout(cardUrl);
    if (resp.ok) {
      const card = await resp.json();
      hasCard = !!(card.name && card.skills && card.supported_interfaces);
      reachable = true;
    }
  } catch {
    // try base URL
    try {
      const resp = await fetchWithTimeout(endpoint);
      reachable = resp.ok || resp.status === 405; // 405 = POST only, still alive
    } catch {
      reachable = false;
    }
  }

  // 2. Test JSON-RPC message/send
  if (reachable) {
    try {
      const resp = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/send",
          id: "scout-test",
          params: {
            message: {
              role: "user",
              parts: [{ text: "gm" }],
            },
          },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        // Check if it's a valid JSON-RPC response
        responds = !!(data.jsonrpc === "2.0" || data.result || data.artifacts || data.message);
      }
    } catch {
      responds = false;
    }
  }

  return { reachable, responds, hasCard };
}

/** Classify an agent based on its metadata and endpoint status */
function classifyAgent(record: Partial<AgentRecord>): { status: AgentRecord["status"]; score: number; category: string } {
  let score = 0;
  let status: AgentRecord["status"] = "unknown";

  // Has metadata
  if (record.name && record.name !== "unknown") score += 10;
  if (record.description && record.description.length > 20) score += 10;
  if (record.version) score += 5;

  // Has A2A
  if (record.a2aEndpoint) score += 10;
  if (record.a2aReachable) score += 20;
  if (record.a2aResponds) score += 25;
  if (record.hasAgentCard) score += 20;

  // Active flag
  if (record.active) score += 5;

  // Services
  if (record.services && record.services.length > 1) score += 5;
  const svcLower = (record.services ?? []).map(s => s.toLowerCase());
  if (svcLower.includes("mcp")) score += 5;
  if (svcLower.includes("web")) score += 5;
  if (svcLower.includes("api")) score += 5;

  // Classify
  if (score >= 70 && record.a2aResponds) {
    status = "legit";
  } else if (score >= 40 && record.a2aReachable) {
    status = "active";
  } else if (score >= 20) {
    status = "inactive";
  } else if (record.tokenURI && !record.name) {
    status = "spam";
  } else {
    status = "dead";
  }

  // Category detection from description/name
  let category = "unknown";
  const text = `${record.name} ${record.description}`.toLowerCase();
  if (text.includes("defi") || text.includes("swap") || text.includes("lend")) category = "defi";
  else if (text.includes("game") || text.includes("nft")) category = "gaming";
  else if (text.includes("social") || text.includes("chat")) category = "social";
  else if (text.includes("analyt") || text.includes("data") || text.includes("intel")) category = "analytics";
  else if (text.includes("trade") || text.includes("meme")) category = "trading";
  else if (text.includes("bridge") || text.includes("cross")) category = "infrastructure";
  else if (text.includes("security") || text.includes("audit")) category = "security";
  else if (record.name && record.a2aEndpoint) category = "general";

  return { status, score: Math.min(score, 100), category };
}

// ─── Main Scanner ────────────────────────────────────────────────────────────

async function findMaxAgentId(contract: ethers.Contract): Promise<number> {
  let lo = 38000, hi = 50000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await contract.ownerOf(mid);
      lo = mid + 1;
    } catch {
      hi = mid;
    }
  }
  return lo - 1;
}

async function rpcRetry<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch {
      if (i < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  return fallback;
}

async function scanAgent(
  contract: ethers.Contract,
  id: number,
  quick: boolean,
): Promise<AgentRecord | null> {
  try {
    const owner = await rpcRetry(() => contract.ownerOf(id), null);
    const tokenURI = await rpcRetry(() => contract.tokenURI(id), "");

    if (!owner) return null;

    let name = "unknown";
    let description = "";
    let active = false;
    let version = "";
    let a2aEndpoint = "";
    let services: string[] = [];

    // Fetch metadata (skip in quick mode)
    if (!quick && tokenURI) {
      const meta = await fetchIPFS(tokenURI);
      if (meta) {
        name = meta.name ?? "unknown";
        description = (meta.description ?? "").slice(0, 300);
        active = meta.active ?? false;
        version = meta.version ?? "";

        if (meta.services && Array.isArray(meta.services)) {
          services = meta.services.map((s: any) => s.name).filter(Boolean);
          // Match a2a/A2A case-insensitive
          const a2a = meta.services.find((s: any) => s.name?.toLowerCase() === "a2a");
          if (a2a) {
            let ep = a2a.endpoint ?? "";
            // Clean up: if endpoint points to agent-card.json, extract base URL
            ep = ep.replace(/\/.well-known\/agent[_-]?card\.json$/i, "");
            a2aEndpoint = ep;
          }
          // Also check for MCP, web, API endpoints
          const mcp = meta.services.find((s: any) => s.name?.toLowerCase() === "mcp");
          const web = meta.services.find((s: any) => s.name?.toLowerCase() === "web");
          if (!a2aEndpoint && web?.endpoint) {
            // Some agents only list web, try it as A2A fallback
          }
        }
      }
    }

    // Test A2A endpoint
    let a2aReachable = false;
    let a2aResponds = false;
    let hasAgentCard = false;

    if (a2aEndpoint && a2aEndpoint.startsWith("http")) {
      const test = await testA2AEndpoint(a2aEndpoint);
      a2aReachable = test.reachable;
      a2aResponds = test.responds;
      hasAgentCard = test.hasCard;
    }

    const record: Partial<AgentRecord> = {
      id, owner, tokenURI, name, description, active, version,
      a2aEndpoint, a2aReachable, a2aResponds, hasAgentCard, services,
      scannedAt: Date.now(),
    };

    const { status, score, category } = classifyAgent(record);

    return { ...record, status, score, category } as AgentRecord;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");

  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   BOB SCOUT — ERC-8004 Registry Scanner               ║");
  console.log("║   Scanning BNB Smart Chain for real agents...          ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const contract = new ethers.Contract(REGISTRY, [
    "function tokenURI(uint256) view returns (string)",
    "function ownerOf(uint256) view returns (address)",
  ], provider);

  // Load existing data
  let registry: RegistryData = {
    lastScan: 0, totalScanned: 0, maxAgentId: 0,
    agents: {}, stats: { total: 0, active: 0, legit: 0, inactive: 0, spam: 0, dead: 0, withA2A: 0, withAgentCard: 0, a2aReachable: 0 },
  };
  if (existsSync(OUTPUT_FILE)) {
    try {
      registry = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
      log(`Loaded existing data: ${Object.keys(registry.agents).length} agents`);
    } catch { /* fresh start */ }
  }

  // Find max agent ID
  log("Finding max agent ID...");
  const maxId = await findMaxAgentId(contract);
  log(`Max agent ID: ${maxId}`);
  registry.maxAgentId = maxId;

  // Determine scan range
  let from = fromIdx >= 0 ? parseInt(args[fromIdx + 1]) : 1;
  let to = toIdx >= 0 ? parseInt(args[toIdx + 1]) : maxId;
  from = Math.max(1, from);
  to = Math.min(maxId, to);

  log(`Scanning agents #${from} to #${to} (${to - from + 1} agents)${quick ? " [QUICK MODE]" : ""}`);

  let scanned = 0;
  let found = 0;
  let errors = 0;

  // Scan in batches
  for (let batchStart = from; batchStart <= to; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, to);
    const ids = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

    const results = await Promise.all(
      ids.map(id => scanAgent(contract, id, quick))
    );

    for (const record of results) {
      scanned++;
      if (record) {
        found++;
        registry.agents[record.id.toString()] = record;
      }
    }

    // Progress
    const pct = Math.round(((batchStart - from) / (to - from + 1)) * 100);
    if (scanned % 100 === 0 || batchEnd === to) {
      log(`${pct}% | Scanned: ${scanned} | Found: ${found} | Errors: ${errors}`);
    }

    // Rate limiting — don't hammer the public RPC
    await new Promise(r => setTimeout(r, 500));
  }

  // Calculate stats
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
  };
  registry.totalScanned = scanned;
  registry.lastScan = Date.now();

  // Save
  writeFileSync(OUTPUT_FILE, JSON.stringify(registry, null, 2));
  log(`\nSaved to ${OUTPUT_FILE}`);

  // Print summary
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   SCOUT SCAN COMPLETE                                  ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║   Total agents: ${String(registry.stats.total).padEnd(38)}║`);
  console.log(`║   Legit (A2A works):  ${String(registry.stats.legit).padEnd(33)}║`);
  console.log(`║   Active (endpoint):  ${String(registry.stats.active).padEnd(33)}║`);
  console.log(`║   Inactive:           ${String(registry.stats.inactive).padEnd(33)}║`);
  console.log(`║   Spam:               ${String(registry.stats.spam).padEnd(33)}║`);
  console.log(`║   Dead:               ${String(registry.stats.dead).padEnd(33)}║`);
  console.log(`║   With A2A endpoint:  ${String(registry.stats.withA2A).padEnd(33)}║`);
  console.log(`║   A2A reachable:      ${String(registry.stats.a2aReachable).padEnd(33)}║`);
  console.log(`║   Valid Agent Card:   ${String(registry.stats.withAgentCard).padEnd(33)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝");

  // Show top agents
  const topAgents = agents
    .filter(a => a.score >= 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (topAgents.length > 0) {
    console.log("\n🏆 TOP AGENTS:");
    for (const a of topAgents) {
      const card = a.hasAgentCard ? "📋" : "  ";
      const a2a = a.a2aResponds ? "✅" : a.a2aReachable ? "🟡" : "❌";
      console.log(`   ${a2a} ${card} #${a.id} ${a.name.slice(0, 30).padEnd(32)} Score:${a.score} [${a.status}] ${a.category}`);
    }
  }

  process.exit(0);
}

main().catch(e => {
  console.error("❌ Fehler:", e);
  process.exit(1);
});
