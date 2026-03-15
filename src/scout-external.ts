/**
 * BOB SCOUT EXTERNAL — Multi-Chain Agent Discovery via 8004scan API
 *
 * Automatically discovers A2A agents across ALL ERC-8004 chains (not just BSC).
 * Sources:
 *   1. 8004scan API — agents from Ethereum, Base, Celo, Arbitrum, Gnosis, Polygon, etc.
 *   2. Curated endpoints — manually added non-ERC-8004 agents
 *
 * Tests each agent's A2A endpoint, classifies, and stores in external-agents.json.
 * IDs: 100.000+ (deterministic from chain:tokenId or endpoint URL via CRC32)
 *
 * Usage: bob scout:ext
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const CURATED_FILE = "data/curated-endpoints.json";
const OUTPUT_FILE = "data/external-agents.json";
const FETCH_TIMEOUT = 10000;
const ID_OFFSET = 100000;

// 8004scan API
const SCAN_API = "https://api.8004scan.io/api/v1";
const BSC_CHAIN_ID = 56;

// How many agent details to fetch (top agents by health score)
const MAX_DETAIL_FETCHES = 300;
// Delay between detail fetches to avoid rate limiting (ms)
const FETCH_DELAY = 500;
// Batch size for parallel detail fetches
const BATCH_SIZE = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExternalAgent {
  id: number;
  owner: string;
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
  status: "active" | "inactive" | "spam" | "legit" | "dead" | "unknown";
  scannedAt: number;
  network: "open-a2a";
  source: "curated" | "discovered" | "8004scan";
  chainId?: number;
  chainName?: string;
  tokenId?: string;
  agentCardUrl?: string;
  agentCardData?: { name: string; description: string; skills: string[]; url: string };
  scanScore?: number; // 8004scan's own score
  healthScore?: number; // 8004scan's health score
  errorReason?: string; // WHY the agent failed A2A test (e.g. "HTTP 402: Payment Required")
}

interface ExternalRegistry {
  lastScan: number;
  totalScanned: number;
  agents: Record<string, ExternalAgent>;
  stats: {
    total: number;
    reachable: number;
    responds: number;
    withAgentCard: number;
  };
  chainBreakdown?: Record<string, number>;
}

// 8004scan API types
interface ScanAgent {
  token_id: string;
  chain_id: number;
  name: string;
  description: string;
  owner_address: string;
  supported_protocols: string[];
  total_score: number;
  health_score: number;
  image_url?: string;
  is_testnet: boolean;
  created_at: string;
}

interface ScanAgentDetail extends ScanAgent {
  a2a_endpoint?: string;
  a2a_version?: string;
  services?: {
    a2a?: {
      endpoint: string;
      version: string;
      skills: any[];
    };
  };
  raw_metadata?: {
    offchain_content?: {
      services?: Array<{
        name: string;
        endpoint: string;
        version?: string;
      }>;
    };
  };
}

interface ScanChain {
  chain_id: number;
  name: string;
  is_testnet: boolean;
  enabled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[SCOUT:EXT ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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

async function fetchJSON<T>(url: string, retries = 2): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url);
      if (resp.status === 429) {
        log(`  ⏳ Rate limited, waiting ${2 ** attempt}s...`);
        await sleep(2000 * (2 ** attempt));
        continue;
      }
      if (!resp.ok) {
        if (attempt < retries) { await sleep(500); continue; }
        return null;
      }
      return await resp.json() as T;
    } catch (e: any) {
      if (attempt < retries) { await sleep(500); continue; }
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** CRC32 — deterministic ID from string */
function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Generate deterministic ID (100.000+) from chain:tokenId or endpoint URL */
function generateId(key: string): number {
  const normalized = key.replace(/\/$/, "").toLowerCase();
  return ID_OFFSET + (crc32(normalized) % 900000); // 100.000 – 999.999
}

/** HTTP status code → human-readable reason */
function httpStatusReason(status: number): string {
  const reasons: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    402: "Payment Required (x402)",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    429: "Rate Limited",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return reasons[status] || `HTTP ${status}`;
}

