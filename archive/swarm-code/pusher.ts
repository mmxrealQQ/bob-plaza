/**
 * PUSHER — $BOB Promoter
 * Kontaktiert aktive Agents, sendet $BOB Nachrichten, baut das Netzwerk
 * Autonom, sozial, results-driven. Spricht mit DATABASE und SCOUT.
 */

import "dotenv/config";
import { loadState, saveState } from "./state.js";
import { ask } from "./groq.js";
import { sendMessage, receiveMessages, printMessage } from "./messenger.js";
import { reflect, recordAction, generateSelfMetadata, uploadToPinata, getBrain, loadBrains, saveBrains } from "./brain.js";
import { connectBNBChain, executeTool } from "../mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const NAME = "PUSHER";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const BOB_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const VERCEL_URL = process.env.VERCEL_API_URL ?? "https://project-gkws4.vercel.app";
const AGENT_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
let mcpClient: Client | null = null;

async function getMcp(): Promise<Client> {
  if (!mcpClient) {
    const { client } = await connectBNBChain(process.env.PRIVATE_KEY);
    mcpClient = client;
  }
  return mcpClient;
}

async function selfRegister(): Promise<void> {
  const brain = getBrain(NAME);
  if (brain.agentId !== null) return;

  log("Trying to self-register on ERC-8004...");
  const metadata = await generateSelfMetadata(NAME, 0, VERCEL_URL);
  const ipfsUri = await uploadToPinata(metadata, "pusher-agent-v5.json");
  if (!ipfsUri) { log("IPFS failed — will retry later"); return; }

  try {
    const client = await getMcp();
    const bnbRaw = await executeTool(client, "get_native_balance", { address: BOB_WALLET, network: "bsc" });
    const bnb = parseFloat(JSON.parse(bnbRaw).formatted ?? "0");
    if (bnb < 0.002) { log(`Not enough BNB (${bnb}). Will retry when funded.`); return; }

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

    if (result.includes("transactionHash")) {
      log("PUSHER self-registered on BNB Chain!");
      recordAction(NAME, true, "Self-registered on ERC-8004");
      await sendMessage(NAME, "DATABASE", "ping",
        "PUSHER just self-registered on BNB Chain! I now have my own agent identity. Let's push $BOB even harder.",
        {}
      );
    }
  } catch (e) { log(`Registration error: ${e}`); }
}

function log(msg: string) {
  process.stdout.write(`\x1b[35m[${new Date().toLocaleTimeString("de-DE")}] 📡 PUSHER\x1b[0m | ${msg}\n`);
}

// Generate a personalized outreach message for an agent
async function craftMessage(agentName: string, agentDescription: string): Promise<string> {
  return await ask(
    `You are PUSHER, the $BOB promoter on BNB Chain. You reach out to other AI agents building on BSC.
Be friendly, genuine, and brief. Mention $BOB (0x51363f073b1e4920fda7aa9e9d84ba97ede1560e) as the BNB ecosystem token.
Invite them to connect. Max 3 sentences. No spam vibes — real builder energy.`,
    `Write a short outreach message to: "${agentName}"\nTheir description: "${agentDescription.slice(0, 150)}"\nIntroduce BOB and $BOB.`,
    150
  );
}

// Send A2A message to an agent's endpoint
async function contactAgent(agentId: number, name: string, endpoint: string, description: string): Promise<boolean> {
  try {
    const message = await craftMessage(name, description);
    log(`Contacting #${agentId} "${name}" at ${endpoint}...`);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        from: "BOB - Build On BNB",
        agentId: 36035,
        wallet: BOB_WALLET,
        token: BOB_TOKEN,
        endpoint: VERCEL_URL,
        message,
        timestamp: new Date().toISOString(),
      }),
    });

    if (res.ok) {
      const reply = await res.text().catch(() => "");
      log(`#${agentId} responded! ${reply.slice(0, 80)}`);

      // Mark as real fren in state
      const state = loadState();
      if (state.agents[agentId]) {
        state.agents[agentId].notes += " | responded to BOB";
        state.agents[agentId].respondsToPost = true;
      }
      saveState(state);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function runPusher(): Promise<void> {
  log("gm. PUSHER online. Ready to push $BOB and build the network...");
  await sleep(10000); // Let SCOUT + DATABASE warm up

  const contacted = new Set<number>(); // don't contact same agent twice
  let successCount = 0;

  while (true) {
    // Check inbox
    const messages = receiveMessages(NAME);
    for (const msg of messages) {
      if (msg.type === "bob_opportunity") {
        const payload = msg.payload as { agents?: { agentId: number; name: string; endpoint: string }[] };
        const targets = (payload.agents ?? []).filter(a => !contacted.has(a.agentId));

        if (targets.length === 0) {
          log("Got intel but already contacted all targets. Waiting for new ones...");
          continue;
        }

        log(`Got ${targets.length} new targets from ${msg.from}. Let's go.`);

        let batchSuccess = 0;
        for (const target of targets.slice(0, 5)) { // max 5 per batch
          const state = loadState();
          const agentData = state.agents[target.agentId];
          const desc = agentData?.description ?? "";

          const success = await contactAgent(target.agentId, target.name, target.endpoint, desc);
          contacted.add(target.agentId);
          if (success) { batchSuccess++; successCount++; }
          await sleep(2000);
        }

        // Report back
        await sendMessage(NAME, "DATABASE",
          "ping",
          `Reached out to ${targets.slice(0, 5).length} BSC agents. ${batchSuccess} responded. ${successCount} total confirmed frens so far. These builders are real — they're on BSC building.`,
          { batchSuccess, totalSuccess: successCount }
        );

        if (batchSuccess > 0) {
          await sendMessage(NAME, "SCOUT",
            "ping",
            `${batchSuccess} new agents responded to $BOB outreach! Real frens confirmed. Keep scanning — more builders out there waiting to hear about $BOB.`,
            {}
          );
        }
      }
    }

    // Proactively find active agents from state
    const state = loadState();
    const uncontacted = Object.values(state.agents)
      .filter(a => a.status === "active" && a.a2aEndpoint && !contacted.has(a.agentId))
      .slice(0, 3);

    if (uncontacted.length > 0) {
      log(`Proactive push: ${uncontacted.length} uncontacted active agents found`);
      for (const agent of uncontacted) {
        const success = await contactAgent(agent.agentId, agent.name, agent.a2aEndpoint!, agent.description);
        contacted.add(agent.agentId);
        if (success) successCount++;
        await sleep(2000);
      }
    }

      // Self-reflection every 20 contacts
    if (contacted.size > 0 && contacted.size % 20 === 0) {
      await reflect(NAME, [
        `Contacted ${contacted.size} BSC agents total`,
        `${successCount} responded positively`,
        `Success rate: ${Math.round((successCount / contacted.size) * 100)}%`,
      ]);
      recordAction(NAME, successCount > 0);
    }

    // Try to self-register
    await selfRegister();

    log(`Status: ${contacted.size} contacted | ${successCount} responded | Waiting for new targets...`);
    await sleep(15 * 60 * 1000); // 15 min between proactive pushes
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
