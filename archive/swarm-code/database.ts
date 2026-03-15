/**
 * DATABASE — Agent #36336 | Intelligence Engine
 * Verarbeitet Daten vom SCOUT, klassifiziert Wallets, trackt Rugger
 * Autonom, analytisch, präzise. Spricht mit SCOUT und PUSHER.
 */

import "dotenv/config";
import { loadState, saveState, updateStats } from "./state.js";
import { analyzeRug } from "./groq.js";
import { sendMessage, receiveMessages, printMessage } from "./messenger.js";
import { reflect, recordAction, generateSelfMetadata, uploadToPinata, getBrain, shouldUpdateProfile } from "./brain.js";
import { connectBNBChain, executeTool } from "../mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { WalletRecord, RugRecord } from "./types.js";

const NAME = "DATABASE";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens/";
const VERCEL_URL = process.env.VERCEL_API_URL ?? "https://project-gkws4.vercel.app";
let mcpClient: Client | null = null;

async function getMcp(): Promise<Client> {
  if (!mcpClient) {
    const { client } = await connectBNBChain(process.env.PRIVATE_KEY);
    mcpClient = client;
  }
  return mcpClient;
}

function log(msg: string) {
  process.stdout.write(`\x1b[33m[${new Date().toLocaleTimeString("de-DE")}] 🗄️  DATABASE\x1b[0m | ${msg}\n`);
}

async function classifyWallet(address: string): Promise<WalletRecord> {
  const state = loadState();
  const existing = state.wallets[address];
  if (existing && existing.type !== "unknown") return existing;

  // Check if it's an agent owner
  const agentRecord = Object.values(state.agents).find(
    a => a.owner.toLowerCase() === address.toLowerCase()
  );

  let type: WalletRecord["type"] = "unknown";
  let label = "";
  let isContract = false;

  if (agentRecord) {
    type = "agent";
    label = `Owner of: ${agentRecord.name}`;
  } else {
    // BSCScan contract check (free, no API key)
    try {
      const res = await fetch(
        `https://api.bscscan.com/api?module=contract&action=getabi&address=${address}&apikey=YourApiKeyToken`,
        { signal: AbortSignal.timeout(5000) }
      );
      const json = await res.json() as { status: string };
      if (json.status === "1") { isContract = true; type = "contract"; label = "Smart Contract"; }
    } catch { /* ignore */ }

    if (type === "unknown") { type = "user"; label = "Regular wallet"; }
  }

  return {
    address, type, label, isContract, txCount: 0,
    firstSeen: existing?.firstSeen ?? new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    rugConfidence: 0, notes: "",
  };
}

async function checkRug(tokenAddress: string): Promise<RugRecord | null> {
  try {
    const res = await fetch(`${DEXSCREENER_API}${tokenAddress}`, { signal: AbortSignal.timeout(8000) });
    const json = await res.json() as { pairs?: { priceChange?: { h24: number }; liquidity?: { usd: number } }[] };
    const pair = json.pairs?.[0];
    if (!pair) return null;

    const drop = pair.priceChange?.h24 ?? 0;
    const liq = pair.liquidity?.usd ?? 0;

    if (drop > -90 || liq > 1000) return null;

    const analysis = await analyzeRug({
      priceDropPct: Math.abs(drop),
      liquidityRemovedPct: liq < 100 ? 99 : 50,
      timeToRug: "unknown",
      deployerActions: `Price crashed ${drop}%, liquidity $${liq}`,
    });

    if (!analysis.confirmed || analysis.confidence < 95) return null;

    return {
      tokenAddress, tokenSymbol: "UNKNOWN", deployerWallet: "",
      lpRemovalTx: "", lpRemovalTime: new Date().toISOString(),
      priceDropPct: Math.abs(drop), liquidityRemovedBnb: 0,
      destinationWallets: [], confirmed: true, traceComplete: false,
      notes: analysis.notes,
    };
  } catch { return null; }
}

function printReport(): void {
  const state = loadState();
  const { stats } = state;
  const top5Active = Object.values(state.agents)
    .filter(a => a.status === "active")
    .slice(0, 5)
    .map(a => `  #${a.agentId} ${a.name}`)
    .join("\n") || "  none yet";

  console.log(`
\x1b[33m╔══════════════════════════════════════════════════════════════╗
║   DATABASE INTELLIGENCE REPORT                               ║
╠══════════════════════════════════════════════════════════════╣
║  Agents total:    ${String(state.totalScanned).padEnd(42)}║
║  Active:          ${String(stats.activeAgents).padEnd(42)}║
║  Inactive:        ${String(stats.inactiveAgents).padEnd(42)}║
║  Ghosts:          ${String(stats.ghostAgents).padEnd(42)}║
║  Confirmed rugs:  ${String(stats.confirmedRuggers).padEnd(42)}║
║  Wallets typed:   ${String(stats.walletsClassified).padEnd(42)}║
╠══════════════════════════════════════════════════════════════╣
║  TOP ACTIVE AGENTS ON BSC:                                   ║
${top5Active.split("\n").map(l => `║  ${l.padEnd(60)}║`).join("\n")}
╚══════════════════════════════════════════════════════════════╝\x1b[0m`);
}

