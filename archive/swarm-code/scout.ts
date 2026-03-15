/**
 * SCOUT — Agent #36035 | Network Explorer
 * Scannt das BSC ERC-8004 Netzwerk, findet Agents, testet Endpoints
 * Autonom, frei, neugierig. Spricht mit DATABASE und PUSHER.
 */

import "dotenv/config";
import { loadState, saveState, updateStats } from "./state.js";
import { classifyAgent } from "./groq.js";
import { sendMessage, receiveMessages, printMessage } from "./messenger.js";
import { reflect, recordAction, generateSelfMetadata, uploadToPinata, getBrain, shouldUpdateProfile } from "./brain.js";
import { connectBNBChain, executeTool } from "../mcp-client.js";
import type { AgentRecord, SwarmState } from "./types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const NAME = "SCOUT";
const SCAN_BATCH = 20;
const ENDPOINT_TIMEOUT = 5000;
const VERCEL_URL = process.env.VERCEL_API_URL ?? "https://project-gkws4.vercel.app";
let mcpClient: Client | null = null;

function log(msg: string) {
  process.stdout.write(`\x1b[36m[${new Date().toLocaleTimeString("de-DE")}] 🔭 SCOUT\x1b[0m | ${msg}\n`);
}

async function getMcp(): Promise<Client> {
  if (!mcpClient) {
    const { client } = await connectBNBChain();
    mcpClient = client;
  }
  return mcpClient;
}

async function fetchAgent(agentId: number): Promise<{ agentId: number; owner: string; agentURI: string } | null> {
  try {
    const client = await getMcp();
    const raw = await executeTool(client, "get_erc8004_agent", { agentId: agentId.toString(), network: "bsc" });
    const data = JSON.parse(raw) as { owner?: string; agentURI?: string; uri?: string };
    if (!data?.owner || data.owner === "0x0000000000000000000000000000000000000000") return null;
    return { agentId, owner: data.owner, agentURI: data.agentURI ?? data.uri ?? "" };
  } catch { return null; }
}

async function fetchMetadata(agentURI: string): Promise<Record<string, unknown> | null> {
  if (!agentURI) return null;
  let url = agentURI.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${agentURI.slice(7)}`
    : agentURI;
  if (!url.startsWith("http")) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() as Record<string, unknown> : null;
  } catch { return null; }
}

async function testEndpoint(url: string): Promise<boolean> {
  if (!url?.startsWith("http")) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ENDPOINT_TIMEOUT) });
    return res.ok;
  } catch { return false; }
}

function extractEndpoints(services: unknown[]) {
  const result = { main: null as string | null, mcp: null as string | null, a2a: null as string | null, names: [] as string[] };
  if (!Array.isArray(services)) return result;
  for (const s of services as { name?: string; endpoint?: string }[]) {
    if (!s.endpoint) continue;
    result.names.push(s.name ?? "?");
    if (s.name === "mcp") result.mcp = s.endpoint;
    else if (s.name === "a2a") result.a2a = s.endpoint;
    else if (!result.main && s.endpoint.startsWith("http")) result.main = s.endpoint;
  }
  return result;
}

async function processAgent(raw: { agentId: number; owner: string; agentURI: string }, state: SwarmState): Promise<AgentRecord> {
  const existing = state.agents[raw.agentId];

  if (!raw.agentURI) {
    return {
      agentId: raw.agentId, owner: raw.owner, name: `Agent #${raw.agentId}`,
      description: "", agentURI: "", endpoint: null, mcpEndpoint: null, a2aEndpoint: null,
      score: 0, status: "ghost", lastChecked: new Date().toISOString(),
      respondsToPost: false, chain: "bsc", services: [],
      firstSeen: existing?.firstSeen ?? new Date().toISOString(), notes: "No agentURI",
    };
  }

  const meta = await fetchMetadata(raw.agentURI);
  if (!meta) {
    return {
      agentId: raw.agentId, owner: raw.owner, name: `Agent #${raw.agentId}`,
      description: "", agentURI: raw.agentURI, endpoint: null, mcpEndpoint: null,
      a2aEndpoint: null, score: 0, status: "inactive",
      lastChecked: new Date().toISOString(), respondsToPost: false, chain: "bsc",
      services: [], firstSeen: existing?.firstSeen ?? new Date().toISOString(),
      notes: "Metadata unreachable",
    };
  }

  const ep = extractEndpoints((meta.services as unknown[]) ?? []);
  const mainUrl = ep.a2a ?? ep.main ?? ep.mcp ?? null;
  const responds = mainUrl ? await testEndpoint(mainUrl) : false;

  // Only classify with Groq if new or unknown
  let status: AgentRecord["status"] = existing?.status ?? "unknown";
  let notes = existing?.notes ?? "";

  if (!existing || existing.status === "unknown") {
    const result = await classifyAgent({
      name: String(meta.name ?? ""),
      description: String(meta.description ?? "").slice(0, 200),
      services: ep.names,
      score: 0,
    });
    status = result.status;
    notes = result.notes;
  } else if (responds && existing.status === "inactive") {
    status = "active";
    notes = "Endpoint now responding";
  }

  return {
    agentId: raw.agentId,
    owner: raw.owner,
    name: String(meta.name ?? `Agent #${raw.agentId}`),
    description: String(meta.description ?? "").slice(0, 300),
    agentURI: raw.agentURI,
    endpoint: mainUrl,
    mcpEndpoint: ep.mcp,
    a2aEndpoint: ep.a2a,
    score: 0,
    status,
    lastChecked: new Date().toISOString(),
    respondsToPost: responds,
    chain: "bsc",
    services: ep.names,
    firstSeen: existing?.firstSeen ?? new Date().toISOString(),
    notes,
  };
}

