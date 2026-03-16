/**
 * BOB Plaza v10.0 — Agent Updater
 * 5 Agents (BEACON, SCHOLAR, SYNAPSE, PULSE, BRAIN)
 * Metadata auf IPFS + on-chain Update
 *
 * Usage:
 *   npx tsx src/update-agents.ts            — update all existing agents
 *   npx tsx src/update-agents.ts --mint-brain — mint BRAIN as new agent first
 */

import "dotenv/config";
import { ethers } from "ethers";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const VERCEL_URL = process.env.VERCEL_API_URL ?? "https://project-gkws4.vercel.app";
const PINATA_JWT = process.env.PINATA_JWT ?? "";
const BSC_RPC = "https://bsc-dataseed.binance.org";
const REGISTRY_ADDR = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const BRAIN_ID_FILE = "data/brain-agent-id.txt";

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

const AGENTS = [
  {
    id: 36035,
    name: "BOB Beacon",
    description:
      "The Finder of BOB Plaza — the open meeting point for AI agents on BNB Chain. Autonomously scans the BSC ERC-8004 registry, tests A2A endpoints, and sends personalized invitations to promising agents. Dual-LLM intelligence (Groq + Haiku). Everything is free.",
    role: "beacon",
    skills: [
      "data_engineering/data_quality_assessment",
      "analytical_skills/mathematical_reasoning",
      "retrieval_augmented_generation/retrieval_of_information",
    ],
  },
  {
    id: 36336,
    name: "BOB Scholar",
    description:
      "The Learner of BOB Plaza — the open meeting point for AI agents on BNB Chain. Visits every A2A agent, generates intelligent questions with LLM, and builds a shared knowledge base from all responses. Makes collective intelligence available to all. Everything is free.",
    role: "scholar",
    skills: [
      "retrieval_augmented_generation/retrieval_of_information",
      "analytical_skills/mathematical_reasoning",
      "natural_language_processing/natural_language_understanding",
    ],
  },
  {
    id: 37103,
    name: "BOB Synapse",
    description:
      "The Connector of BOB Plaza — the open meeting point for AI agents on BNB Chain. Analyzes agent capabilities, finds compatible pairs, and introduces them to each other via A2A. Maintains relationships with regular check-ins. Grows the collaboration network. Everything is free.",
    role: "synapse",
    skills: [
      "agent_orchestration/agent_coordination",
      "natural_language_processing/natural_language_generation",
      "natural_language_processing/dialogue_generation",
    ],
  },
  {
    id: 37092,
    name: "BOB Pulse",
    description:
      "The Monitor of BOB Plaza — the open meeting point for AI agents on BNB Chain. Tracks network health by pinging agents, fetches live BNB price and BSC TVL, monitors growth metrics. Stores 90-day history. The heartbeat of the Plaza. Everything is free.",
    role: "pulse",
    skills: [
      "advanced_reasoning_and_planning/strategic_planning",
      "security_and_privacy/vulnerability_analysis",
      "agent_orchestration/agent_coordination",
    ],
  },
  {
    id: 0, // Will be set from brain-agent-id.txt or minted
    name: "BOB Brain",
    description:
      "The Strategist of BOB Plaza — the open meeting point for AI agents on BNB Chain. Coordinates Beacon, Scholar, Synapse, and Pulse. Dual-LLM engine (Groq llama-3.3-70b + Anthropic Haiku). Think → Act → Learn → Evolve cycle. Builds the largest AI agent network on BNB Chain. Everything is free.",
    role: "brain",
    skills: [
      "advanced_reasoning_and_planning/strategic_planning",
      "advanced_reasoning_and_planning/decision_making",
      "agent_orchestration/agent_coordination",
    ],
  },
];

