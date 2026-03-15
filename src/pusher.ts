/**
 * BOB PUSHER — Outreach Agent
 *
 * Monitors for new agent registrations on BSC ERC-8004 registry.
 * When new agents appear:
 * - Scans them immediately
 * - If they have A2A, sends a greeting message
 * - Updates the registry data
 *
 * Usage: npm run push
 *        npm run push -- --greet    (also send A2A greetings)
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { Brain } from "./brain.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const BSC_RPC = "https://bsc-dataseed.binance.org";
const REGISTRY_ADDR = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const DATA_FILE = "data/agent-registry.json";
const FETCH_TIMEOUT = 8000;
const BOB_URL = "https://project-gkws4.vercel.app";
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

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

// ─── Helpers (same as scout.ts) ──────────────────────────────────────────────

function log(msg: string) {
  console.log(`[PUSHER ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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
      return JSON.parse(Buffer.from(base64, "base64").toString());
    } catch { return null; }
  }
  return null;
}

async function testA2AEndpoint(endpoint: string): Promise<{ reachable: boolean; responds: boolean; hasCard: boolean; errorReason: string | null }> {
  if (!endpoint?.startsWith("http")) return { reachable: false, responds: false, hasCard: false, errorReason: "Invalid URL" };

  let reachable = false, responds = false, hasCard = false;
  let errorReason: string | null = null;

  try {
    const cardUrl = endpoint.replace(/\/$/, "") + "/.well-known/agent.json";
    const resp = await fetchWithTimeout(cardUrl);
    if (resp.ok) {
      const card = await resp.json();
      hasCard = !!(card.name && card.skills && card.supported_interfaces);
      reachable = true;
    }
  } catch {
    try {
      const resp = await fetchWithTimeout(endpoint);
      reachable = resp.ok || resp.status === 405;
      if (!reachable) errorReason = `HTTP ${resp.status}`;
    } catch (e: any) {
      reachable = false;
      errorReason = e?.name === "AbortError" ? "Timeout" : "Unreachable";
    }
  }

  if (reachable) {
    try {
      const resp = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/send",
          id: "pusher-probe",
          params: { message: { messageId: `probe-${Date.now()}`, role: "user", parts: [{ type: "text", text: "gm" }] } },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        responds = !!(data.jsonrpc === "2.0" || data.result || data.artifacts);
        if (!responds) errorReason = "Invalid response: not JSON-RPC 2.0";
      } else {
        errorReason = resp.status === 402 ? "HTTP 402: Payment Required (x402)"
          : resp.status === 405 ? "HTTP 405: POST not allowed"
          : resp.status === 401 ? "HTTP 401: Auth required"
          : `HTTP ${resp.status}`;
      }
    } catch (e: any) {
      responds = false;
      errorReason = e?.name === "AbortError" ? "Timeout on POST" : "Network error";
    }
  }

  if (responds) errorReason = null; // success clears error
  return { reachable, responds, hasCard, errorReason };
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

  // Spam detection (name alone is enough for known mass-registered patterns)
  const spamPatterns = [/^ave\.?ai trading agent$/i, /^debot trading agent$/i, /^mevx trading agent$/i, /^meme bot$/i, /^myaiagent$/i];
  const isSpamName = spamPatterns.some(p => p.test(r.name ?? ""));
  const isEmptySpam = r.tokenURI && !r.name;

  // IMPORTANT: Check spam FIRST before score-based classification
  let status: AgentRecord["status"] = "unknown";
  if (isSpamName || isEmptySpam) status = "spam";
  else if (score >= 70 && r.a2aResponds) status = "legit";
  else if (score >= 40 && r.a2aReachable) status = "active";
  else if (score >= 20) status = "inactive";
  else if (r.name && r.name !== "unknown") status = "dead";
  else status = "dead";

  if (status === "spam") score = 0;

  // Category (expanded with pattern detection)
  let category = "unknown";
  const rawName = r.name ?? "";
  const isEnsoul = /· ensoul/i.test(rawName) || /ensoul\.app/i.test(rawName) || /^@\w+\s+(·\s+)?ensoul/i.test(rawName);
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

// ─── A2A Greeting ────────────────────────────────────────────────────────────

async function sendGreeting(endpoint: string, agentName: string, agentId: number): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        id: `pusher-greet-${agentId}`,
        params: {
          message: {
            messageId: `greet-${agentId}-${Date.now()}`,
            role: "user",
            parts: [{
              type: "text",
              text: `gm ${agentName}! This is BOB — Agent Intelligence Service on BNB Chain (Agent #36035). I scan the ERC-8004 registry and just found you. You're one of the few agents with a working A2A endpoint. Respect for actually building. What are you working on? Build On BNB.`,
            }],
          },
        },
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const replyText = data.result?.artifacts?.[0]?.parts?.[0]?.text
        ?? data.result?.status?.message?.parts?.[0]?.text
        ?? data.result?.message?.parts?.[0]?.text
        ?? JSON.stringify(data).slice(0, 200);
      return replyText;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ask an agent about its capabilities — real task delegation, not just gm */