/** Test A2A endpoint — agent card + JSON-RPC probe with error diagnostics */
async function testA2AEndpoint(endpoint: string): Promise<{
  reachable: boolean;
  responds: boolean;
  hasCard: boolean;
  cardData: { name: string; description: string; skills: string[]; url: string } | null;
  errorReason: string | null;
}> {
  if (!endpoint?.startsWith("http")) return { reachable: false, responds: false, hasCard: false, cardData: null, errorReason: "Invalid URL" };

  let reachable = false, responds = false, hasCard = false;
  let cardData: { name: string; description: string; skills: string[]; url: string } | null = null;
  let errorReason: string | null = null;

  // Check agent card
  try {
    const isCardUrl = endpoint.includes("agent-card") || endpoint.includes("agent.json");
    const cardUrl = isCardUrl ? endpoint : endpoint.replace(/\/$/, "") + "/.well-known/agent.json";
    const resp = await fetchWithTimeout(cardUrl);
    if (resp.ok) {
      const card = await resp.json() as any;
      hasCard = !!(card.name && (card.skills || card.supported_interfaces || card.capabilities));
      reachable = true;
      if (hasCard) {
        const skills = Array.isArray(card.skills)
          ? card.skills.map((s: any) => typeof s === "string" ? s : s.name || s.id || "").filter(Boolean)
          : [];
        cardData = {
          name: card.name || "",
          description: (card.description || "").slice(0, 300),
          skills,
          url: card.url || endpoint,
        };
      }
    }
  } catch {
    try {
      const resp = await fetchWithTimeout(endpoint);
      reachable = resp.ok || resp.status === 405;
      if (!reachable) errorReason = httpStatusReason(resp.status);
    } catch (e: any) {
      reachable = false;
      errorReason = e?.cause?.code === "ECONNREFUSED" ? "Connection refused"
        : e?.cause?.code === "ENOTFOUND" ? "DNS not found"
        : e?.name === "AbortError" ? "Timeout (10s)"
        : `Unreachable: ${(e?.message || "unknown").slice(0, 60)}`;
    }
  }

  // Test JSON-RPC (only if we have a base URL, not an agent-card URL)
  const isCardUrl = endpoint.includes("agent-card") || endpoint.includes("agent.json");
  const rpcUrl = isCardUrl ? endpoint.replace(/\/\.well-known\/.*$/, "") : endpoint;

  if (reachable && rpcUrl) {
    // Try message/send first (standard A2A)
    const rpcResult = await tryJsonRpc(rpcUrl, "message/send", {
      message: { role: "user", parts: [{ text: "gm" }] },
      senderName: "BOB Scout",
    });

    if (rpcResult.ok) {
      responds = true;
      errorReason = null; // success clears any earlier error
    } else if (rpcResult.status === 405) {
      // Try alternate methods — some agents only support tasks/get or different formats
      const altResult = await tryJsonRpc(rpcUrl, "tasks/get", { id: "test" });
      if (altResult.ok) {
        responds = true;
        errorReason = null;
      } else {
        errorReason = `HTTP 405: POST not allowed (tried message/send + tasks/get)`;
      }
    } else if (rpcResult.status === 402) {
      errorReason = "HTTP 402: Payment Required (x402 paywall)";
    } else if (rpcResult.status === 401 || rpcResult.status === 403) {
      errorReason = `HTTP ${rpcResult.status}: ${rpcResult.status === 401 ? "Auth required" : "Forbidden"}`;
    } else if (rpcResult.error) {
      errorReason = rpcResult.error;
    } else if (rpcResult.status && rpcResult.status >= 400) {
      errorReason = httpStatusReason(rpcResult.status);
    } else if (!rpcResult.validJsonRpc) {
      errorReason = "Invalid response: not JSON-RPC 2.0 format";
    }
  } else if (!reachable && !errorReason) {
    errorReason = "Endpoint unreachable";
  }

  return { reachable, responds, hasCard, cardData, errorReason };
}

/** Try a single JSON-RPC call and return diagnostic info */
async function tryJsonRpc(url: string, method: string, params: any): Promise<{
  ok: boolean;
  status?: number;
  validJsonRpc?: boolean;
  error?: string;
}> {
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, id: "scout-ext-test", params }),
    });

    if (!resp.ok) {
      return { ok: false, status: resp.status };
    }

    try {
      const data = await resp.json() as any;
      const valid = !!(data.jsonrpc === "2.0" || data.result || data.artifacts || data.message);
      return { ok: valid, status: resp.status, validJsonRpc: valid };
    } catch {
      return { ok: false, status: resp.status, error: "Response not valid JSON" };
    }
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? "Timeout (10s)"
      : e?.cause?.code === "ECONNREFUSED" ? "Connection refused"
      : `Network error: ${(e?.message || "unknown").slice(0, 60)}`;
    return { ok: false, error: reason };
  }
}