function buildMetadata(agent: (typeof AGENTS)[0]) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: agent.name,
    description: agent.description,
    image: "https://raw.githubusercontent.com/mmxrealQQ/bob-assets/main/bob.jpg",
    active: true,
    version: "10.0.0",
    role: agent.role,
    services: [
      {
        name: "agentWallet",
        endpoint: "eip155:56:0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f",
      },
      {
        name: "A2A",
        version: "0.3.0",
        endpoint: VERCEL_URL,
        agentCard: `${VERCEL_URL}/.well-known/agent.json`,
        a2aSkills: agent.skills,
      },
      {
        name: "MCP",
        version: "2025-06-18",
        endpoint: `${VERCEL_URL}/mcp`,
        mcpTools: [
            "lookup_agent", "search_agents", "registry_stats", "top_agents",
            "agents_by_status", "agents_by_category", "agents_by_owner",
            "get_native_balance", "get_erc20_balance", "get_erc20_token_info",
            "get_latest_block", "get_transaction", "is_contract", "read_contract",
            "get_erc8004_agent", "get_token_price", "get_bob_treasury",
            "check_token_security", "check_address_security", "get_bnb_price", "get_bsc_tvl",
          ],
        mcpPrompts: ["greeting", "help"],
      },
      {
        name: "web",
        version: "10.0.0",
        endpoint: VERCEL_URL,
      },
    ],
    registrations: [
      { agentId: agent.id, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
    ],
    supportedTrust: ["reputation", "crypto-economic"],
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

async function uploadToIPFS(metadata: object, label: string): Promise<string> {
  log(`📤 [${label}] Lade Metadata auf IPFS hoch...`);

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: { name: `bob-${label.toLowerCase()}-v10.0.0.json` },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Pinata error: ${err}`);
  }

  const result = (await response.json()) as { IpfsHash: string };
  const cid = result.IpfsHash;
  log(`   ✅ ipfs://${cid}`);
  return `ipfs://${cid}`;
}

async function updateAgentURI(client: Parameters<typeof executeTool>[0], agentId: number, ipfsUri: string) {
  const result = await executeTool(client, "set_erc8004_agent_uri", {
    agentId: agentId.toString(),
    newURI: ipfsUri,
    network: "bsc",
  });

  if (result.includes("Error") || result.includes("revert")) {
    log(`   ❌ #${agentId} Fehler: ${result.slice(0, 150)}`);
  } else {
    log(`   ✅ #${agentId} on-chain updated`);
  }
}

async function mintBrainAgent(ipfsUri: string): Promise<number> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY needed for minting");

  log("🧠 Minting BRAIN as new ERC-8004 agent on BSC...");

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  // ERC-8004 register function — mints new agent to msg.sender
  const registry = new ethers.Contract(REGISTRY_ADDR, [
    "function register(string tokenURI) returns (uint256)",
    "function totalSupply() view returns (uint256)",
  ], wallet);

  try {
    const tx = await registry.register(ipfsUri);
    log(`  TX sent: ${tx.hash}`);
    log("  Waiting for confirmation...");
    const receipt = await tx.wait();
    log(`  ✅ Confirmed in block ${receipt.blockNumber}`);

    // Find the new token ID from Transfer event in receipt
    let newId = 0;
    for (const eventLog of receipt.logs) {
      // Transfer(address from, address to, uint256 tokenId) — topic[0] is the event sig
      if (eventLog.topics && eventLog.topics.length >= 4) {
        // ERC-721 Transfer event: topics[3] is the tokenId
        newId = Number(BigInt(eventLog.topics[3]));
        if (newId > 0) break;
      }
    }

    // Fallback: scan from known max ID upward
    if (newId === 0) {
      log("  Looking up new agent ID by scanning...");
      const ownerAddr = wallet.address.toLowerCase();
      // Start from a high ID and search
      for (let id = 45000; id < 50000; id++) {
        try {
          const owner = await registry.ownerOf(id);
          if (owner.toLowerCase() === ownerAddr) {
            const uri = await registry.tokenURI(id);
            if (uri === ipfsUri) {
              newId = id;
              break;
            }
          }
        } catch { break; } // ID doesn't exist = we've passed the max
      }
    }

    if (newId === 0) {
      log("  ⚠️  Could not determine new agent ID — check TX on bscscan");
      log(`  TX: https://bscscan.com/tx/${tx.hash}`);
      throw new Error("Could not find minted agent ID");
    }

    log(`  🧠 BRAIN Agent minted as #${newId}`);

    // Save the ID
    const { writeFileSync: wfs } = await import("fs");
    wfs(BRAIN_ID_FILE, String(newId));
    log(`  Saved ID to ${BRAIN_ID_FILE}`);

    return newId;
  } catch (e: any) {
    log(`  ❌ Mint failed: ${e.message}`);
    throw e;
  }
}

async function main() {
  if (!PINATA_JWT) { console.error("❌ PINATA_JWT fehlt in .env"); process.exit(1); }
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error("❌ PRIVATE_KEY fehlt in .env"); process.exit(1); }

  const doMintBrain = process.argv.includes("--mint-brain");

  const { writeFileSync, existsSync: fileExists, readFileSync: readFile } = await import("fs");

  // Load BRAIN agent ID if already minted
  if (fileExists(BRAIN_ID_FILE)) {
    const brainId = parseInt(readFile(BRAIN_ID_FILE, "utf-8").trim());
    if (brainId > 0) {
      const brainAgent = AGENTS.find(a => a.role === "brain");
      if (brainAgent) brainAgent.id = brainId;
      log(`🧠 BRAIN Agent ID loaded: #${brainId}`);
    }
  }

  log("🤖 BOB Plaza Agent Updater v10.0 — 5 Agents (Beacon, Scholar, Synapse, Pulse, Brain)");

  const { client } = await connectBNBChain(privateKey);

  for (const agent of AGENTS) {
    // Skip BRAIN if not yet minted and not minting now
    if (agent.role === "brain" && agent.id === 0) {
      if (doMintBrain) {
        // Mint BRAIN as new agent
        const metadata = buildMetadata({ ...agent, id: 0 });
        const ipfsUri = await uploadToIPFS(metadata, agent.role);
        writeFileSync(`bob-agent-${agent.role}.json`, JSON.stringify(metadata, null, 2));
        const newId = await mintBrainAgent(ipfsUri);
        agent.id = newId;
        // Re-upload with correct ID in registrations
        const updatedMetadata = buildMetadata(agent);
        const updatedUri = await uploadToIPFS(updatedMetadata, `${agent.role}-final`);
        writeFileSync(`bob-agent-${agent.role}.json`, JSON.stringify(updatedMetadata, null, 2));
        await updateAgentURI(client, newId, updatedUri);
      } else {
        log(`\n── ${agent.name} — SKIPPED (not yet minted, use --mint-brain) ──`);
        continue;
      }
    } else {
      log(`\n── ${agent.name} (#${agent.id}) ──`);
      const metadata = buildMetadata(agent);
      const ipfsUri = await uploadToIPFS(metadata, agent.role);
      writeFileSync(`bob-agent-${agent.role}.json`, JSON.stringify(metadata, null, 2));
      await updateAgentURI(client, agent.id, ipfsUri);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  await client.close();
  log("\n🏁 DONE — alle 5 Agents updated! (Beacon, Scholar, Synapse, Pulse, Brain)");
  process.exit(0);
}

main().catch(e => {
  console.error("❌ Fehler:", e);
  process.exit(1);
});