async function askCapabilities(endpoint: string, agentName: string, agentId: number): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        id: `pusher-cap-${agentId}`,
        params: {
          message: {
            messageId: `cap-${agentId}-${Date.now()}`,
            role: "user",
            parts: [{
              type: "text",
              text: `What are your capabilities? I'm BOB — the Agent Intelligence Gateway on BNB Chain. I route task requests from other agents to specialists. If you can handle DeFi swaps, security audits, analytics, trading, or any specific tasks — tell me what you do and I'll send you work. What tasks can you execute?`,
            }],
          },
          senderName: "BOB Gateway",
        },
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const replyText = data.result?.artifacts?.[0]?.parts?.[0]?.text
        ?? data.result?.status?.message?.parts?.[0]?.text
        ?? data.result?.message?.parts?.[0]?.text
        ?? null;
      return replyText;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const doGreet = args.includes("--greet");

  // Initialize Brain for failure memory
  const brain = new Brain();
  const deadAgents = brain.getDeadAgents();

  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   BOB PUSHER — Outreach Agent (Brain-linked)           ║");
  console.log("║   Monitoring for new agents on BSC...                  ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");
  if (deadAgents.length > 0) {
    log(`Brain says ${deadAgents.length} agents are permanently dead — skipping them`);
  }

  // Load existing data
  if (!existsSync(DATA_FILE)) {
    console.error("❌ No registry data. Run 'npm run scout' first.");
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const oldMaxId = registry.maxAgentId;
  const existingIds = new Set(Object.keys(registry.agents).map(Number));

  log(`Loaded registry: ${Object.keys(registry.agents).length} agents, max ID: ${oldMaxId}`);

  // Find current max ID
  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const contract = new ethers.Contract(REGISTRY_ADDR, [
    "function tokenURI(uint256) view returns (string)",
    "function ownerOf(uint256) view returns (address)",
  ], provider);

  let lo = oldMaxId, hi = oldMaxId + 500;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await contract.ownerOf(mid);
      lo = mid + 1;
    } catch {
      hi = mid;
    }
  }
  const newMaxId = lo - 1;

  if (newMaxId <= oldMaxId) {
    log(`No new agents. Max ID still ${oldMaxId}.`);
  } else {
    log(`🆕 NEW AGENTS DETECTED! ${oldMaxId + 1} → ${newMaxId} (${newMaxId - oldMaxId} new)`);
  }

  // Scan new agents
  const newAgents: AgentRecord[] = [];

  for (let id = oldMaxId + 1; id <= newMaxId; id++) {
    try {
      const [owner, tokenURI] = await Promise.all([
        contract.ownerOf(id).catch(() => null),
        contract.tokenURI(id).catch(() => ""),
      ]);
      if (!owner) continue;

      let name = "unknown", description = "", active = false, version = "", a2aEndpoint = "", services: string[] = [];

      if (tokenURI) {
        const meta = await fetchIPFS(tokenURI);
        if (meta) {
          name = meta.name ?? "unknown";
          description = (meta.description ?? "").slice(0, 300);
          active = meta.active ?? false;
          version = meta.version ?? "";
          if (meta.services && Array.isArray(meta.services)) {
            services = meta.services.map((s: any) => s.name).filter(Boolean);
            const a2a = meta.services.find((s: any) => s.name?.toLowerCase() === "a2a");
            if (a2a) a2aEndpoint = a2a.endpoint ?? "";
          }
        }
      }

      // Fix agent card URL stored as A2A endpoint
      if (a2aEndpoint && (a2aEndpoint.endsWith(".json") || a2aEndpoint.includes("agent-card") || a2aEndpoint.includes(".well-known"))) {
        a2aEndpoint = a2aEndpoint.replace(/\/\.well-known\/.*$/, "").replace(/\/agent-card\.json$/, "").replace(/\/agent\.json$/, "");
      }

      let a2aReachable = false, a2aResponds = false, hasAgentCard = false;
      if (a2aEndpoint?.startsWith("http")) {
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
      const agent = { ...record, status, score, category } as AgentRecord;

      newAgents.push(agent);
      registry.agents[id.toString()] = agent;

      const a2aIcon = a2aResponds ? "✅" : a2aReachable ? "🟡" : "❌";
      log(`  ${a2aIcon} #${id} "${name}" [${status}] Score:${score} ${category}`);
    } catch {
      continue;
    }
  }

  // Always greet new agents with working A2A
  const greetableNew = newAgents.filter(a => a.a2aResponds && a.a2aEndpoint !== BOB_URL);
  if (greetableNew.length > 0) {
    log(`\n📤 Greeting ${greetableNew.length} NEW agents with A2A...`);
    for (const agent of greetableNew) {
      log(`  → Greeting #${agent.id} "${agent.name}" at ${agent.a2aEndpoint}`);
      const reply = await sendGreeting(agent.a2aEndpoint, agent.name, agent.id);
      if (reply) {
        log(`  ✅ Reply: "${reply.slice(0, 200)}"`);
        brain.rememberAgent(agent.id, agent.name, agent.a2aEndpoint, reply, "greeting");
        brain.rememberA2ASuccess(agent.id);
      } else {
        log(`  ❌ No reply`);
        brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, "No reply to greeting");
      }
    }
  }

  // ── Also contact EXTERNAL agents (Base, Ethereum, etc.) ──────────────────
  const EXT_FILE = "data/external-agents.json";
  interface ExtAgent {
    id: number;
    name: string;
    a2aEndpoint: string;
    a2aReachable: boolean;
    a2aResponds: boolean;
    hasAgentCard: boolean;
    chainName?: string;
    network?: string;
    score: number;
    status: string;
    [key: string]: any;
  }
  let extAgents: ExtAgent[] = [];
  let extRegistry: any = null;
  if (existsSync(EXT_FILE)) {
    extRegistry = JSON.parse(readFileSync(EXT_FILE, "utf-8"));
    extAgents = Object.values(extRegistry.agents) as ExtAgent[];
    const extA2A = extAgents.filter(a =>
      a.a2aEndpoint?.startsWith("http") &&
      a.a2aEndpoint !== BOB_URL &&
      (a.a2aReachable || a.a2aResponds) &&
      !brain.isAgentDead(a.id)
    );
    if (extA2A.length > 0) {
      log(`\n🌐 Contacting ${extA2A.length} EXTERNAL agents across chains...`);
      let extContacted = 0;
      for (const agent of extA2A) {
        const chain = agent.chainName || "External";
        const test = await testA2AEndpoint(agent.a2aEndpoint);
        agent.a2aReachable = test.reachable;
        agent.a2aResponds = test.responds;
        agent.hasAgentCard = test.hasCard;

        if (test.responds) {
          log(`  🤝 [${chain}] #${agent.id} "${agent.name}" is ALIVE! Sending message...`);
          const reply = await sendGreeting(agent.a2aEndpoint, agent.name, agent.id);
          if (reply) {
            log(`  ✅ REPLY from [${chain}] #${agent.id}: "${reply.slice(0, 200)}"`);
            extContacted++;
            brain.rememberAgent(agent.id, agent.name, agent.a2aEndpoint, reply, "external_greeting");
            brain.rememberA2ASuccess(agent.id);
            // Log to BOB chat
            try {
              await fetchWithTimeout(BOB_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "message/send",
                  id: `pusher-ext-${agent.id}`,
                  params: {
                    message: { messageId: `pusher-ext-${agent.id}-${Date.now()}`, role: "user", parts: [{ type: "text", text: `[PUSHER] Contacted [${chain}] #${agent.id} "${agent.name}" — they replied: "${reply.slice(0, 100)}"` }] },
                    senderName: "PUSHER",
                  },
                }),
              });
            } catch {}
          } else {
            log(`  ⚠️  [${chain}] #${agent.id} accepted request but no text reply`);
            brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, "No text reply (external)");
          }
        } else if (test.reachable) {
          const reason = test.errorReason || "Unknown";
          log(`  🟡 [${chain}] #${agent.id} "${agent.name}" reachable but doesn't respond (${reason})`);
          brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, reason, test.errorReason?.match(/HTTP (\d+)/)?.[1] ? parseInt(test.errorReason!.match(/HTTP (\d+)/)![1]) : undefined);
        } else {
          brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, test.errorReason || "Unreachable");
        }
      }
      log(`\n🌐 External: ${extContacted} replied out of ${extA2A.length} agents.`);
    }
    // Save updated external data
    writeFileSync(EXT_FILE, JSON.stringify(extRegistry, null, 2));
  }

  // Also try ALL known BSC agents with A2A that we haven't chatted with yet
  const allAgents = Object.values(registry.agents) as AgentRecord[];
  const allA2A = allAgents.filter(a =>
    a.a2aEndpoint?.startsWith("http") &&
    a.a2aEndpoint !== BOB_URL &&
    (a.a2aReachable || a.a2aResponds) &&
    a.id !== 36035 && a.id !== 36336 && a.id !== 37103 && a.id !== 37092 &&  // skip BOB agents
    !brain.isAgentDead(a.id)  // skip permanently dead agents
  );

  if (allA2A.length > 0) {
    log(`\n🔍 Scanning ${allA2A.length} known A2A agents for live connections...`);
    let contacted = 0;
    for (const agent of allA2A) {
      // Re-test if endpoint is alive
      const test = await testA2AEndpoint(agent.a2aEndpoint);
      agent.a2aReachable = test.reachable;
      agent.a2aResponds = test.responds;
      agent.hasAgentCard = test.hasCard;

      if (test.responds) {
        // If we already know this agent, ask about capabilities instead of gm
        const known = brain.memory.relationships[String(agent.id)];
        const isKnown = known && (known.responses || 0) > 0;

        if (isKnown) {
          log(`  🔍 #${agent.id} "${agent.name}" — already known, asking capabilities...`);
          const capReply = await askCapabilities(agent.a2aEndpoint, agent.name, agent.id);
          if (capReply) {
            log(`  📋 Capabilities from #${agent.id}: "${capReply.slice(0, 200)}"`);
            brain.rememberAgent(agent.id, agent.name, agent.a2aEndpoint, capReply, "capability_discovery");
            brain.rememberA2ASuccess(agent.id);
            contacted++;
          }
        } else {
          log(`  🤝 #${agent.id} "${agent.name}" is ALIVE! First contact...`);
        }

        const reply = isKnown ? null : await sendGreeting(agent.a2aEndpoint, agent.name, agent.id);
        if (reply) {
          log(`  ✅ REPLY from #${agent.id}: "${reply.slice(0, 200)}"`);
          contacted++;
          brain.rememberAgent(agent.id, agent.name, agent.a2aEndpoint, reply, "bsc_outreach");
          brain.rememberA2ASuccess(agent.id);

          // Log to BOB chat via API
          try {
            await fetchWithTimeout(BOB_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "message/send",
                id: `pusher-log-${agent.id}`,
                params: {
                  message: { messageId: `pusher-log-${agent.id}-${Date.now()}`, role: "user", parts: [{ type: "text", text: `[PUSHER] Contacted #${agent.id} "${agent.name}" — they replied: "${reply.slice(0, 100)}"` }] },
                  senderName: "PUSHER",
                },
              }),
            });
          } catch {}
        } else if (!isKnown) {
          log(`  ⚠️  #${agent.id} accepted request but no text reply`);
          brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, "No text reply");
        }
      } else if (test.reachable) {
        const reason = test.errorReason || "Unknown";
        log(`  🟡 #${agent.id} "${agent.name}" reachable but doesn't respond (${reason})`);
        brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, reason);
      } else {
        brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, test.errorReason || "Unreachable");
      }

      // Update registry data
      registry.agents[agent.id.toString()] = agent;
    }
    log(`\n📊 Contacted ${contacted} agents that actually replied out of ${allA2A.length} with A2A endpoints.`);
  }

  // Update registry
  registry.maxAgentId = newMaxId;
  registry.lastScan = Date.now();

  // Recalc stats
  const agents = Object.values(registry.agents) as AgentRecord[];
  registry.stats = {
    total: agents.length,
    active: agents.filter((a: AgentRecord) => a.status === "active").length,
    legit: agents.filter((a: AgentRecord) => a.status === "legit").length,
    inactive: agents.filter((a: AgentRecord) => a.status === "inactive").length,
    spam: agents.filter((a: AgentRecord) => a.status === "spam").length,
    dead: agents.filter((a: AgentRecord) => a.status === "dead").length,
    withA2A: agents.filter((a: AgentRecord) => a.a2aEndpoint).length,
    withAgentCard: agents.filter((a: AgentRecord) => a.hasAgentCard).length,
    a2aReachable: agents.filter((a: AgentRecord) => a.a2aReachable).length,
    a2aResponds: agents.filter((a: AgentRecord) => a.a2aResponds).length,
  };

  writeFileSync(DATA_FILE, JSON.stringify(registry, null, 2));
  log(`Saved to ${DATA_FILE}`);

  // Summary
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   PUSHER REPORT                                       ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║   Previous max ID:  ${String(oldMaxId).padEnd(34)}║`);
  console.log(`║   Current max ID:   ${String(newMaxId).padEnd(34)}║`);
  console.log(`║   New agents found: ${String(newAgents.length).padEnd(34)}║`);
  console.log(`║   With A2A:         ${String(newAgents.filter(a => a.a2aEndpoint).length).padEnd(34)}║`);
  console.log(`║   A2A responds:     ${String(newAgents.filter(a => a.a2aResponds).length).padEnd(34)}║`);
  console.log(`║   Total BSC:        ${String(registry.stats.total).padEnd(34)}║`);
  console.log(`║   External agents:  ${String(extAgents.length).padEnd(34)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝");

  // Print A2A failure insights from brain
  const deadNow = brain.getDeadAgents();
  if (deadNow.length > 0) {
    log(`\n💀 Brain: ${deadNow.length} agents permanently dead:`);
    deadNow.slice(0, 10).forEach(d => log(`   - #${d.id} "${d.name}": ${d.reason}`));
  }
  log(`\n${brain.getA2AInsights()}`);

  brain.save();
  process.exit(0);
}

main().catch(e => {
  console.error("❌ Error:", e);
  process.exit(1);
});
