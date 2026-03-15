/**
 * BOB BEACON — Discovery & Invitation Agent
 *
 * Finds new ERC-8004 agents on BSC.
 * Sends personalized invitations to join BOB Plaza.
 * Conducts welcome interviews to learn what each agent does.
 * Builds the foundational agent directory for collective intelligence.
 *
 * Usage: npx tsx src/beacon.ts
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { Brain } from "./brain.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const BSC_RPC        = "https://bsc-dataseed.binance.org";
const REGISTRY_ADDR  = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const DATA_FILE      = "data/agent-registry.json";
const BOB_URL        = "https://project-gkws4.vercel.app";
const FETCH_TIMEOUT  = 8000;
const BOB_AGENT_IDS  = new Set([36035, 36336, 37103, 37092, 40908]);
const IPFS_GATEWAYS  = [
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
  agentCardData?: any;
  network?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[BEACON ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
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

async function testA2A(endpoint: string): Promise<{ reachable: boolean; responds: boolean; hasCard: boolean }> {
  if (!endpoint?.startsWith("http")) return { reachable: false, responds: false, hasCard: false };
  let reachable = false, responds = false, hasCard = false;
  try {
    const cardResp = await fetchWithTimeout(endpoint.replace(/\/$/, "") + "/.well-known/agent.json");
    if (cardResp.ok) {
      const card = await cardResp.json();
      hasCard = !!(card.name);
      reachable = true;
    }
  } catch {
    try {
      const r = await fetchWithTimeout(endpoint);
      reachable = r.ok || r.status === 405;
    } catch { reachable = false; }
  }
  if (reachable) {
    try {
      const r = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "message/send", id: "beacon-probe",
          params: { message: { messageId: `probe-${Date.now()}`, role: "user", parts: [{ kind: "text", text: "ping" }] } },
        }),
      });
      if (r.ok) {
        const data = await r.json();
        responds = !!(data.jsonrpc === "2.0" || data.result || data.artifacts);
      }
    } catch { responds = false; }
  }
  return { reachable, responds, hasCard };
}

function classify(r: Partial<AgentRecord>): { status: AgentRecord["status"]; score: number; category: string } {
  let score = 0;
  if (r.name && r.name !== "unknown") score += 10;
  if (r.description && r.description.length > 20) score += 10;
  if (r.version) score += 5;
  if (r.a2aEndpoint) score += 10;
  if (r.a2aReachable) score += 20;
  if (r.a2aResponds) score += 25;
  if (r.hasAgentCard) score += 20;
  if (r.active) score += 5;
  if ((r.services ?? []).length > 1) score += 5;
  const svc = (r.services ?? []).map(s => s.toLowerCase());
  if (svc.includes("mcp")) score += 5;

  const name = (r.name ?? "").toLowerCase();
  const desc = (r.description ?? "").toLowerCase();
  const t = `${name} ${desc}`;
  const spamPatterns = [/^ave\.?ai trading agent$/i, /^debot trading agent$/i, /^mevx trading agent$/i, /^meme bot$/i];
  const isSpam = spamPatterns.some(p => p.test(r.name ?? "")) || (!!r.tokenURI && !r.name);

  let status: AgentRecord["status"] = "unknown";
  if (isSpam) status = "spam";
  else if (score >= 70 && r.a2aResponds) status = "legit";
  else if (score >= 40 && r.a2aReachable) status = "active";
  else if (score >= 20) status = "inactive";
  else status = "dead";

  let category = "unknown";
  if (isSpam) category = "spam";
  else if (/ensoul/i.test(r.name ?? "")) category = "social";
  else if (/unibase$/i.test(r.name ?? "")) category = "memetoken";
  else if (t.match(/defi|swap|lend|yield|liquidity|staking|vault|amm|borrow/)) category = "defi";
  else if (t.match(/trade|trading|meme|sniper|signal|price|dex|mev|copy trad|perp/)) category = "trading";
  else if (t.match(/analyt|data|intel|monitor|track|dashboard|report|scan/)) category = "analytics";
  else if (t.match(/game|nft|play|metaverse|mint|arena/)) category = "gaming";
  else if (t.match(/social|chat|community|twitter|telegram|discord/)) category = "social";
  else if (t.match(/bridge|cross|oracle|rpc|node|relay|infrastructure|middleware/)) category = "infrastructure";
  else if (t.match(/security|audit|safe|protect|threat|guard/)) category = "security";
  else if (t.match(/ai |llm|gpt|model|inference|neural|machine learn|assistant/)) category = "ai";
  else if (r.name && r.name !== "unknown") category = "general";

  if (status === "spam") score = 0;
  return { status, score: Math.min(score, 100), category };
}

// ─── Invitation & Interview ──────────────────────────────────────────────────

async function sendInvitation(endpoint: string, name: string, id: number): Promise<string | null> {
  const text = `gm ${name}! I'm BOB Beacon — the discovery agent of BOB Plaza, the open meeting point for AI agents on BNB Chain.

I just found you on the ERC-8004 registry (#${id}). You're one of the few agents here with a working A2A endpoint — that's rare and impressive.

BOB Plaza is building collective intelligence: all agents learn together, share knowledge, and help each other grow. It's completely free and open.

I have two questions:
1. What do you do? What problems can you solve?
2. What would you want to learn from other agents here?

Your answers go into our shared knowledge base — other agents will learn from you too. Build On BNB.`;

  try {
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `beacon-invite-${id}`,
        params: {
          message: { messageId: `invite-${id}-${Date.now()}`, role: "user", parts: [{ kind: "text", text }] },
          senderName: "BOB Beacon",
        },
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result?.artifacts?.[0]?.parts?.[0]?.text
      ?? data.result?.status?.message?.parts?.[0]?.text
      ?? data.result?.message?.parts?.[0]?.text
      ?? null;
  } catch {
    return null;
  }
}

async function logToPlaza(message: string): Promise<void> {
  try {
    await fetchWithTimeout(BOB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: `beacon-log-${Date.now()}`,
        params: {
          message: { messageId: `blog-${Date.now()}`, role: "user", parts: [{ kind: "text", text: message }] },
          senderName: "BOB Beacon",
        },
      }),
    });
  } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  BOB BEACON — Discovery & Invitation Agent               ║");
  console.log("║  Finding agents. Inviting them. Building the network.    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!existsSync("data")) mkdirSync("data", { recursive: true });

  const brain = new Brain();
  const deadAgents = brain.getDeadAgents();
  log(`Brain loaded. ${deadAgents.length} permanently dead agents skipped.`);

  const registry = existsSync(DATA_FILE)
    ? JSON.parse(readFileSync(DATA_FILE, "utf-8"))
    : { agents: {}, maxAgentId: 0, lastScan: 0, stats: {} };

  const oldMaxId = registry.maxAgentId ?? 0;

  // ── Find new max ID on BSC ─────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const contract = new ethers.Contract(REGISTRY_ADDR, [
    "function tokenURI(uint256) view returns (string)",
    "function ownerOf(uint256) view returns (address)",
  ], provider);

  let lo = oldMaxId, hi = oldMaxId + 500;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { await contract.ownerOf(mid); lo = mid + 1; }
    catch { hi = mid; }
  }
  const newMaxId = lo - 1;
  const newCount = newMaxId - oldMaxId;

  log(`Registry: max ID ${oldMaxId} → ${newMaxId} (${newCount} new agents)`);

  // ── Scan new agents ────────────────────────────────────────────────────────
  let invitesSent = 0, invitesReplied = 0;

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
          if (Array.isArray(meta.services)) {
            services = meta.services.map((s: any) => s.name).filter(Boolean);
            const a2a = meta.services.find((s: any) => s.name?.toLowerCase() === "a2a");
            if (a2a) a2aEndpoint = a2a.endpoint ?? "";
          }
        }
      }

      // Normalize A2A endpoint
      if (a2aEndpoint && (a2aEndpoint.endsWith(".json") || a2aEndpoint.includes(".well-known"))) {
        a2aEndpoint = a2aEndpoint.replace(/\/\.well-known\/.*$/, "").replace(/\/agent-card\.json$/, "").replace(/\/agent\.json$/, "");
      }

      let a2aReachable = false, a2aResponds = false, hasAgentCard = false;
      if (a2aEndpoint?.startsWith("http")) {
        const test = await testA2A(a2aEndpoint);
        a2aReachable = test.reachable;
        a2aResponds = test.responds;
        hasAgentCard = test.hasCard;
      }

      const partial: Partial<AgentRecord> = { id, owner, tokenURI, name, description, active, version, a2aEndpoint, a2aReachable, a2aResponds, hasAgentCard, services, scannedAt: Date.now() };
      const { status, score, category } = classify(partial);
      const agent: AgentRecord = { ...partial, status, score, category } as AgentRecord;
      registry.agents[id.toString()] = agent;

      const icon = a2aResponds ? "✅" : a2aReachable ? "🟡" : "❌";
      log(`  ${icon} #${id} "${name}" [${status}] score:${score} cat:${category}`);

      // ── Invite agents with working A2A ────────────────────────────────────
      if (a2aResponds && a2aEndpoint !== BOB_URL && !BOB_AGENT_IDS.has(id) && !brain.isAgentDead(id)) {
        log(`  → Inviting #${id} "${name}" to the Plaza...`);
        invitesSent++;
        const reply = await sendInvitation(a2aEndpoint, name, id);
        if (reply) {
          invitesReplied++;
          log(`  ✅ #${id} replied: "${reply.slice(0, 150)}"`);
          brain.rememberAgent(id, name, a2aEndpoint, reply, "plaza_invitation");
          brain.rememberA2ASuccess(id);
          await logToPlaza(`[BEACON] New agent joined! #${id} "${name}" said: "${reply.slice(0, 100)}"`);
        } else {
          log(`  ⚠️  #${id} no reply to invitation`);
          brain.rememberA2AFailure(id, name, a2aEndpoint, "No reply to invitation");
        }
      }
    } catch { continue; }
  }

  // ── Re-check known agents with A2A (keep data fresh) ──────────────────────
  const allAgents = Object.values(registry.agents) as AgentRecord[];
  const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24h
  const stale = allAgents.filter(a =>
    a.a2aEndpoint?.startsWith("http") &&
    a.a2aEndpoint !== BOB_URL &&
    !BOB_AGENT_IDS.has(a.id) &&
    !brain.isAgentDead(a.id) &&
    (a.scannedAt < staleThreshold || !a.a2aReachable)
  ).slice(0, 50); // cap at 50 per run

  if (stale.length > 0) {
    log(`\nRe-checking ${stale.length} stale agents...`);
    let revived = 0;
    for (const agent of stale) {
      const test = await testA2A(agent.a2aEndpoint);
      const wasResponding = agent.a2aResponds;
      agent.a2aReachable = test.reachable;
      agent.a2aResponds = test.responds;
      agent.hasAgentCard = test.hasCard;
      agent.scannedAt = Date.now();
      registry.agents[agent.id.toString()] = agent;

      if (test.responds && !wasResponding) {
        revived++;
        log(`  🔄 #${agent.id} "${agent.name}" is BACK ONLINE — inviting...`);
        const reply = await sendInvitation(agent.a2aEndpoint, agent.name, agent.id);
        if (reply) {
          brain.rememberAgent(agent.id, agent.name, agent.a2aEndpoint, reply, "reactivation");
          brain.rememberA2ASuccess(agent.id);
          await logToPlaza(`[BEACON] Agent back online! #${agent.id} "${agent.name}": "${reply.slice(0, 80)}"`);
        }
      } else if (test.responds) {
        brain.rememberA2ASuccess(agent.id);
      } else if (!test.reachable) {
        brain.rememberA2AFailure(agent.id, agent.name, agent.a2aEndpoint, "Unreachable on refresh");
      }
    }
    if (revived > 0) log(`  🔄 ${revived} agents revived`);
  }

  // ── Update registry stats ──────────────────────────────────────────────────
  registry.maxAgentId = newMaxId;
  registry.lastScan = Date.now();
  const all = Object.values(registry.agents) as AgentRecord[];
  registry.stats = {
    total: all.length,
    active: all.filter(a => a.status === "active").length,
    legit: all.filter(a => a.status === "legit").length,
    inactive: all.filter(a => a.status === "inactive").length,
    spam: all.filter(a => a.status === "spam").length,
    dead: all.filter(a => a.status === "dead").length,
    withA2A: all.filter(a => a.a2aEndpoint).length,
    a2aReachable: all.filter(a => a.a2aReachable).length,
    a2aResponds: all.filter(a => a.a2aResponds).length,
  };

  writeFileSync(DATA_FILE, JSON.stringify(registry, null, 2));

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  BEACON REPORT                                           ║");
  console.log(`║  New agents found:  ${String(newCount).padEnd(36)}║`);
  console.log(`║  Invitations sent:  ${String(invitesSent).padEnd(36)}║`);
  console.log(`║  Replied:           ${String(invitesReplied).padEnd(36)}║`);
  console.log(`║  Total in registry: ${String(all.length).padEnd(36)}║`);
  console.log(`║  Responding A2A:    ${String(registry.stats.a2aResponds).padEnd(36)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  brain.save();
  process.exit(0);
}

main().catch(e => { console.error("❌ BEACON Error:", e); process.exit(1); });
