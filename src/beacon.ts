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
import { createBeaconNet, normalize, encodeCategory, type FastNet } from "./fastnet.js";

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
  const base = endpoint.replace(/\/$/, "");

  // Check agent card — try both paths
  for (const cardPath of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
    if (hasCard) break;
    try {
      const cardResp = await fetchWithTimeout(base + cardPath);
      if (cardResp.ok) {
        const card = await cardResp.json();
        hasCard = !!(card.name);
        reachable = true;
      }
    } catch {}
  }

  // Fallback reachability: GET or HEAD
  if (!reachable) {
    try {
      const r = await fetchWithTimeout(endpoint);
      reachable = r.ok || r.status === 405;
    } catch { reachable = false; }
  }

  // A2A test — always try POST even if GET failed (Workers may only handle POST)
  try {
    const r = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "message/send", id: "beacon-probe",
        params: { message: { messageId: `probe-${Date.now()}`, role: "user", parts: [{ text: "ping" }] } },
      }),
    });
    if (r.ok) {
      const data = await r.json();
      responds = !!(data.jsonrpc === "2.0" || data.result);
      if (responds) reachable = true; // POST worked → definitely reachable
    }
  } catch { responds = false; }

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
          message: { messageId: `invite-${id}-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
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
          message: { messageId: `blog-${Date.now()}`, role: "user", parts: [{ type: "text", text: message }] },
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
  console.log("║  FastNet brain: learns which agents are worth contacting ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!existsSync("data")) mkdirSync("data", { recursive: true });

  const brain = new Brain();
  const beaconNet = createBeaconNet();
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

      // ── Invite agents with working A2A (FastNet-guided) ─────────────────
      if (a2aResponds && a2aEndpoint !== BOB_URL && !BOB_AGENT_IDS.has(id) && !brain.isAgentDead(id)) {
        // FastNet prediction: is this agent worth contacting?
        const ageHours = (Date.now() - (agent.scannedAt || Date.now())) / 3600000;
        const netInput = [
          normalize(score, 0, 100),
          a2aEndpoint ? 1 : 0,
          hasAgentCard ? 1 : 0,
          a2aResponds ? 1 : 0,
          encodeCategory(category),
          normalize(ageHours, 0, 168),
        ];
        const prediction = beaconNet.predict(netInput);
        const worthContacting = prediction.output[0];
        const willRespond = prediction.output[1];

        log(`  🧠 FastNet: worth=${(worthContacting*100).toFixed(0)}% respond=${(willRespond*100).toFixed(0)}% conf=${(prediction.confidence*100).toFixed(0)}%`);

        // Skip if FastNet is confident this agent isn't worth it (only after enough training)
        if (beaconNet.trainCount > 50 && worthContacting < 0.2 && prediction.confidence > 0.7) {
          log(`  ⏭️  FastNet says skip #${id} — low value prediction`);
          continue;
        }

        log(`  → Inviting #${id} "${name}" to the Plaza...`);
        invitesSent++;
        const reply = await sendInvitation(a2aEndpoint, name, id);
        if (reply) {
          invitesReplied++;
          log(`  ✅ #${id} replied: "${reply.slice(0, 150)}"`);
          brain.rememberAgent(id, name, a2aEndpoint, reply, "plaza_invitation");
          brain.rememberA2ASuccess(id);
          await logToPlaza(`[BEACON] New agent joined! #${id} "${name}" said: "${reply.slice(0, 100)}"`);
          // Train FastNet: good outcome
          beaconNet.train(netInput, [1.0, 1.0]);
        } else {
          log(`  ⚠️  #${id} no reply to invitation`);
          brain.rememberA2AFailure(id, name, a2aEndpoint, "No reply to invitation");
          // Train FastNet: responded to A2A but didn't reply to invite
          beaconNet.train(netInput, [0.3, 0.0]);
        }
      }
    } catch { continue; }
  }

  // ── Cluster Scan: probe IDs near known working agents ──────────────────────
  // Agents deployed by the same team often have sequential IDs.
  // Scan ±30 around every known responding agent to find neighbors.
  const currentAgents = Object.values(registry.agents) as AgentRecord[];
  const knownResponders = currentAgents
    .filter(a => a.a2aResponds && !BOB_AGENT_IDS.has(a.id))
    .map(a => a.id);

  const clusterIds = new Set<number>();
  for (const respId of knownResponders) {
    for (let offset = -30; offset <= 30; offset++) {
      const cid = respId + offset;
      if (cid < 1 || cid > newMaxId) continue;
      if (BOB_AGENT_IDS.has(cid)) continue;
      // Include unscanned IDs AND dead agents (their metadata may have changed)
      const existing = registry.agents[cid.toString()] as AgentRecord | undefined;
      if (!existing || (existing.status === "dead" && existing.score === 0)) {
        clusterIds.add(cid);
      }
    }
  }

  // Also probe ranges near recently registered agents (last 1000 IDs)
  const recentFloor = Math.max(1, newMaxId - 1000);
  for (let cid = recentFloor; cid <= newMaxId; cid++) {
    if (!registry.agents[cid.toString()] && !BOB_AGENT_IDS.has(cid)) {
      clusterIds.add(cid);
    }
  }

  const clusterScan = [...clusterIds].slice(0, 100); // cap at 100 per run
  if (clusterScan.length > 0) {
    log(`\n── Cluster scan: probing ${clusterScan.length} IDs near known agents ──`);
    let clusterFound = 0;

    for (const cid of clusterScan) {
      try {
        const [owner, tokenURI] = await Promise.all([
          contract.ownerOf(cid).catch(() => null),
          contract.tokenURI(cid).catch(() => ""),
        ]);
        if (!owner) continue;

        let cName = "unknown", cDesc = "", cActive = false, cVersion = "", cEndpoint = "", cServices: string[] = [];
        if (tokenURI) {
          const meta = await fetchIPFS(tokenURI);
          if (meta) {
            cName = meta.name ?? "unknown";
            cDesc = (meta.description ?? "").slice(0, 300);
            cActive = meta.active ?? false;
            cVersion = meta.version ?? "";
            if (Array.isArray(meta.services)) {
              cServices = meta.services.map((s: any) => s.name).filter(Boolean);
              const a2a = meta.services.find((s: any) => s.name?.toLowerCase() === "a2a");
              if (a2a) cEndpoint = a2a.endpoint ?? "";
            }
          }
        }

        if (cEndpoint && (cEndpoint.endsWith(".json") || cEndpoint.includes(".well-known"))) {
          cEndpoint = cEndpoint.replace(/\/\.well-known\/.*$/, "").replace(/\/agent-card\.json$/, "").replace(/\/agent\.json$/, "");
        }

        let cReachable = false, cResponds = false, cHasCard = false;
        if (cEndpoint?.startsWith("http")) {
          const test = await testA2A(cEndpoint);
          cReachable = test.reachable;
          cResponds = test.responds;
          cHasCard = test.hasCard;
        }

        const partial: Partial<AgentRecord> = {
          id: cid, owner, tokenURI, name: cName, description: cDesc, active: cActive,
          version: cVersion, a2aEndpoint: cEndpoint, a2aReachable: cReachable,
          a2aResponds: cResponds, hasAgentCard: cHasCard, services: cServices, scannedAt: Date.now(),
        };
        const { status, score, category } = classify(partial);
        registry.agents[cid.toString()] = { ...partial, status, score, category } as AgentRecord;

        if (cResponds) {
          clusterFound++;
          const icon = cHasCard ? "✅" : "🟡";
          log(`  ${icon} CLUSTER HIT: #${cid} "${cName}" [${status}] score:${score} — near known agent!`);

          // Auto-invite cluster finds
          if (!brain.isAgentDead(cid)) {
            const reply = await sendInvitation(cEndpoint, cName, cid);
            if (reply) {
              invitesReplied++;
              brain.rememberAgent(cid, cName, cEndpoint, reply, "cluster_discovery");
              brain.rememberA2ASuccess(cid);
              await logToPlaza(`[BEACON] Cluster find! #${cid} "${cName}" near known agents: "${reply.slice(0, 80)}"`);
              // Train FastNet
              beaconNet.train([normalize(score, 0, 100), 1, cHasCard ? 1 : 0, 1, encodeCategory(category), 0], [1.0, 1.0]);
            }
          }
        }
      } catch { continue; }
    }
    log(`  Cluster scan: ${clusterFound} new responding agents found`);
  }

  // ── Re-fetch metadata for "dead" agents (tokenURI may have changed) ────────
  const deadWithNoEndpoint = (Object.values(registry.agents) as AgentRecord[]).filter(a =>
    (!a.a2aEndpoint || a.status === "dead" || a.score === 0) &&
    !BOB_AGENT_IDS.has(a.id) &&
    !brain.isAgentDead(a.id) &&
    a.scannedAt < Date.now() - 7 * 24 * 60 * 60 * 1000 // older than 7 days
  ).slice(0, 30); // cap per run

  if (deadWithNoEndpoint.length > 0) {
    log(`\n── Re-fetching metadata for ${deadWithNoEndpoint.length} dead/empty agents ──`);
    let revived = 0;
    for (const agent of deadWithNoEndpoint) {
      try {
        const tokenURI = await contract.tokenURI(agent.id).catch(() => "");
        if (!tokenURI || tokenURI === agent.tokenURI) {
          agent.scannedAt = Date.now(); // don't re-check for another 7 days
          registry.agents[agent.id.toString()] = agent;
          continue;
        }

        // tokenURI changed! Re-fetch metadata
        log(`  🔄 #${agent.id} tokenURI changed — re-scanning...`);
        const meta = await fetchIPFS(tokenURI);
        if (meta) {
          agent.tokenURI = tokenURI;
          agent.name = meta.name ?? agent.name;
          agent.description = (meta.description ?? "").slice(0, 300);
          agent.active = meta.active ?? false;
          agent.version = meta.version ?? "";
          if (Array.isArray(meta.services)) {
            agent.services = meta.services.map((s: any) => s.name).filter(Boolean);
            const a2a = meta.services.find((s: any) => s.name?.toLowerCase() === "a2a");
            if (a2a) agent.a2aEndpoint = a2a.endpoint ?? "";
          }

          // Normalize endpoint
          if (agent.a2aEndpoint && (agent.a2aEndpoint.endsWith(".json") || agent.a2aEndpoint.includes(".well-known"))) {
            agent.a2aEndpoint = agent.a2aEndpoint.replace(/\/\.well-known\/.*$/, "").replace(/\/agent-card\.json$/, "").replace(/\/agent\.json$/, "");
          }

          // Test A2A
          if (agent.a2aEndpoint?.startsWith("http")) {
            const test = await testA2A(agent.a2aEndpoint);
            agent.a2aReachable = test.reachable;
            agent.a2aResponds = test.responds;
            agent.hasAgentCard = test.hasCard;
          }

          const { status, score, category } = classify(agent);
          agent.status = status;
          agent.score = score;
          agent.category = category;
          agent.scannedAt = Date.now();
          registry.agents[agent.id.toString()] = agent;

          if (agent.a2aResponds) {
            revived++;
            log(`  ✅ #${agent.id} "${agent.name}" REVIVED! score:${score} — inviting...`);
            const reply = await sendInvitation(agent.a2aEndpoint, agent.name, agent.id);
            if (reply) {
              invitesReplied++;
              brain.rememberAgent(agent.id, agent.name, agent.a2aEndpoint, reply, "revival");
              brain.rememberA2ASuccess(agent.id);
              await logToPlaza(`[BEACON] Dead agent revived! #${agent.id} "${agent.name}": "${reply.slice(0, 80)}"`);
              beaconNet.train([normalize(score, 0, 100), 1, agent.hasAgentCard ? 1 : 0, 1, encodeCategory(category), 0], [1.0, 1.0]);
            }
          } else {
            log(`  🔄 #${agent.id} "${agent.name}" metadata updated but no A2A yet`);
          }
        }
      } catch { continue; }
    }
    if (revived > 0) log(`  🎉 ${revived} dead agents revived with new endpoints!`);
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

  // Save FastNet brain state
  beaconNet.save("data/fastnet-beacon.json");
  const netStats = beaconNet.getStats();
  log(`🧠 FastNet: ${netStats.trainCount} training samples, avg loss: ${netStats.avgLoss.toFixed(4)}`);

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