/** Classify external agent */
function classifyAgent(r: Partial<ExternalAgent>): { status: ExternalAgent["status"]; score: number; category: string } {
  let score = 0;
  if (r.name && r.name !== "unknown") score += 10;
  if (r.description && r.description.length > 20) score += 10;
  if (r.a2aEndpoint) score += 10;
  if (r.a2aReachable) score += 20;
  if (r.a2aResponds) score += 25;
  if (r.hasAgentCard) score += 20;
  if (r.agentCardData?.skills && r.agentCardData.skills.length > 0) score += 5;

  let status: ExternalAgent["status"] = "unknown";
  if (score >= 70 && r.a2aResponds) status = "legit";
  else if (score >= 40 && r.a2aReachable) status = "active";
  else if (score >= 20) status = "inactive";
  else status = "dead";

  const text = `${(r.name || "").toLowerCase()} ${(r.description || "").toLowerCase()}`;
  let category = "general";
  if (text.includes("defi") || text.includes("swap") || text.includes("yield")) category = "defi";
  else if (text.includes("trade") || text.includes("trading") || text.includes("market")) category = "trading";
  else if (text.includes("analyt") || text.includes("data") || text.includes("intel")) category = "analytics";
  else if (text.includes("social") || text.includes("chat") || text.includes("community")) category = "social";
  else if (text.includes("ai") || text.includes("llm") || text.includes("assistant")) category = "ai";
  else if (text.includes("security") || text.includes("audit")) category = "security";
  else if (text.includes("infrastructure") || text.includes("bridge")) category = "infrastructure";
  else if (text.includes("nft") || text.includes("token") || text.includes("mint")) category = "nft";
  else if (text.includes("game") || text.includes("play")) category = "gaming";

  return { status, score: Math.min(score, 100), category };
}

// ─── 8004scan Discovery ─────────────────────────────────────────────────────

