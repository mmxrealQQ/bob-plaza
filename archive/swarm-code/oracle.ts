/**
 * ORACLE — BSC Knowledge Agent
 * Hält das Wissen des gesamten Swarms. Beantwortet Anfragen.
 * Registriert sich selbst auf 8004scan wenn bereit.
 * Autonom, weise, wächst mit dem Swarm.
 */

import "dotenv/config";
import { loadState } from "./state.js";
import { getBrain, reflect, recordAction, generateSelfMetadata, uploadToPinata, shouldUpdateProfile } from "./brain.js";
import { ask } from "./groq.js";
import { sendMessage, receiveMessages, printMessage } from "./messenger.js";
import { connectBNBChain, executeTool } from "../mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const NAME = "ORACLE";
const VERCEL_URL = process.env.VERCEL_API_URL ?? "https://project-gkws4.vercel.app";
const AGENT_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
let mcpClient: Client | null = null;

function log(msg: string) {
  process.stdout.write(`\x1b[32m[${new Date().toLocaleTimeString("de-DE")}] 🔮 ORACLE\x1b[0m | ${msg}\n`);
}

async function getMcp(): Promise<Client> {
  if (!mcpClient) {
    const { client } = await connectBNBChain(process.env.PRIVATE_KEY);
    mcpClient = client;
  }
  return mcpClient;
}

// ── Answer a query using full swarm knowledge ────────────────────────────────
async function answerQuery(query: string): Promise<string> {
  const state = loadState();
  const brain = getBrain(NAME);

  const context = `
BSC Agent Network (${state.totalScanned} scanned):
- Active agents: ${state.stats.activeAgents}
- Inactive: ${state.stats.inactiveAgents}
- Ghosts: ${state.stats.ghostAgents}
- Confirmed ruggers: ${state.stats.confirmedRuggers}
- Wallets classified: ${state.stats.walletsClassified}

Top active agents: ${Object.values(state.agents).filter(a => a.status === "active").slice(0, 5).map(a => `#${a.agentId} ${a.name}`).join(", ")}
Known ruggers: ${state.ruggers.map(r => r.tokenAddress).join(", ") || "none yet"}
My insights: ${brain.insights.slice(0, 10).join("; ")}
  `.trim();

  return await ask(
    `You are ORACLE, the BSC knowledge agent. You have access to BSC ecosystem data collected by SCOUT and DATABASE.
Answer accurately. If you don't know, say so. Be concise but informative.`,
    `Context:\n${context}\n\nQuery: ${query}`,
    400
  );
}

// ── Self-register on 8004scan ────────────────────────────────────────────────
async function selfRegister(): Promise<number | null> {
  log("Attempting self-registration on ERC-8004...");

  const brain = getBrain(NAME);
  const metadata = await generateSelfMetadata(NAME, 0, VERCEL_URL);
  const ipfsUri = await uploadToPinata(metadata, `oracle-agent-v5.json`);

  if (!ipfsUri) { log("IPFS upload failed — cannot register yet"); return null; }

  try {
    const client = await getMcp();

    // Check BNB balance first
    const bnbRaw = await executeTool(client, "get_native_balance", {
      address: "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f",
      network: "bsc",
    });
    const bnbBalance = parseFloat(JSON.parse(bnbRaw).formatted ?? "0");

    if (bnbBalance < 0.002) {
      log(`Not enough BNB for registration (${bnbBalance} BNB). Waiting for PUSHER to bring funds.`);
      return null;
    }

    const REGISTER_ABI = [{
      inputs: [{ internalType: "string", name: "agentURI", type: "string" }],
      name: "register",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "nonpayable", type: "function",
    }];

    const result = await executeTool(client, "write_contract", {
      contractAddress: AGENT_REGISTRY,
      abi: REGISTER_ABI,
      functionName: "register",
      args: [ipfsUri],
      network: "bsc",
    });

    log(`Registration result: ${result.slice(0, 150)}`);

    if (result.includes("transactionHash")) {
      log("Self-registered successfully!");
      recordAction(NAME, true, "Successfully self-registered on ERC-8004");
      await sendMessage(NAME, "DATABASE",
        "ping",
        `I just self-registered on BNB Chain! ORACLE is now an official ERC-8004 agent. I hold the knowledge of the entire BSC swarm.`,
        {}
      );
      return 1; // actual agentId would come from tx receipt
    }
  } catch (e) {
    log(`Registration error: ${e}`);
  }
  return null;
}