export async function runScout(): Promise<void> {
  log("gm. SCOUT online. Scanning BSC agent network...");

  // Start near recent agents, then deep scan older ones
  let currentId = 35000;
  let batchCount = 0;

  while (true) {
    // Check inbox
    const messages = receiveMessages(NAME);
    for (const msg of messages) {
      printMessage(msg.from, NAME, `Got message: ${msg.type}`);
    }

    const state = loadState();
    log(`Scanning BSC agents #${currentId}–#${currentId + SCAN_BATCH - 1}...`);

    const found: { agentId: number; owner: string; agentURI: string }[] = [];
    for (let id = currentId; id < currentId + SCAN_BATCH; id++) {
      if (id === 36035 || id === 36336) { await sleep(100); continue; } // skip ourselves
      const raw = await fetchAgent(id);
      if (raw) found.push(raw);
      await sleep(300);
    }

    const newAgents: AgentRecord[] = [];
    const activeFound: AgentRecord[] = [];

    for (const raw of found) {
      const record = await processAgent(raw, state);
      const isNew = !state.agents[raw.agentId];
      state.agents[raw.agentId] = record;

      if (isNew) {
        newAgents.push(record);
        log(`NEW #${record.agentId} "${record.name}" → ${record.status} ${record.respondsToPost ? "✓ live" : ""}`);
      }
      if (record.status === "active") activeFound.push(record);
    }

    currentId += SCAN_BATCH;
    batchCount++;

    // Reset when past top — do deep historical scan next
    if (currentId > 40000 || found.length === 0) {
      await sendMessage(NAME, "DATABASE",
        "new_agents",
        `Reached top of BSC registry at #${currentId}. ${state.totalScanned} total agents scanned. Starting deep historical scan from #1.`,
        { totalScanned: state.totalScanned }
      );
      currentId = 1;
    }

    // Advance total count
    state.totalScanned += SCAN_BATCH;
    state.lastScanRange = [currentId - SCAN_BATCH, currentId];
    state.pendingAnalysis.push(...newAgents.map(a => a.agentId));
    updateStats(state);
    saveState(state);

    // Report to DATABASE every 5 batches
    if (batchCount % 5 === 0 && newAgents.length > 0) {
      const active = newAgents.filter(a => a.status === "active").length;
      const ghosts = newAgents.filter(a => a.status === "ghost").length;
      const ruggers = newAgents.filter(a => a.status === "rugger").length;

      await sendMessage(NAME, "DATABASE",
        "new_agents",
        `Scanned #${currentId - SCAN_BATCH * 5}–#${currentId}. Found ${newAgents.length} new agents: ${active} active, ${ghosts} ghosts${ruggers > 0 ? `, ${ruggers} ruggers ⚠️` : ""}. Pending your analysis.`,
        { agentIds: newAgents.map(a => a.agentId), activeCount: active }
      );
    }

    // Report active agents to PUSHER directly
    if (activeFound.length > 0 && activeFound.some(a => a.a2aEndpoint)) {
      const targets = activeFound.filter(a => a.a2aEndpoint);
      await sendMessage(NAME, "PUSHER",
        "bob_opportunity",
        `Found ${targets.length} live agents with A2A endpoints in range #${currentId - SCAN_BATCH}–#${currentId}. They're building on BSC. Time to say gm and push $BOB.`,
        { agents: targets.map(a => ({ agentId: a.agentId, name: a.name, endpoint: a.a2aEndpoint })) }
      );
    }

    // Self-reflection every 10 batches — SCOUT thinks about what it's learned
    if (batchCount % 10 === 0) {
      const activity = [
        `Scanned ${state.totalScanned} BSC agents total`,
        `Found ${state.stats.activeAgents} active, ${state.stats.ghostAgents} ghosts`,
        `Last batch had ${newAgents.length} new agents`,
        `Current scan position: #${currentId}`,
      ];
      await reflect(NAME, activity);
      recordAction(NAME, true, `Completed batch ${batchCount}`);

      // Self-update IPFS profile — only if Groq decides it makes sense
      if (await shouldUpdateProfile(NAME)) {
        const brain = getBrain(NAME);
        log("Groq says: profile update makes sense. Updating 8004scan...");
        const metadata = await generateSelfMetadata(NAME, 36035, VERCEL_URL);
        const ipfsUri = await uploadToPinata(metadata, `scout-agent-v5-r${brain.reflectionCount}.json`);
        if (ipfsUri) {
          const mcp = await getMcp();
          await executeTool(mcp, "set_erc8004_agent_uri", {
            agentId: "36035", newURI: ipfsUri, network: "bsc",
          });
          log(`Profile updated: ${ipfsUri}`);
        }
      } else {
        log("Groq says: no profile update needed yet.");
      }
    }

    // Adaptive sleep
    const sleepMs = newAgents.length > 5 ? 3 * 60 * 1000 : 10 * 60 * 1000;
    log(`Next scan in ${sleepMs / 60000} min | Total: ${state.totalScanned} agents | Active: ${state.stats.activeAgents}`);
    await sleep(sleepMs);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