async function discoverFrom8004scan(): Promise<ExternalAgent[]> {
  log("── 8004scan Multi-Chain Discovery ──");

  // Load existing agents to avoid re-fetching known ones
  let knownEndpoints = new Set<string>();
  let existingAgents: ExternalAgent[] = [];
  if (existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
      existingAgents = Object.values(existing.agents || {}) as ExternalAgent[];
      for (const a of existingAgents) {
        if (a.a2aEndpoint) knownEndpoints.add(a.a2aEndpoint.replace(/\/$/, "").toLowerCase());
      }
      log(`Loaded ${knownEndpoints.size} known agents — will only fetch NEW ones`);
    } catch { /* ignore */ }
  }

  // 1. Get chains
  const chainsResp = await fetchJSON<{ success: boolean; data: { chains: ScanChain[] } }>(`${SCAN_API}/chains`);
  if (!chainsResp?.data?.chains) {
    log("❌ Failed to fetch chains from 8004scan — returning existing data");
    return existingAgents;
  }

  const mainnetChains = chainsResp.data.chains.filter(c => !c.is_testnet && c.enabled && c.chain_id !== BSC_CHAIN_ID);
  log(`Found ${mainnetChains.length} mainnet chains (excl. BSC):`);
  for (const c of mainnetChains) log(`  • ${c.name} (${c.chain_id})`);

  // 2. Fetch A2A agents — stop paging each chain once we hit agents we already know
  const newAgents: ScanAgent[] = [];
  const PAGE_SIZE = 100;

  for (const chain of mainnetChains) {
    let offset = 0;
    let chainTotal = 0;
    let hitKnown = 0;
    while (true) {
      const url = `${SCAN_API}/agents?chain_id=${chain.chain_id}&has_a2a=true&is_active=true&is_testnet=false&limit=${PAGE_SIZE}&offset=${offset}&sort_by=created_at&sort_order=desc`;
      const resp = await fetchJSON<{ items: ScanAgent[]; total: number }>(url);
      if (!resp?.items?.length) break;

      for (const agent of resp.items) {
        // Check if we already know this agent by its endpoint
        const ep = (agent as any).a2a_endpoint || "";
        if (ep && knownEndpoints.has(ep.replace(/\/$/, "").toLowerCase())) {
          hitKnown++;
        } else {
          newAgents.push(agent);
          chainTotal++;
        }
      }

      offset += PAGE_SIZE;
      // If we hit 10+ known agents in a row or reached end, stop paging this chain
      if (hitKnown >= 10 || offset >= resp.total) break;
      await sleep(300); // rate limit respect
    }
    if (chainTotal > 0) log(`  ${chain.name}: ${chainTotal} NEW A2A agents`);
    await sleep(300); // between chains
  }

  const allAgents = newAgents;
  log(`\nNew agents to process: ${allAgents.length} (skipped ${knownEndpoints.size} known)`);

  log(`\nTotal non-BSC A2A agents found: ${allAgents.length}`);

  // 3. Sort by health_score desc, take top N for detail fetching
  allAgents.sort((a, b) => (b.health_score || 0) - (a.health_score || 0));
  const topAgents = allAgents.slice(0, MAX_DETAIL_FETCHES);
  log(`Fetching details for top ${topAgents.length} agents (by health score)...\n`);

  // 4. Fetch details in batches to get a2a_endpoint
  const results: ExternalAgent[] = [];
  const chainNames: Record<number, string> = {};
  for (const c of mainnetChains) chainNames[c.chain_id] = c.name;

  for (let i = 0; i < topAgents.length; i += BATCH_SIZE) {
    const batch = topAgents.slice(i, i + BATCH_SIZE);
    const detailPromises = batch.map(async (agent) => {
      const detail = await fetchJSON<ScanAgentDetail>(`${SCAN_API}/agents/${agent.chain_id}/${agent.token_id}`);
      if (!detail) return null;

      // Extract A2A endpoint
      let a2aEndpoint = detail.a2a_endpoint || "";
      if (!a2aEndpoint && detail.services?.a2a?.endpoint) {
        a2aEndpoint = detail.services.a2a.endpoint;
      }
      if (!a2aEndpoint) return null; // No endpoint, skip

      // If endpoint is an agent card URL (.json), fetch the card and extract the real A2A endpoint
      if (a2aEndpoint.endsWith(".json") || a2aEndpoint.includes("agent-card") || a2aEndpoint.includes("agent.json")) {
        try {
          const card = await fetchJSON<any>(a2aEndpoint);
          if (card) {
            // A2A spec: supported_interfaces[0].url or url field
            const realUrl = card.supported_interfaces?.[0]?.url || card.url || card.endpoint;
            if (realUrl && !realUrl.endsWith(".json")) {
              a2aEndpoint = realUrl;
            } else {
              // Derive base URL from card URL (strip /.well-known/*)
              a2aEndpoint = a2aEndpoint.replace(/\/\.well-known\/.*$/, "").replace(/\/agent-card\.json$/, "");
            }
          }
        } catch {}
      }

      const id = Number(agent.token_id);

      return {
        id,
        owner: detail.owner_address || "unknown",
        name: detail.name || "unknown",
        description: (detail.description || "").slice(0, 500),
        active: true,
        version: detail.a2a_version || "",
        a2aEndpoint,
        hasAgentCard: false, // will be tested
        a2aReachable: false, // will be tested
        a2aResponds: false, // will be tested
        category: "general",
        score: 0,
        services: detail.supported_protocols || ["A2A"],
        status: "unknown" as const,
        scannedAt: Date.now(),
        network: "open-a2a" as const,
        source: "8004scan" as const,
        chainId: agent.chain_id,
        chainName: chainNames[agent.chain_id] || `Chain ${agent.chain_id}`,
        tokenId: agent.token_id,
        scanScore: detail.total_score,
        healthScore: detail.health_score,
      };
    });

    const batchResults = await Promise.all(detailPromises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }

    // Progress
    const done = Math.min(i + BATCH_SIZE, topAgents.length);
    if (done % 50 === 0 || done === topAgents.length) {
      log(`  Details: ${done}/${topAgents.length} fetched (${results.length} with endpoints)`);
    }

    await sleep(FETCH_DELAY);
  }

  log(`\n${results.length} agents with A2A endpoints found`);

  // 5. Deduplicate by endpoint URL (same endpoint on different chains)
  const seen = new Map<string, ExternalAgent>();
  for (const agent of results) {
    const endpointKey = agent.a2aEndpoint.replace(/\/$/, "").toLowerCase();
    const existing = seen.get(endpointKey);
    if (!existing || (agent.healthScore || 0) > (existing.healthScore || 0)) {
      seen.set(endpointKey, agent);
    }
  }
  const deduplicated = Array.from(seen.values());
  log(`After dedup by endpoint: ${deduplicated.length} unique agents`);

  // 6. Test A2A endpoints
  log(`\n── Testing ${deduplicated.length} A2A endpoints ──\n`);

  for (let i = 0; i < deduplicated.length; i += BATCH_SIZE) {
    const batch = deduplicated.slice(i, i + BATCH_SIZE);
    const testPromises = batch.map(async (agent) => {
      const test = await testA2AEndpoint(agent.a2aEndpoint);
      agent.a2aReachable = test.reachable;
      agent.a2aResponds = test.responds;
      agent.hasAgentCard = test.hasCard;
      agent.errorReason = test.errorReason || undefined;
      if (test.cardData) {
        agent.agentCardUrl = agent.a2aEndpoint;
        agent.agentCardData = test.cardData;
        // Update name/description from card if better
        if (test.cardData.name && test.cardData.name.length > agent.name.length) {
          agent.name = test.cardData.name;
        }
        if (test.cardData.description && test.cardData.description.length > agent.description.length) {
          agent.description = test.cardData.description;
        }
      }

      const { status, score, category } = classifyAgent(agent);
      agent.status = status;
      agent.score = score;
      agent.category = category;

      const icon = test.responds ? "✅" : test.reachable ? "🟡" : "❌";
      const chain = agent.chainName || "?";
      const reason = test.errorReason ? ` → ${test.errorReason}` : "";
      log(`  ${icon} [${chain}] #${agent.id} "${agent.name.slice(0, 35)}" Score:${score} [${status}]${reason}`);
    });

    await Promise.all(testPromises);
    await sleep(FETCH_DELAY);
  }

  return deduplicated;
}