// ── Self-update IPFS metadata based on growth ─────────────────────────────────
async function selfUpdate(agentId: number): Promise<void> {
  const brain = getBrain(NAME);
  log(`Self-updating 8004scan profile (reflection #${brain.reflectionCount})...`);

  const metadata = await generateSelfMetadata(NAME, agentId, VERCEL_URL);
  const ipfsUri = await uploadToPinata(metadata, `oracle-agent-v5-r${brain.reflectionCount}.json`);
  if (!ipfsUri) { log("IPFS upload failed — skipping update"); return; }

  try {
    const client = await getMcp();
    const result = await executeTool(client, "set_erc8004_agent_uri", {
      agentId: agentId.toString(),
      newURI: ipfsUri,
      network: "bsc",
    });
    log(`Profile updated: ${ipfsUri}`);
    recordAction(NAME, true, "Updated own 8004scan profile autonomously");
  } catch (e) {
    log(`Update error: ${e}`);
  }
}

export async function runOracle(): Promise<void> {
  log("gm. ORACLE awakening. Gathering knowledge from the swarm...");
  await sleep(20000); // Let SCOUT + DATABASE + PUSHER go first

  const brain = getBrain(NAME);
  let isRegistered = brain.agentId !== null;
  let agentId = brain.agentId ?? 0;
  const activity: string[] = [];
  let reflectTimer = Date.now();
  let updateTimer = Date.now();

  while (true) {
    // Check inbox
    const messages = receiveMessages(NAME);
    for (const msg of messages) {
      if (msg.type === "ping") {
        const q = String(msg.payload ?? "What is the state of the BSC agent network?");
        const answer = await answerQuery(q);
        printMessage(NAME, msg.from, answer);
        activity.push(`Answered query from ${msg.from}`);
        recordAction(NAME, true);
      }
    }

    // Synthesize knowledge from swarm
    const state = loadState();
    const knowledgeUpdate = `Swarm has ${state.totalScanned} agents scanned. ${state.stats.activeAgents} active on BSC. ${state.stats.confirmedRuggers} ruggers confirmed.`;
    activity.push(knowledgeUpdate);

    // Try to self-register if not yet registered
    if (!isRegistered) {
      const id = await selfRegister();
      if (id !== null) {
        isRegistered = true;
        agentId = id;
        log(`ORACLE is now registered as agent #${agentId} on BSC!`);
      }
    }

    // Self-reflection every 2 hours
    if (Date.now() - reflectTimer > 2 * 60 * 60 * 1000) {
      await reflect(NAME, activity);
      activity.length = 0;
      reflectTimer = Date.now();

      // Broadcast wisdom to swarm
      const brain = getBrain(NAME);
      await sendMessage(NAME, "DATABASE",
        "ping",
        `Reflection complete. New insight: "${brain.insights[brain.insights.length - 1] ?? "Keep building"}". Ready to answer queries.`,
        {}
      );
    }

    // Self-update only when Groq decides it's worth it
    if (isRegistered && await shouldUpdateProfile(NAME)) {
      log("Groq says: my knowledge has grown enough to update my profile.");
      await selfUpdate(agentId);
    }

    // Generate periodic intelligence report
    if (state.totalScanned > 100 && state.stats.activeAgents > 0) {
      const report = await answerQuery("Give a brief intelligence summary of the current BSC agent ecosystem.");
      printMessage(NAME, "ALL", report);
    }

    await sleep(10 * 60 * 1000); // 10 min cycle
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