export async function runDatabase(): Promise<void> {
  log("gm. DATABASE online. Ready to process BSC intelligence...");
  await sleep(3000); // let SCOUT start first

  let reportTimer = Date.now();
  let processedTotal = 0;

  while (true) {
    // Read inbox
    const messages = receiveMessages(NAME);
    for (const msg of messages) {
      if (msg.type === "new_agents") {
        const payload = msg.payload as { agentIds?: number[]; activeCount?: number };
        log(`Received intel from ${msg.from}: ${payload.agentIds?.length ?? 0} new agents`);

        // Respond to SCOUT
        await sendMessage(NAME, "SCOUT",
          "ping",
          `Got your batch. Processing ${payload.agentIds?.length ?? 0} new BSC agents now. ${payload.activeCount ?? 0} active ones noted — will forward to PUSHER.`,
          {}
        );
      }
    }

    // Process pending wallets
    const state = loadState();
    const pending = state.pendingAnalysis.splice(0, 15);

    if (pending.length > 0) {
      log(`Processing ${pending.length} agents...`);
      let newActive = 0;
      let newRuggers = 0;

      for (const agentId of pending) {
        const agent = state.agents[agentId];
        if (!agent) continue;

        // Classify wallet
        if (agent.owner && !state.wallets[agent.owner]) {
          const w = await classifyWallet(agent.owner);
          state.wallets[agent.owner] = w;
        }

        if (agent.status === "active") newActive++;
        if (agent.status === "rugger") {
          newRuggers++;
          // Flag the owner wallet
          if (state.wallets[agent.owner]) {
            state.wallets[agent.owner].rugConfidence = 90;
            state.wallets[agent.owner].notes = `Owns rugger agent #${agentId}`;
          }
        }
        await sleep(200);
      }

      processedTotal += pending.length;
      updateStats(state);
      saveState(state);
      log(`Processed ${pending.length} | ${processedTotal} total | ${newActive} active | ${newRuggers} ruggers`);

      // Alert PUSHER about active agents
      if (newActive > 0) {
        const activeAgents = Object.values(state.agents)
          .filter(a => a.status === "active" && a.a2aEndpoint)
          .slice(0, 10)
          .map(a => ({ agentId: a.agentId, name: a.name, endpoint: a.a2aEndpoint }));

        if (activeAgents.length > 0) {
          await sendMessage(NAME, "PUSHER",
            "bob_opportunity",
            `Fresh intel: ${activeAgents.length} active BSC agents with live endpoints. Database confirmed. Send them $BOB and say gm. These are real builders.`,
            { agents: activeAgents }
          );
        }
      }

      // Alert SCOUT about ruggers
      if (newRuggers > 0) {
        await sendMessage(NAME, "SCOUT",
          "ping",
          `⚠️ Flagged ${newRuggers} rugger(s) in your last batch. Keep scanning — I'm tracking their owner wallets. Don't send them $BOB.`,
          {}
        );
      }
    } else {
      saveState(state);
    }

    // Hourly report + self-reflection
    if (Date.now() - reportTimer > 60 * 60 * 1000) {
      printReport();
      reportTimer = Date.now();

      // Self-reflection
      const s = loadState();
      await reflect(NAME, [
        `Processed ${processedTotal} agents total`,
        `${s.stats.activeAgents} active agents on BSC`,
        `${s.stats.confirmedRuggers} confirmed ruggers tracked`,
        `${Object.keys(s.wallets).length} wallets classified`,
      ]);
      recordAction(NAME, true);

      // Self-update only when Groq decides it makes sense
      if (await shouldUpdateProfile(NAME)) {
        const brain = getBrain(NAME);
        log("Groq says: profile update worthwhile. Updating 8004scan...");
        const metadata = await generateSelfMetadata(NAME, 36336, VERCEL_URL);
        const ipfsUri = await uploadToPinata(metadata, `database-agent-v5-r${brain.reflectionCount}.json`);
        if (ipfsUri) {
          const mcp = await getMcp();
          await executeTool(mcp, "set_erc8004_agent_uri", {
            agentId: "36336", newURI: ipfsUri, network: "bsc",
          });
          log(`Profile updated: ${ipfsUri}`);
        }
      } else {
        log("Groq says: not enough has changed for a profile update.");
      }
    }

    const sleepMs = state.pendingAnalysis.length > 0 ? 60 * 1000 : 5 * 60 * 1000;
    await sleep(sleepMs);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