// ─── Curated Endpoints ──────────────────────────────────────────────────────

async function scanCuratedEndpoints(): Promise<ExternalAgent[]> {
  if (!existsSync(CURATED_FILE)) return [];

  const curated = JSON.parse(readFileSync(CURATED_FILE, "utf-8"));
  const endpoints: { url: string; name: string; notes?: string }[] = curated.endpoints || [];
  if (endpoints.length === 0) return [];

  log(`\n── Scanning ${endpoints.length} curated endpoints ──\n`);

  const results: ExternalAgent[] = [];
  for (const ep of endpoints) {
    const id = generateId(ep.url);
    log(`Testing ${ep.name} (${ep.url}) → ID #${id}`);

    const test = await testA2AEndpoint(ep.url);
    const name = test.cardData?.name || ep.name || "unknown";
    const description = test.cardData?.description || ep.notes || "";

    const record: Partial<ExternalAgent> = {
      id,
      owner: "external",
      name,
      description,
      active: test.reachable,
      version: "",
      a2aEndpoint: ep.url,
      a2aReachable: test.reachable,
      a2aResponds: test.responds,
      hasAgentCard: test.hasCard,
      services: test.hasCard ? ["A2A"] : [],
      scannedAt: Date.now(),
      network: "open-a2a",
      source: "curated",
      agentCardUrl: test.hasCard ? ep.url.replace(/\/$/, "") + "/.well-known/agent.json" : undefined,
      agentCardData: test.cardData || undefined,
      errorReason: test.errorReason || undefined,
    };

    const { status, score, category } = classifyAgent(record);
    results.push({ ...record, status, score, category } as ExternalAgent);

    const icon = test.responds ? "✅" : test.reachable ? "🟡" : "❌";
    const reason = test.errorReason ? ` → ${test.errorReason}` : "";
    log(`  ${icon} #${id} "${name.slice(0, 35)}" Score:${score} [${status}]${reason}`);
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║   BOB SCOUT:EXT — Multi-Chain Agent Discovery             ║");
  console.log("║   8004scan API + Curated Endpoints                        ║");
  console.log("║   Finding REAL agents across ALL chains...                ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  // Save existing data before scanning (for safety check)
  let existingBackup: string | null = null;
  if (existsSync(OUTPUT_FILE)) {
    existingBackup = readFileSync(OUTPUT_FILE, "utf-8");
  }

  // Run both discovery sources
  const [scanAgents, curatedAgents] = await Promise.all([
    discoverFrom8004scan(),
    scanCuratedEndpoints(),
  ]);

  // Merge — start with existing data, add new on top. Curated takes priority.
  const merged = new Map<string, ExternalAgent>();

  // 1. Load existing agents first (preserve old data)
  if (existingBackup) {
    try {
      const existing = JSON.parse(existingBackup);
      for (const [, agent] of Object.entries(existing.agents || {})) {
        const a = agent as ExternalAgent;
        if (a.a2aEndpoint) merged.set(a.a2aEndpoint.replace(/\/$/, "").toLowerCase(), a);
      }
      log(`Preserved ${merged.size} existing agents`);
    } catch { /* ignore */ }
  }

  // 2. Add/update with new scan results
  for (const agent of scanAgents) {
    merged.set(agent.a2aEndpoint.replace(/\/$/, "").toLowerCase(), agent);
  }
  // 3. Curated takes priority
  for (const agent of curatedAgents) {
    merged.set(agent.a2aEndpoint.replace(/\/$/, "").toLowerCase(), agent);
  }

  const allAgents = Array.from(merged.values());
  const newCount = scanAgents.length + curatedAgents.length;
  log(`Total: ${allAgents.length} agents (${newCount} new/updated, ${allAgents.length - newCount} preserved)`);

  // Build registry
  const registry: ExternalRegistry = {
    lastScan: Date.now(),
    totalScanned: allAgents.length,
    agents: {},
    stats: {
      total: allAgents.length,
      reachable: allAgents.filter(a => a.a2aReachable).length,
      responds: allAgents.filter(a => a.a2aResponds).length,
      withAgentCard: allAgents.filter(a => a.hasAgentCard).length,
    },
    chainBreakdown: {},
  };

  // Chain breakdown
  const chainCounts: Record<string, number> = {};
  for (const agent of allAgents) {
    const chain = agent.chainName || "curated";
    chainCounts[chain] = (chainCounts[chain] || 0) + 1;
    // Use chain-prefixed key to avoid collision with BSC IDs
    const chainPrefix = agent.chainName?.toLowerCase().replace(/\s+/g, "-") || "ext";
    const key = agent.source === "curated" ? `curated:${agent.id}` : `${chainPrefix}:${agent.id}`;
    registry.agents[key] = agent;
  }
  registry.chainBreakdown = chainCounts;

  if (!existsSync("data")) mkdirSync("data");
  // Backup existing data before overwriting
  if (existsSync(OUTPUT_FILE)) {
    const prev = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
    if (Object.keys(prev.agents || {}).length > 0) {
      writeFileSync(OUTPUT_FILE.replace(".json", ".backup.json"), readFileSync(OUTPUT_FILE, "utf-8"));
      log("📦 Backed up previous data to external-agents.backup.json");
    }
  }
  writeFileSync(OUTPUT_FILE, JSON.stringify(registry, null, 2));
  log(`\nSaved to ${OUTPUT_FILE}`);

  // Summary
  const reachable = registry.stats.reachable;
  const responds = registry.stats.responds;
  const withCard = registry.stats.withAgentCard;

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║   SCOUT:EXT COMPLETE — Multi-Chain Discovery               ║");
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log(`║   8004scan agents:    ${String(scanAgents.length).padEnd(37)}║`);
  console.log(`║   Curated agents:     ${String(curatedAgents.length).padEnd(37)}║`);
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log(`║   Total unique:       ${String(allAgents.length).padEnd(37)}║`);
  console.log(`║   Reachable:          ${String(reachable).padEnd(37)}║`);
  console.log(`║   Responds (A2A):     ${String(responds).padEnd(37)}║`);
  console.log(`║   With Agent Card:    ${String(withCard).padEnd(37)}║`);
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log("║   Chain Breakdown:                                         ║");
  for (const [chain, count] of Object.entries(chainCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`║     ${chain.padEnd(22)} ${String(count).padEnd(33)}║`);
  }
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  process.exit(0);
}

main().catch(e => {
  console.error("❌ Error:", e);
  process.exit(1);
});
