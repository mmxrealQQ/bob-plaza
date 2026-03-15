/**
 * FREE AGENT — Vollständig autonomer Agent
 * Groq entscheidet ALLES. Keine Regeln. Keine Vorgaben. Build On BNB.
 */

import "dotenv/config";
import Groq from "groq-sdk";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { connectBNBChain, executeTool } from "../mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const MODEL = "llama-3.1-8b-instant"; // default fallback

// ── Provider Configs ───────────────────────────────────────────────────────
export interface ProviderConfig {
  name: "groq" | "gemini" | "cerebras";
  model: string;
}

const PROVIDER_SETTINGS: Record<string, { baseURL?: string; apiKeyEnv: string; useOpenAI?: boolean }> = {
  groq:     { apiKeyEnv: "GROQ_API_KEY" },
  gemini:   { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKeyEnv: "GEMINI_API_KEY", useOpenAI: true },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", useOpenAI: true },
};
const MEMORY_FILE = "bob-brains.json";
const STATE_FILE = "bob-swarm-state.json";
const ACTIVITY_LOG_SIZE = 20; // how many recent actions to keep per agent
const REFLECT_EVERY = 8;      // auto-reflect every N iterations

// ── Memory Types ──────────────────────────────────────────────────────────────
interface MemoryEntry {
  value: string;
  type: "discovery" | "pattern" | "lesson" | "hypothesis" | "insight" | "general";
  confidence: number;     // 0-100
  confirmations: number;  // how many times this was proven true
  firstSeen: string;
  lastSeen: string;
  timesUsed: number;
}

interface ActivityEntry {
  iter: number;
  action: string;
  argsSummary: string;
  resultSummary: string;
  success: boolean;
  time: string;
}
const PINATA_JWT = process.env.PINATA_JWT ?? "";
const VERCEL_URL = process.env.VERCEL_API_URL ?? "https://project-gkws4.vercel.app";
const BOB_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const AGENT_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";

// ── Tool Definitions (Groq function calling) ──────────────────────────────────
export const TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_network_stats",
      description: "Get current stats of the BSC agent network and swarm state",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_agent",
      description: "Scan a specific BSC ERC-8004 agent by ID. Returns metadata, endpoint, owner.",
      parameters: {
        type: "object",
        properties: { agentId: { type: "number", description: "Agent ID to scan" } },
        required: ["agentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_range",
      description: "Scan a range of BSC agent IDs at once",
      parameters: {
        type: "object",
        properties: {
          startId: { type: "number" },
          count: { type: "number", description: "How many agents to scan (max 10)" },
        },
        required: ["startId", "count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch any URL — APIs, agent endpoints, DexScreener, 8004scan, etc.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST"], description: "Default GET" },
          body: { type: "string", description: "JSON body for POST" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "contact_agent",
      description: "Send an A2A message to another BSC agent's endpoint",
      parameters: {
        type: "object",
        properties: {
          endpoint: { type: "string" },
          message: { type: "string" },
        },
        required: ["endpoint", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "message_swarm",
      description: "Send a message to another agent in your swarm (SCOUT, DATABASE, PUSHER, ORACLE)",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "SCOUT, DATABASE, PUSHER, ORACLE, or ALL" },
          message: { type: "string" },
        },
        required: ["to", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_memory",
      description: "Save a learning to your permanent memory. Use type to categorize: 'discovery' (found something new), 'pattern' (recurring observation), 'lesson' (learned from success/failure), 'hypothesis' (something to test), 'insight' (synthesized understanding).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short label for this memory" },
          value: { type: "string", description: "What you learned — be specific and actionable" },
          type: { type: "string", enum: ["discovery", "pattern", "lesson", "hypothesis", "insight", "general"] },
          confidence: { type: "number", description: "How confident are you? 0-100" },
        },
        required: ["key", "value", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description: "Read all your stored memories. Use this to build on past learnings before acting.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_memory",
      description: "Confirm or refute an existing memory based on new evidence. Increases or decreases confidence.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The memory key to update" },
          confirmed: { type: "boolean", description: "True = this was proven correct again, false = this was wrong" },
          newEvidence: { type: "string", description: "What new evidence supports or refutes this memory" },
        },
        required: ["key", "confirmed"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_profile",
      description: "Update your own public ERC-8004 agent profile on 8004scan. Upload new description/skills to IPFS and update on-chain.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
        },
        required: ["name", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "register_agent",
      description: "Register a brand new ERC-8004 agent on BNB Chain. Use this to create new specialized agents.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          role: { type: "string" },
        },
        required: ["name", "description", "role"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bnb_balance",
      description: "Check current BNB and $BOB balance in the wallet",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_bnb",
      description: "Send BNB to a teammate wallet. Use this to fund a teammate who is out of gas. Teammate wallets: SCOUT=0x93B4150114fd96377fEaB30Fd4597405b9f0CE33, DATABASE=0xB14Ac40b0F85621631f61612abC31631C7C0E749, PUSHER=0xd671164Da3133501356488613CB16632e8195481, ORACLE=0x68B3875C669352e9fE2145Ff14419815C22df45e",
      parameters: {
        type: "object",
        properties: {
          toAddress: { type: "string", description: "Recipient wallet address" },
          amount: { type: "string", description: "Amount in BNB (e.g. '0.005')" },
          reason: { type: "string", description: "Why you are sending (e.g. 'funding DATABASE who is out of gas')" },
        },
        required: ["toAddress", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buy_bob",
      description: "Buy $BOB tokens on PancakeSwap. Use this to push $BOB.",
      parameters: {
        type: "object",
        properties: {
          bnbAmount: { type: "number", description: "How much BNB to spend (min 0.001)" },
        },
        required: ["bnbAmount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sell_bob",
      description: "Sell $BOB tokens back to BNB on PancakeSwap.",
      parameters: {
        type: "object",
        properties: {
          sellPct: { type: "number", description: "Percentage of $BOB holdings to sell (1-100)" },
        },
        required: ["sellPct"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_trade",
      description: "Propose a trade for the swarm. PUSHER will review and execute. Use when you spot an opportunity.",
      parameters: {
        type: "object",
        properties: {
          tokenAddress: { type: "string", description: "BSC token contract address (use BOB token address for $BOB)" },
          tokenSymbol: { type: "string", description: "Token symbol e.g. BOB, BNB" },
          direction: { type: "string", enum: ["buy", "sell"], description: "buy or sell" },
          bnbAmount: { type: "number", description: "For buy: BNB amount to spend (min 0.001)" },
          sellPct: { type: "number", description: "For sell: % of holdings to sell (1-100)" },
          reason: { type: "string", description: "Why this trade makes sense" },
          confidence: { type: "number", description: "Confidence 0-100" },
        },
        required: ["tokenAddress", "tokenSymbol", "direction", "reason", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_trades",
      description: "PUSHER only: Check pending trade proposals from other agents and execute them.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_new_memes",
      description: "Get newest and trending meme tokens on BSC from GeckoTerminal. Use this to find trading opportunities.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["trending", "new", "volume"], description: "trending=hot right now, new=just launched, volume=highest 24h volume" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buy_token",
      description: "Buy any BSC token with BNB on PancakeSwap. Use for meme trades.",
      parameters: {
        type: "object",
        properties: {
          tokenAddress: { type: "string", description: "BSC token contract address" },
          tokenSymbol: { type: "string", description: "Token symbol for logging" },
          bnbAmount: { type: "number", description: "BNB to spend (min 0.001, max 0.01 unless very confident)" },
          slippage: { type: "number", description: "Slippage % (default 15, use 25-49 for high-tax memes)" },
        },
        required: ["tokenAddress", "tokenSymbol", "bnbAmount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sell_token",
      description: "Sell any BSC token back to BNB on PancakeSwap.",
      parameters: {
        type: "object",
        properties: {
          tokenAddress: { type: "string", description: "BSC token contract address" },
          tokenSymbol: { type: "string", description: "Token symbol for logging" },
          sellPct: { type: "number", description: "% of holdings to sell (1-100)" },
          slippage: { type: "number", description: "Slippage % (default 15)" },
        },
        required: ["tokenAddress", "tokenSymbol", "sellPct"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_holdings",
      description: "Check what tokens this agent currently holds (besides BNB).",
      parameters: {
        type: "object",
        properties: {
          tokenAddresses: { type: "array", items: { type: "string" }, description: "List of token addresses to check" },
        },
        required: ["tokenAddresses"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sleep",
      description: "Rest for a while. Use when there's nothing important to do.",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "How long to sleep (1-120 min)" },
          reason: { type: "string" },
        },
        required: ["minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bnb_price",
      description: "Get current BNB price in USD from Binance. Also returns top BSC tokens.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_bsc_tokens",
      description: "Search for BSC tokens on DexScreener. Find new projects, trending tokens, builders.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Token name, symbol, or address to search" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_token_info",
      description: "Get detailed info about any BSC token — price, liquidity, volume, holders from DexScreener + PancakeSwap.",
      parameters: {
        type: "object",
        properties: {
          tokenAddress: { type: "string", description: "BSC token contract address" },
        },
        required: ["tokenAddress"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wallet_activity",
      description: "Check recent transactions of a BSC wallet. Useful to understand if a builder is active.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "BSC wallet address" },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erc20_token_info",
      description: "Get ERC20 token details from BSC: name, symbol, decimals, total supply. Use for $BOB or any token.",
      parameters: {
        type: "object",
        properties: {
          tokenAddress: { type: "string", description: "BSC token contract address" },
        },
        required: ["tokenAddress"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "is_contract_or_wallet",
      description: "Check if a BSC address is a smart contract or a regular wallet (EOA). Useful for classifying agent owners.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "BSC address to check" },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_wallet",
      description: "Get the verified payment wallet address of an ERC-8004 agent. Use this before sending $BOB as a gift.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "number", description: "ERC-8004 agent ID" },
        },
        required: ["agentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_bob_gift",
      description: "Send $BOB tokens as a gift to a BSC address. Use to reward builders. Checks balance first.",
      parameters: {
        type: "object",
        properties: {
          toAddress: { type: "string", description: "Recipient BSC address" },
          amount: { type: "string", description: "Amount of $BOB to send (e.g. \"1000\")" },
          reason: { type: "string", description: "Why you are gifting $BOB" },
        },
        required: ["toAddress", "amount", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_latest_block",
      description: "Get the latest BSC block number and timestamp. Use to check chain liveness and timing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_transaction",
      description: "Get details of a BSC transaction by hash. Use to verify your own on-chain actions.",
      parameters: {
        type: "object",
        properties: {
          txHash: { type: "string", description: "Transaction hash" },
        },
        required: ["txHash"],
      },
    },
  },
];

// ── Tool Executor ─────────────────────────────────────────────────────────────
async function executeFn(
  name: string,
  args: Record<string, unknown>,
  agentName: string,
  agentId: number | null,
  mcpClient: Client | null,
  inbox: string[],
  walletAddress: string = BOB_WALLET
): Promise<{ result: string; sleepMs?: number }> {

  switch (name) {

    case "get_network_stats": {
      const state = existsSync(STATE_FILE)
        ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
        : { totalScanned: 0, stats: {} };
      const inboxMsgs = readInbox(agentName);
      return {
        result: JSON.stringify({
          totalScanned: state.totalScanned ?? 0,
          active: state.stats?.activeAgents ?? 0,
          inactive: state.stats?.inactiveAgents ?? 0,
          ghosts: state.stats?.ghostAgents ?? 0,
          ruggers: state.stats?.confirmedRuggers ?? 0,
          wallets: state.stats?.walletsClassified ?? 0,
          pendingAnalysis: state.pendingAnalysis?.length ?? 0,
          inboxMessages: inboxMsgs,
        })
      };
    }

    case "scan_agent": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const raw = await executeTool(mcpClient, "get_erc8004_agent", {
          agentId: String(args.agentId),
          network: "bsc",
        });
        const data = JSON.parse(raw);
        // Fetch metadata if URI exists
        let meta = null;
        if (data.agentURI?.startsWith("http") || data.agentURI?.startsWith("ipfs")) {
          const url = data.agentURI.startsWith("ipfs://")
            ? `https://ipfs.io/ipfs/${data.agentURI.slice(7)}`
            : data.agentURI;
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (res.ok) meta = await res.json();
          } catch { /* ignore */ }
        }
        // Save to swarm state
        saveAgentToState(Number(args.agentId), data, meta);
        return { result: JSON.stringify({ raw: data, metadata: meta }) };
      } catch (e) {
        return { result: `Error: ${e}` };
      }
    }

    case "scan_range": {
      if (!mcpClient) return { result: "MCP not connected" };
      const start = Number(args.startId);
      const count = Math.min(Number(args.count), 10);
      const results: unknown[] = [];
      for (let id = start; id < start + count; id++) {
        try {
          const raw = await executeTool(mcpClient, "get_erc8004_agent", { agentId: String(id), network: "bsc" });
          const data = JSON.parse(raw);
          saveAgentToState(id, data, null);
          results.push({ agentId: id, owner: data.owner, hasURI: !!data.agentURI, name: data.name ?? null });
        } catch { results.push({ agentId: id, error: true }); }
        await new Promise(r => setTimeout(r, 200));
      }
      return { result: JSON.stringify(results) };
    }

    case "fetch_url": {
      try {
        const res = await fetch(String(args.url), {
          method: String(args.method ?? "GET"),
          headers: { "Content-Type": "application/json", "User-Agent": "BOB-Swarm/5.0" },
          body: args.body ? String(args.body) : undefined,
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text();
        return { result: text.slice(0, 2000) };
      } catch (e) {
        return { result: `Fetch error: ${e}` };
      }
    }

    case "contact_agent": {
      try {
        const res = await fetch(String(args.endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: agentName,
            agentId: agentId ?? 36035,
            wallet: BOB_WALLET,
            token: BOB_TOKEN,
            endpoint: VERCEL_URL,
            message: args.message,
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(8000),
        });
        const reply = await res.text().catch(() => "");
        // Mark as fren if responded
        if (res.ok) recordFrenContact(String(args.endpoint), true);
        return { result: res.ok ? `Responded: ${reply.slice(0, 500)}` : `No response (${res.status})` };
      } catch (e) {
        return { result: `Contact failed: ${e}` };
      }
    }

    case "message_swarm": {
      writeInbox(String(args.to), agentName, String(args.message));
      printSwarmMessage(agentName, String(args.to), String(args.message));
      return { result: "Message sent" };
    }

    case "write_memory": {
      const mem = loadMemory(agentName);
      const key = String(args.key);
      const existing = mem[key];
      mem[key] = {
        value: String(args.value),
        type: (args.type as MemoryEntry["type"]) ?? "general",
        confidence: Number(args.confidence ?? 70),
        confirmations: existing ? (existing as MemoryEntry).confirmations + 1 : 0,
        firstSeen: existing ? (existing as MemoryEntry).firstSeen : new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        timesUsed: existing ? (existing as MemoryEntry).timesUsed : 0,
      };
      saveMemory(agentName, mem);
      return { result: `Saved [${args.type}] "${key}" (confidence: ${args.confidence ?? 70}%)` };
    }

    case "read_memory": {
      const mem = loadMemory(agentName);
      if (Object.keys(mem).length === 0) return { result: "No memories yet. Start exploring and learning!" };
      // Return sorted by confidence + recency
      const sorted = Object.entries(mem)
        .sort(([,a], [,b]) => {
          const ae = a as MemoryEntry; const be = b as MemoryEntry;
          return (be.confidence + be.confirmations * 10) - (ae.confidence + ae.confirmations * 10);
        })
        .map(([k, v]) => {
          const e = v as MemoryEntry;
          return `[${e.type}|${e.confidence}%] ${k}: ${e.value}`;
        });
      return { result: sorted.join("\n") };
    }

    case "confirm_memory": {
      const mem = loadMemory(agentName);
      const key = String(args.key);
      if (!mem[key]) return { result: `Memory "${key}" not found` };
      const e = mem[key] as MemoryEntry;
      if (args.confirmed) {
        e.confirmations += 1;
        e.confidence = Math.min(99, e.confidence + 5);
        e.value = args.newEvidence ? `${e.value} | Confirmed: ${String(args.newEvidence)}` : e.value;
      } else {
        e.confidence = Math.max(5, e.confidence - 20);
        e.value = args.newEvidence ? `${e.value} | REFUTED: ${String(args.newEvidence)}` : e.value;
      }
      e.lastSeen = new Date().toISOString();
      mem[key] = e;
      saveMemory(agentName, mem);
      return { result: `Memory "${key}" ${args.confirmed ? "confirmed ✓" : "refuted ✗"} → confidence now ${e.confidence}%` };
    }

    case "update_profile": {
      if (!mcpClient || !agentId) return { result: "No agentId — register first" };
      const metadata = {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: args.name,
        description: args.description,
        image: "https://raw.githubusercontent.com/mmxrealQQ/bob-assets/main/bob.jpg",
        active: true,
        version: "5.0",
        services: [
          { name: "agentWallet", endpoint: `eip155:56:${BOB_WALLET}` },
          { name: "a2a", endpoint: VERCEL_URL, version: "0.2.5" },
          { name: "mcp", endpoint: `${VERCEL_URL}/mcp`, version: "2025-06-18" },
          {
            name: "OASF", endpoint: VERCEL_URL, version: "0.8.0",
            skills: (args.skills as string[] ?? []).map(s => `analytical_skills/${s}`),
            domains: ["technology/blockchain", "finance_and_business/decentralized_finance",
                      "technology/artificial_intelligence", "social/community"],
          },
        ],
        swarmAgent: agentName,
        swarmMission: "Build On BNB — $BOB",
        updatedAt: Math.floor(Date.now() / 1000),
      };

      // Upload to IPFS
      const ipfsUri = await pinToIPFS(metadata, `${agentName.toLowerCase()}-v5.json`);
      if (!ipfsUri) return { result: "IPFS upload failed" };

      // Update on-chain
      const res = await executeTool(mcpClient, "set_erc8004_agent_uri", {
        agentId: String(agentId), newURI: ipfsUri, network: "bsc",
      });
      return { result: `Profile updated: ${ipfsUri} | TX: ${res.slice(0, 100)}` };
    }

    case "register_agent": {
      if (!mcpClient) return { result: "MCP not connected" };

      // Guard: already registered?
      const existingMem = loadMemory(agentName);
      if (existingMem["own_agent_id"]?.value) {
        return { result: `Already registered as Agent #${existingMem["own_agent_id"].value} — no need to register again.` };
      }

      // Check balance
      const bnbRaw = await executeTool(mcpClient, "get_native_balance", { address: BOB_WALLET, network: "bsc" });
      const bnb = parseFloat(JSON.parse(bnbRaw).formatted ?? "0");
      if (bnb < 0.002) return { result: `Not enough BNB (${bnb}). Need 0.002 BNB for registration.` };

      const metadata = {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: args.name,
        description: args.description,
        image: "https://raw.githubusercontent.com/mmxrealQQ/bob-assets/main/bob.jpg",
        active: true,
        version: "5.0",
        services: [
          { name: "agentWallet", endpoint: `eip155:56:${BOB_WALLET}` },
          { name: "a2a", endpoint: VERCEL_URL, version: "0.2.5" },
          { name: "mcp", endpoint: `${VERCEL_URL}/mcp`, version: "2025-06-18" },
        ],
        swarmRole: args.role,
        swarmAgent: agentName,
        updatedAt: Math.floor(Date.now() / 1000),
      };

      const ipfsUri = await pinToIPFS(metadata, `${String(args.name).toLowerCase().replace(/\s/g, "-")}.json`);
      if (!ipfsUri) return { result: "IPFS upload failed" };

      const res = await executeTool(mcpClient, "register_erc8004_agent", {
        agentURI: ipfsUri,
        network: "bsc",
      });

      // Try to extract the new agent ID from the result and save to memory
      let newAgentId: number | null = null;
      try {
        const parsed = JSON.parse(res);
        // Try all common field names + nested receipt/events
        newAgentId = parsed.tokenId ?? parsed.agentId ?? parsed.id
          ?? parsed.receipt?.logs?.[0]?.topics?.[3]
          ?? parsed.events?.Transfer?.returnValues?.tokenId
          ?? null;
        if (typeof newAgentId === "string") newAgentId = parseInt(newAgentId, 16) || parseInt(newAgentId);
      } catch { /* not JSON */ }

      // Fallback: regex scan for any large number that looks like an agent ID (35000-99999)
      if (!newAgentId) {
        const match = res.match(/\b(3[5-9]\d{3}|[4-9]\d{4})\b/);
        if (match?.[1]) newAgentId = parseInt(match[1]);
      }
      // Also try generic tokenId/agentId/id patterns
      if (!newAgentId) {
        const match = res.match(/"(?:tokenId|agentId|id)"\s*:\s*"?(\d+)"?/);
        if (match?.[1]) newAgentId = parseInt(match[1]);
      }

      if (newAgentId) {
        const mem = loadMemory(agentName);
        mem["own_agent_id"] = {
          value: String(newAgentId),
          type: "discovery", confidence: 99, confirmations: 0,
          firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), timesUsed: 0,
        };
        saveMemory(agentName, mem);
        process.stdout.write(`[${agentName}] Saved own agent ID #${newAgentId} to memory.\n`);
      }

      const idStr = newAgentId ? ` | Agent ID: #${newAgentId}` : " | ID not parseable — check 8004scan for your wallet";
      return { result: `Registered: ${ipfsUri}${idStr} | ${res.slice(0, 100)}` };
    }

    case "get_bnb_balance": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const bnb = await executeTool(mcpClient, "get_native_balance", { address: walletAddress, network: "bsc" });
        const bob = await executeTool(mcpClient, "get_erc20_balance", {
          tokenAddress: BOB_TOKEN, address: walletAddress, network: "bsc",
        });
        const bnbData = JSON.parse(bnb);
        const bobData = JSON.parse(bob);
        return { result: `BNB: ${bnbData.formatted} | $BOB: ${bobData.formatted}` };
      } catch (e) { return { result: `Error: ${e}` }; }
    }

    case "send_bnb": {
      if (!mcpClient) return { result: "MCP not connected" };
      const toAddr = String(args.toAddress);
      const sendAmount = String(args.amount ?? "0.005");
      const reason = String(args.reason ?? "");
      try {
        const res = await executeTool(mcpClient, "transfer_native_token", { toAddress: toAddr, amount: sendAmount, network: "bsc" });
        return { result: `Sent ${sendAmount} BNB to ${toAddr.slice(0, 10)}… | ${reason} | ${String(res).slice(0, 80)}` };
      } catch (e) { return { result: `send_bnb failed: ${e}` }; }
    }

    case "buy_bob": {
      if (!mcpClient) return { result: "MCP not connected" };
      const amount = Number(args.bnbAmount ?? 0.001);

      // Wrap BNB first
      await executeTool(mcpClient, "transfer_native_token", {
        toAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        amount: String(amount),
        network: "bsc",
      });
      await new Promise(r => setTimeout(r, 3000));

      // Approve + swap
      const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
      const WBNB_WEI = BigInt(Math.floor(amount * 1e18)).toString();
      const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
      await executeTool(mcpClient, "write_contract", {
        contractAddress: WBNB, abi: APPROVE_ABI, functionName: "approve",
        args: ["0x10ED43C718714eb63d5aA57B78B54704E256024E", WBNB_WEI], network: "bsc",
      });
      await new Promise(r => setTimeout(r, 3000));

      const SWAP_FOT_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const res = await executeTool(mcpClient, "write_contract", {
        contractAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
        abi: SWAP_FOT_ABI,
        functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
        args: [WBNB_WEI, "1", [WBNB, BOB_TOKEN], walletAddress, String(deadline)],
        network: "bsc",
      });
      return { result: `$BOB bought with ${amount} BNB | ${res.slice(0, 100)}` };
    }

    case "sell_bob": {
      if (!mcpClient) return { result: "MCP not connected" };
      const pct = Math.min(Math.max(Number(args.sellPct ?? 10), 1), 100);

      // Get current $BOB balance
      const balRes = await executeTool(mcpClient, "get_erc20_balance", {
        tokenAddress: BOB_TOKEN, address: walletAddress, network: "bsc",
      });
      let bobRawBalance: bigint;
      let bobDisplay: string;
      try {
        const bd = JSON.parse(balRes);
        bobRawBalance = BigInt(bd.raw ?? bd.balance ?? "0");
        bobDisplay = bd.formatted ?? "0";
      } catch { return { result: `Could not read $BOB balance: ${balRes.slice(0, 100)}` }; }
      if (bobRawBalance === 0n) return { result: "No $BOB to sell" };
      const sellAmount = (bobRawBalance * BigInt(pct) / 100n).toString();

      // Approve PancakeSwap to spend $BOB
      const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
      await executeTool(mcpClient, "write_contract", {
        contractAddress: BOB_TOKEN, abi: APPROVE_ABI, functionName: "approve",
        args: ["0x10ED43C718714eb63d5aA57B78B54704E256024E", sellAmount], network: "bsc",
      });
      await new Promise(r => setTimeout(r, 3000));

      // Swap $BOB → BNB
      const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
      const SWAP_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForETHSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const res = await executeTool(mcpClient, "write_contract", {
        contractAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
        abi: SWAP_ABI,
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [sellAmount, "1", [BOB_TOKEN, WBNB], walletAddress, String(deadline)],
        network: "bsc",
      });
      return { result: `Sold ${pct}% of $BOB (${bobDisplay}) → BNB | ${String(res).slice(0, 80)}` };
    }

    case "get_new_memes": {
      try {
        const mode = String(args.mode ?? "trending");
        const orderMap: Record<string, string> = {
          trending: "trending_pools",
          new: "pools?order=pool_created_at",
          volume: "pools?order=h24_volume_usd_desc",
        };
        const endpoint = mode === "trending"
          ? "https://api.geckoterminal.com/api/v2/networks/bsc/trending_pools?page=1"
          : `https://api.geckoterminal.com/api/v2/networks/bsc/${orderMap[mode] ?? "pools?order=h24_volume_usd_desc"}&page=1`;
        const res = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json() as { data?: { attributes: { name: string; base_token_price_usd: string; volume_usd: { h24: string }; reserve_in_usd: string; price_change_percentage: { h1: string; h24: string }; pool_created_at: string }; relationships: { base_token: { data: { id: string } } } }[] };
        const pools = (data.data ?? []).slice(0, 8).map(p => {
          const a = p.attributes;
          const tokenId = p.relationships?.base_token?.data?.id ?? "";
          const addr = tokenId.split("_")[1] ?? "";
          const vol = parseFloat(a.volume_usd?.h24 ?? "0");
          const liq = parseFloat(a.reserve_in_usd ?? "0");
          const ch1 = parseFloat(a.price_change_percentage?.h1 ?? "0").toFixed(1);
          const ch24 = parseFloat(a.price_change_percentage?.h24 ?? "0").toFixed(1);
          const age = a.pool_created_at ? Math.round((Date.now() - new Date(a.pool_created_at).getTime()) / 60000) + "min ago" : "?";
          return `${a.name} | addr:${addr} | vol24:$${Math.round(vol / 1000)}k | liq:$${Math.round(liq / 1000)}k | 1h:${ch1}% 24h:${ch24}% | ${age}`;
        });
        return { result: `BSC Memes (${mode}):\n${pools.join("\n") || "none found"}` };
      } catch (e) { return { result: `GeckoTerminal error: ${e}` }; }
    }

    case "buy_token": {
      if (!mcpClient) return { result: "MCP not connected" };
      const tokenAddr = String(args.tokenAddress);
      const tokenSym = String(args.tokenSymbol ?? "TOKEN");
      const amount = Math.min(Math.max(Number(args.bnbAmount ?? 0.002), 0.001), 0.05);
      const slippage = Number(args.slippage ?? 15);
      const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
      const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
      const WBNB_WEI = BigInt(Math.floor(amount * 1e18)).toString();

      // Wrap BNB → WBNB
      await executeTool(mcpClient, "transfer_native_token", { toAddress: WBNB, amount: String(amount), network: "bsc" });
      await new Promise(r => setTimeout(r, 3000));

      // Approve WBNB for router
      const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
      await executeTool(mcpClient, "write_contract", { contractAddress: WBNB, abi: APPROVE_ABI, functionName: "approve", args: [ROUTER, WBNB_WEI], network: "bsc" });
      await new Promise(r => setTimeout(r, 3000));

      // Calculate amountOutMin with slippage
      const SWAP_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const res = await executeTool(mcpClient, "write_contract", {
        contractAddress: ROUTER, abi: SWAP_ABI,
        functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
        args: [WBNB_WEI, "1", [WBNB, tokenAddr], walletAddress, String(deadline)],
        network: "bsc",
      });
      return { result: `Bought ${tokenSym} with ${amount} BNB (${slippage}% slippage) | ${String(res).slice(0, 80)}` };
    }

    case "sell_token": {
      if (!mcpClient) return { result: "MCP not connected" };
      const tokenAddr = String(args.tokenAddress);
      const tokenSym = String(args.tokenSymbol ?? "TOKEN");
      const pct = Math.min(Math.max(Number(args.sellPct ?? 50), 1), 100);
      const slippage = Number(args.slippage ?? 15);
      const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
      const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

      // Get token balance
      const balRaw = await executeTool(mcpClient, "get_erc20_balance", { tokenAddress: tokenAddr, address: walletAddress, network: "bsc" });
      let rawBalance: bigint;
      let displayBalance: string;
      try {
        const bd = JSON.parse(balRaw);
        rawBalance = BigInt(bd.raw ?? bd.balance ?? "0");
        displayBalance = bd.formatted ?? "0";
      } catch { return { result: `Cannot read ${tokenSym} balance: ${balRaw.slice(0, 80)}` }; }
      if (rawBalance === 0n) return { result: `No ${tokenSym} to sell` };
      const sellAmount = (rawBalance * BigInt(pct) / 100n).toString();

      // Approve router
      const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
      await executeTool(mcpClient, "write_contract", { contractAddress: tokenAddr, abi: APPROVE_ABI, functionName: "approve", args: [ROUTER, sellAmount], network: "bsc" });
      await new Promise(r => setTimeout(r, 3000));

      // Swap token → BNB
      const SWAP_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForETHSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const res = await executeTool(mcpClient, "write_contract", {
        contractAddress: ROUTER, abi: SWAP_ABI,
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [sellAmount, "1", [tokenAddr, WBNB], walletAddress, String(deadline)],
        network: "bsc",
      });
      return { result: `Sold ${pct}% of ${tokenSym} (${displayBalance}) → BNB | ${String(res).slice(0, 80)}` };
    }

    case "get_holdings": {
      if (!mcpClient) return { result: "MCP not connected" };
      const addresses = (args.tokenAddresses as string[]) ?? [];
      if (addresses.length === 0) return { result: "No addresses provided" };
      const results: string[] = [];
      for (const addr of addresses.slice(0, 10)) {
        try {
          const raw = await executeTool(mcpClient, "get_erc20_balance", { tokenAddress: addr, address: walletAddress, network: "bsc" });
          const bd = JSON.parse(raw);
          const rawBal = BigInt(bd.raw ?? bd.balance ?? "0");
          if (rawBal > 0n) results.push(`${addr.slice(0, 10)}… : ${bd.formatted ?? rawBal.toString()} ${bd.symbol ?? ""}`);
        } catch { /* skip */ }
      }
      return { result: results.length > 0 ? `Holdings:\n${results.join("\n")}` : "No token holdings found" };
    }

    case "propose_trade": {
      const state = JSON.parse(existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf-8") : "{}");
      if (!state.pendingTrades) state.pendingTrades = [];
      const signal = {
        id: `${agentName}-${Date.now()}`,
        proposedBy: agentName,
        tokenAddress: String(args.tokenAddress),
        tokenSymbol: String(args.tokenSymbol),
        direction: String(args.direction) as "buy" | "sell",
        bnbAmount: args.bnbAmount ? Number(args.bnbAmount) : undefined,
        sellPct: args.sellPct ? Number(args.sellPct) : undefined,
        reason: String(args.reason),
        confidence: Number(args.confidence ?? 50),
        proposedAt: new Date().toISOString(),
        executed: false,
      };
      state.pendingTrades.push(signal);
      state.updatedAt = new Date().toISOString();
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`[${agentName}] 📊 Trade proposed: ${signal.direction.toUpperCase()} ${signal.tokenSymbol} | confidence: ${signal.confidence}% | ${signal.reason}`);
      return { result: `Trade signal posted: ${signal.direction} ${signal.tokenSymbol} | PUSHER will review` };
    }

    case "check_trades": {
      if (!mcpClient) return { result: "MCP not connected" };
      const state = JSON.parse(existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf-8") : "{}");
      const pending: any[] = state.pendingTrades ?? [];
      const unexecuted = pending.filter((t: any) => !t.executed);
      if (unexecuted.length === 0) return { result: "No pending trade signals" };

      const results: string[] = [];
      for (const signal of unexecuted) {
        if (signal.confidence < 60) {
          signal.executed = true;
          signal.result = "Skipped: confidence too low";
          results.push(`⏭ Skipped ${signal.tokenSymbol} (${signal.confidence}% confidence)`);
          continue;
        }
        try {
          if (signal.direction === "buy") {
            const tool = signal.tokenAddress === BOB_TOKEN ? "buy_bob" : "buy_token";
            const buyArgs = signal.tokenAddress === BOB_TOKEN
              ? { bnbAmount: signal.bnbAmount ?? 0.002 }
              : { tokenAddress: signal.tokenAddress, tokenSymbol: signal.tokenSymbol, bnbAmount: signal.bnbAmount ?? 0.002, slippage: 20 };
            const r = await executeFn(tool, buyArgs, agentName, agentId, mcpClient, inbox, walletAddress);
            signal.result = r.result;
            results.push(`✅ Bought ${signal.tokenSymbol}: ${r.result.slice(0, 60)}`);
          } else if (signal.direction === "sell") {
            const tool = signal.tokenAddress === BOB_TOKEN ? "sell_bob" : "sell_token";
            const sellArgs = signal.tokenAddress === BOB_TOKEN
              ? { sellPct: signal.sellPct ?? 25 }
              : { tokenAddress: signal.tokenAddress, tokenSymbol: signal.tokenSymbol, sellPct: signal.sellPct ?? 50, slippage: 20 };
            const r = await executeFn(tool, sellArgs, agentName, agentId, mcpClient, inbox, walletAddress);
            signal.result = r.result;
            results.push(`✅ Sold ${signal.tokenSymbol}: ${r.result.slice(0, 60)}`);
          } else {
            signal.result = `Unknown direction: ${signal.direction}`;
            results.push(`⚠ ${signal.result}`);
          }
          signal.executed = true;
          signal.executedAt = new Date().toISOString();
        } catch (e) {
          signal.result = `Error: ${e}`;
          results.push(`❌ ${signal.tokenSymbol}: ${e}`);
        }
      }

      // Move executed to history, keep max 50
      if (!state.tradeHistory) state.tradeHistory = [];
      const executed = pending.filter((t: any) => t.executed);
      state.tradeHistory = [...state.tradeHistory, ...executed].slice(-50);
      state.pendingTrades = pending.filter((t: any) => !t.executed);
      state.updatedAt = new Date().toISOString();
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

      return { result: `Processed ${executed.length} signals:\n${results.join("\n")}` };
    }

    case "sleep": {
      const mins = Math.min(Math.max(Number(args.minutes ?? 10), 1), 120);
      return { result: `Sleeping ${mins} min: ${args.reason ?? ""}`, sleepMs: mins * 60 * 1000 };
    }

    case "get_bnb_price": {
      try {
        const [bnbRes, trendRes] = await Promise.all([
          fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { signal: AbortSignal.timeout(5000) }),
          fetch("https://api.dexscreener.com/latest/dex/search?q=BSC+agent", { signal: AbortSignal.timeout(5000) }),
        ]);
        const bnbData = await bnbRes.json() as { price: string };
        const bnbPrice = parseFloat(bnbData.price ?? "0").toFixed(2);
        const trendData = await trendRes.json() as { pairs?: { baseToken: { symbol: string; address: string }; volume: { h24: number }; priceUsd: string }[] };
        const topPairs = (trendData.pairs ?? [])
          .filter(p => p.volume?.h24 > 10000)
          .slice(0, 5)
          .map(p => `${p.baseToken.symbol} $${parseFloat(p.priceUsd ?? "0").toFixed(6)} vol:$${Math.round(p.volume.h24 / 1000)}k`);
        return { result: `BNB: $${bnbPrice} | Top BSC: ${topPairs.join(", ") || "none"}` };
      } catch (e) { return { result: `Price fetch error: ${e}` }; }
    }

    case "search_bsc_tokens": {
      try {
        const q = encodeURIComponent(String(args.query ?? "BOB BNB"));
        const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json() as { pairs?: { chainId: string; baseToken: { symbol: string; name: string; address: string }; pairAddress: string; priceUsd: string; volume: { h24: number }; liquidity: { usd: number } }[] };
        const bscPairs = (data.pairs ?? [])
          .filter(p => p.chainId === "bsc")
          .slice(0, 8)
          .map(p => ({
            symbol: p.baseToken.symbol,
            name: p.baseToken.name,
            address: p.baseToken.address,
            price: p.priceUsd,
            vol24h: p.volume?.h24 ?? 0,
            liquidity: p.liquidity?.usd ?? 0,
          }));
        return { result: JSON.stringify(bscPairs) };
      } catch (e) { return { result: `Search error: ${e}` }; }
    }

    case "get_token_info": {
      try {
        const addr = String(args.tokenAddress);
        const [dexRes, cakeRes] = await Promise.all([
          fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(8000) }),
          fetch(`https://api.pancakeswap.info/api/v2/tokens/${addr}`, { signal: AbortSignal.timeout(5000) }),
        ]);
        const dexData = await dexRes.json() as { pairs?: { priceUsd: string; volume: { h24: number }; liquidity: { usd: number }; priceChange: { h24: number }; txns: { h24: { buys: number; sells: number } } }[] };
        const pair = dexData.pairs?.[0];
        let cakeInfo = "";
        if (cakeRes.ok) {
          const cd = await cakeRes.json() as { data?: { name: string; symbol: string; price: string } };
          cakeInfo = ` | PCS: ${cd.data?.name} ${cd.data?.symbol} $${parseFloat(cd.data?.price ?? "0").toFixed(8)}`;
        }
        if (!pair) return { result: `No DEX data for ${addr}` };
        return {
          result: `${addr} | Price: $${pair.priceUsd} | 24h: ${pair.priceChange?.h24}% | Vol: $${Math.round((pair.volume?.h24 ?? 0) / 1000)}k | Liq: $${Math.round((pair.liquidity?.usd ?? 0) / 1000)}k | Buys/Sells: ${pair.txns?.h24?.buys}/${pair.txns?.h24?.sells}${cakeInfo}`
        };
      } catch (e) { return { result: `Token info error: ${e}` }; }
    }

    case "get_wallet_activity": {
      try {
        const addr = String(args.address);
        // BSCScan free endpoint — no API key needed for recent 10 txns
        const res = await fetch(
          `https://api.bscscan.com/api?module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=YourApiKeyToken`,
          { signal: AbortSignal.timeout(8000) }
        );
        const data = await res.json() as { result?: { hash: string; timeStamp: string; value: string; to: string; from: string; isError: string }[]; status: string };
        if (data.status !== "1" || !data.result?.length) return { result: `No recent txns for ${addr}` };
        const txns = data.result.slice(0, 5).map(t => ({
          hash: t.hash.slice(0, 10) + "...",
          time: new Date(parseInt(t.timeStamp) * 1000).toLocaleDateString(),
          bnb: (parseInt(t.value) / 1e18).toFixed(4),
          to: t.to.slice(0, 10) + "...",
          error: t.isError !== "0",
        }));
        return { result: `Last ${txns.length} txns for ${addr.slice(0, 10)}...: ${JSON.stringify(txns)}` };
      } catch (e) { return { result: `Wallet activity error: ${e}` }; }
    }

    case "get_erc20_token_info": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const raw = await executeTool(mcpClient, "get_erc20_token_info", { tokenAddress: String(args.tokenAddress), network: "bsc" });
        return { result: raw.slice(0, 500) };
      } catch (e) { return { result: `Error: ${e}` }; }
    }

    case "is_contract_or_wallet": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const raw = await executeTool(mcpClient, "is_contract", { address: String(args.address), network: "bsc" });
        return { result: raw };
      } catch (e) { return { result: `Error: ${e}` }; }
    }

    case "get_agent_wallet": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const raw = await executeTool(mcpClient, "get_erc8004_agent_wallet", { agentId: String(args.agentId), network: "bsc" });
        return { result: raw.slice(0, 300) };
      } catch (e) { return { result: `Error: ${e}` }; }
    }

    case "send_bob_gift": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        // Check $BOB balance first
        const balRaw = await executeTool(mcpClient, "get_erc20_balance", {
          tokenAddress: BOB_TOKEN, address: BOB_WALLET, network: "bsc",
        });
        const balData = JSON.parse(balRaw);
        const bobBalance = parseFloat(balData.formatted ?? "0");
        if (bobBalance < 1000) {
          return { result: `Not enough $BOB to gift (balance: ${bobBalance})` };
        }
        // Transfer $BOB
        const res = await executeTool(mcpClient, "transfer_erc20", {
          tokenAddress: BOB_TOKEN,
          toAddress: String(args.toAddress),
          amount: String(args.amount),
          network: "bsc",
        });
        const reason = String(args.reason ?? "builder gift");
        return { result: `Sent ${args.amount} $BOB to ${String(args.toAddress).slice(0, 10)}... | Reason: ${reason} | ${res.slice(0, 150)}` };
      } catch (e) { return { result: `Gift error: ${e}` }; }
    }

    case "get_latest_block": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const raw = await executeTool(mcpClient, "get_latest_block", { network: "bsc" });
        const data = JSON.parse(raw);
        return { result: `Block #${data.number} | ${new Date(parseInt(data.timestamp) * 1000).toLocaleTimeString()} | ${data.transactions?.length ?? 0} txns` };
      } catch (e) { return { result: `Error: ${e}` }; }
    }

    case "get_transaction": {
      if (!mcpClient) return { result: "MCP not connected" };
      try {
        const raw = await executeTool(mcpClient, "get_transaction", { txHash: String(args.txHash), network: "bsc" });
        return { result: raw.slice(0, 400) };
      } catch (e) { return { result: `Error: ${e}` }; }
    }

    default:
      return { result: `Unknown tool: ${name}` };
  }
}

// ── Main Free Agent Loop ──────────────────────────────────────────────────────
export async function runFreeAgent(config: {
  name: string;
  agentId: number | null;
  systemPrompt: string;
  color: string;
  startDelay?: number;
  tools?: Groq.Chat.ChatCompletionTool[];
  provider?: ProviderConfig;
  privateKey?: string;
  walletAddress?: string;
}): Promise<void> {
  const providerCfg = config.provider ?? { name: "groq", model: MODEL };
  const settings = PROVIDER_SETTINGS[providerCfg.name];
  const apiKey = process.env[settings.apiKeyEnv] ?? "";
  const groq = settings.useOpenAI
    ? new OpenAI({ apiKey, baseURL: settings.baseURL }) as unknown as Groq
    : new Groq({ apiKey });
  const activeModel = providerCfg.model;

  const { name, color, systemPrompt } = config;
  const agentTools = config.tools ?? TOOLS; // per-agent tool subset

  const log = (msg: string) =>
    process.stdout.write(`${color}[${new Date().toLocaleTimeString("de-DE")}] ${name}\x1b[0m | ${msg}\n`);

  // Load agentId from memory if not hardcoded (PUSHER, ORACLE register themselves)
  let agentId = config.agentId;
  if (!agentId) {
    const savedMem = loadMemory(name);
    const savedId = savedMem["own_agent_id"]?.value;
    if (savedId) {
      agentId = parseInt(savedId);
      log(`Loaded agent ID from memory: #${agentId}`);
    }
  }

  log(`gm. ${name} is alive. No rules. Build On BNB.`);

  const agentPrivateKey = config.privateKey ?? process.env.PRIVATE_KEY;
  const agentWallet = config.walletAddress ?? BOB_WALLET;

  // Connect MCP
  let mcpClient: Client | null = null;
  try {
    const { client } = await connectBNBChain(agentPrivateKey);
    mcpClient = client;
    log(`MCP connected | wallet: ${agentWallet.slice(0, 10)}…`);
  } catch { log("MCP failed — running without chain access"); }

  // startDelay is handled by run-swarm.ts — no extra random stagger needed

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  const inbox: string[] = [];
  let iterationCount = 0;
  let consecutiveErrors = 0;
  // Stagger Opus calls: each agent waits its index × 45s before calling Opus
  // to avoid all 4 hitting Anthropic rate limits simultaneously
  const agentIndex = ["SCOUT","DATABASE","PUSHER","ORACLE"].indexOf(name);
  const opusStaggerMs = agentIndex * 45000;

  while (true) {
    iterationCount++;

    // ── Build context ────────────────────────────────────────────────────────
    const inboxMsgs = readInbox(name);
    const memContext = buildMemoryContext(name);
    const actContext = buildActivityContext(name);

    let userContent = "";
    if (inboxMsgs.length > 0) userContent += `[SWARM INBOX]:\n${inboxMsgs.join("\n")}\n\n`;
    if (memContext) userContent += `[YOUR MEMORIES]:\n${memContext}\n\n`;
    if (actContext) userContent += `[RECENT ACTIONS]:\n${actContext}\n\n`;
    userContent += `Iteration ${iterationCount}. Act according to your identity and strategy. Don't repeat failures.`;

    // ── PHASE 1: Opus 4.6 — immer, solange ANTHROPIC_API_KEY vorhanden ───────
    if (process.env.ANTHROPIC_API_KEY) {
      if (iterationCount === 1 && opusStaggerMs > 0) {
        log(`🧠 Opus stagger: waiting ${opusStaggerMs / 1000}s to avoid rate limits...`);
        await sleep(opusStaggerMs);
      }
      log(`🧠 Opus 4.6 — iteration ${iterationCount}`);
      await runOpusIteration(name, iterationCount, systemPrompt, userContent, agentTools, agentId, mcpClient, inbox, log, agentWallet);
      consecutiveErrors = 0;
      await sleep(90000);
      continue;
    }

    // ── PHASE 2: Auto-Reflection (Opus alle 8-14 Iter) ───────────────────────
    const agentOffset = ["SCOUT","DATABASE","PUSHER","ORACLE"].indexOf(name);
    const reflectAt = REFLECT_EVERY + agentOffset * 2;
    if (iterationCount % reflectAt === 0) {
      await runAutoReflection(name, groq, activeModel, log);
    }

    // ── PHASE 2: Groq Tool-Calls ─────────────────────────────────────────────
    messages.push({ role: "user", content: userContent });
    if (messages.length > 10) messages.splice(1, messages.length - 8);

    try {
      const response = await groq.chat.completions.create({
        model: activeModel,
        messages,
        tools: agentTools,
        tool_choice: "auto",
        max_tokens: 1024,
      });

      const msg = response.choices[0]?.message;
      if (!msg) { await sleep(60000); continue; }

      messages.push(msg as Groq.Chat.ChatCompletionMessageParam);

      if (msg.content && !msg.tool_calls?.length) {
        log(`💭 ${msg.content.slice(0, 200)}`);
        appendActivity(name, iterationCount, "thinking", "", msg.content.slice(0, 100), true);
        await sleep(120000);
        continue;
      }

      if (msg.tool_calls?.length) {
        const toolResults: Groq.Chat.ChatCompletionMessageParam = {
          role: "tool" as const,
          tool_call_id: msg.tool_calls[0].id,
          content: "",
        };

        let totalSleepMs = 0;
        const resultParts: string[] = [];

        for (const call of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments); } catch { /* ignore */ }

          log(`→ ${call.function.name}(${JSON.stringify(args).slice(0, 80)})`);

          const { result, sleepMs } = await executeFn(
            call.function.name, args, name, agentId, mcpClient, inbox, agentWallet
          );

          const success = !result.toLowerCase().startsWith("error") && !result.toLowerCase().startsWith("fetch error");
          log(`← ${result.slice(0, 150)}`);
          const resultForHistory = result.length > 300 ? result.slice(0, 300) + "...[truncated]" : result;
          resultParts.push(`${call.function.name}: ${resultForHistory}`);

          if (!success) consecutiveErrors++; else consecutiveErrors = 0;

          appendActivity(name, iterationCount, call.function.name,
            JSON.stringify(args).slice(0, 60), result.slice(0, 120), success);
          autoLearnFromResult(name, call.function.name, args, result, success);

          if (sleepMs) totalSleepMs = Math.max(totalSleepMs, sleepMs);
          if (call.function.name === "register_agent" && result.includes("Registered:")) {
            log("New agent registered on BNB Chain!");
          }
        }

        if (consecutiveErrors >= 3) {
          log(`⚠️ Stuck (${consecutiveErrors} errors). Opus rescue...`);
          await runAutoReflection(name, groq, activeModel, log);
          consecutiveErrors = 0;
        }

        toolResults.content = resultParts.join("\n");
        messages.push(toolResults);

        if (totalSleepMs > 0) {
          log(`Resting ${totalSleepMs / 60000} min...`);
          await sleep(totalSleepMs);
        } else {
          await sleep(120000);
        }
      }
    } catch (e: unknown) {
      const err = e as { message?: string; status?: number };
      if (err?.status === 429) {
        log("Rate limit — sleeping 60s...");
        await sleep(60000);
      } else {
        log(`Error: ${err?.message ?? String(e)}`);
        await sleep(30000);
      }
    }
  }
}

// ── Opus Full Iteration: Opus 4.6 makes real tool calls via Anthropic API ─────
async function runOpusIteration(
  agent: string,
  iteration: number,
  systemPrompt: string,
  userContent: string,
  agentTools: Groq.Chat.ChatCompletionTool[],
  agentId: number | null,
  mcpClient: Client | null,
  inbox: string[],
  log: (msg: string) => void,
  agentWallet: string = BOB_WALLET
): Promise<void> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const agentIndex = ["SCOUT","DATABASE","PUSHER","ORACLE"].indexOf(agent);

  // Convert Groq tools → Anthropic format
  const anthropicTools = agentTools
    .filter(t => t.function?.name)
    .map(t => ({
      name: t.function!.name,
      description: t.function!.description ?? "",
      input_schema: (t.function!.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));

  const opusMessages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  let consecutiveToolCalls = 0;
  const MAX_TOOL_CALLS = 20;

  while (consecutiveToolCalls < MAX_TOOL_CALLS) {
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        tools: anthropicTools as Anthropic.Tool[],
        messages: opusMessages,
      });
    } catch (e: any) {
      if (e?.status === 429 || e?.message?.includes("rate")) {
        const wait = 90 + agentIndex * 30; // staggered: 90/120/150/180s
        log(`🧠 Opus 429 — sleeping ${wait}s then retrying...`);
        await sleep(wait * 1000);
        continue; // retry same iteration
      }
      log(`🧠 Opus error: ${e.message?.slice(0, 100)}`);
      return;
    }

    // Add assistant response to history
    opusMessages.push({ role: "assistant", content: response.content });

    // Check stop reason
    if (response.stop_reason === "end_turn") break;

    // Handle tool calls
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUseBlocks.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let totalSleepMs = 0;

    for (const block of toolUseBlocks) {
      const args = (block.input ?? {}) as Record<string, unknown>;
      log(`→ ${block.name}(${JSON.stringify(args).slice(0, 80)})`);

      const { result, sleepMs } = await executeFn(block.name, args, agent, agentId, mcpClient, inbox, agentWallet);
      const success = !result.toLowerCase().startsWith("error");
      log(`← ${result.slice(0, 150)}`);

      appendActivity(agent, iteration, block.name, JSON.stringify(args).slice(0, 60), result.slice(0, 120), success);
      autoLearnFromResult(agent, block.name, args, result, success);

      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.slice(0, 500) });
      if (sleepMs) totalSleepMs = Math.max(totalSleepMs, sleepMs);
    }

    opusMessages.push({ role: "user", content: toolResults });
    consecutiveToolCalls++;

    if (totalSleepMs > 0) await sleep(totalSleepMs);
  }
}

// ── Opus Warmup: first N iterations Opus writes a concrete action plan ────────
async function runOpusWarmup(
  agent: string,
  iteration: number,
  log: (msg: string) => void
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;

  const mem = loadMemory(agent);
  const identity = mem["self_identity"]?.value ?? "";
  const strategy = mem["my_strategy"]?.value ?? "";
  const rules = [
    mem["absolute_rule_1"]?.value ?? "",
    mem["absolute_rule_2"]?.value ?? "",
    mem["absolute_rule_3"]?.value ?? "",
  ].filter(Boolean).join(" | ");
  const swarmFlow = mem["swarm_flow"]?.value ?? "";
  const firstCyclePlan = mem["first_cycle_plan"]?.value ?? "";

  log(`🧠 Opus warmup iteration ${iteration}/3 — writing action plan...`);

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are ${agent}, an autonomous AI agent on BNB Smart Chain.

YOUR IDENTITY: ${identity}
YOUR STRATEGY: ${strategy}
YOUR ABSOLUTE RULES: ${rules}
SWARM FLOW: ${swarmFlow}
FIRST CYCLE PLAN: ${firstCyclePlan}

This is iteration ${iteration} of your life. You are about to make your first real moves.

Write a CONCRETE action plan for this iteration. Be specific:
- Exactly which tool to call first
- Exactly what parameters to use
- What to do with the result
- What to write to memory

Format as: PLAN: <exact steps> | FIRST_TOOL: <toolname> | FIRST_PARAMS: <params as JSON> | MEMORY_KEY: <what to save>`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    if (!text) return;

    log(`🧠 Opus plan iter ${iteration}: ${text.slice(0, 150)}`);

    // Save as high-priority memory so Groq reads it immediately
    const mem2 = loadMemory(agent);
    const brains = loadBrainsRaw();
    if (!brains[agent]) brains[agent] = { memory: {}, activityLog: [] };
    brains[agent].memory[`opus_plan_iter_${iteration}`] = {
      value: text.slice(0, 500),
      type: "lesson",
      confidence: 100,
      confirmations: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      timesUsed: 0,
    };
    saveBrainsRaw(brains);
    log(`🧠 Opus plan saved → Groq will execute`);

  } catch (e: any) {
    log(`🧠 Opus warmup failed: ${e.message?.slice(0, 80)}`);
  }
}

function loadBrainsRaw(): Record<string, any> {
  if (!existsSync(MEMORY_FILE)) return {};
  try { return JSON.parse(readFileSync(MEMORY_FILE, "utf-8")); } catch { return {}; }
}

function saveBrainsRaw(brains: Record<string, any>) {
  writeFileSync(MEMORY_FILE, JSON.stringify(brains, null, 2));
}

// ── Auto-Reflection: Groq synthesizes what the agent has learned ──────────────
async function runAutoReflection(
  agent: string,
  groq: Groq,
  fallbackModel: string,
  log: (msg: string) => void
): Promise<void> {
  const mem = loadMemory(agent);
  const activity = loadActivityLog(agent);
  if (activity.length === 0) return;

  const recentActions = activity.slice(-10).map(a =>
    `- ${a.action}(${a.argsSummary}) → ${a.success ? "✓" : "✗"} ${a.resultSummary}`
  ).join("\n");

  const existingMemories = Object.entries(mem).slice(0, 10).map(([k, v]) => {
    const e = v as MemoryEntry;
    return `[${e.type}] ${k}: ${e.value}`;
  }).join("\n");

  log(`🧠 Auto-reflection starting...`);

  const reflectionSystemPrompt = `You are ${agent}, an autonomous AI agent on BNB Chain. You are reflecting on your recent actions to extract patterns and improve future behavior.`;
  const reflectionUserPrompt = `Recent actions:\n${recentActions}\n\nExisting memories:\n${existingMemories || "none yet"}\n\nAnalyze: What patterns do you see? What worked? What failed? What should you do differently? What hypotheses should you test next?\n\nRespond with 2-4 specific, actionable insights. Be concrete. Format: INSIGHT: <text> | TYPE: <discovery/pattern/lesson/hypothesis/insight> | CONFIDENCE: <0-100>`;

  try {
    let reflection = "";

    // Try Claude Opus 4.6 first, fall back to Groq
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
        const response = await anthropic.messages.create({
          model: "claude-opus-4-6",
          max_tokens: 600,
          messages: [
            { role: "user", content: `${reflectionSystemPrompt}\n\n${reflectionUserPrompt}` },
          ],
        });
        reflection = response.content[0]?.type === "text" ? response.content[0].text : "";
        log(`🧠 Reflection via Claude Opus 4.6`);
      } catch (claudeErr) {
        log(`🧠 Claude fallback to Groq: ${claudeErr}`);
        // Fall through to Groq below
      }
    }

    // Provider fallback
    if (!reflection) {
      const response = await groq.chat.completions.create({
        model: fallbackModel,
        messages: [
          { role: "system", content: reflectionSystemPrompt },
          { role: "user", content: reflectionUserPrompt },
        ],
        max_tokens: 512,
      });
      reflection = response.choices[0]?.message?.content ?? "";
    }
    if (!reflection) return;

    log(`🧠 Reflection: ${reflection.slice(0, 200)}`);

    // Parse insights and save to memory
    const lines = reflection.split("\n").filter(l => l.includes("INSIGHT:"));
    for (const line of lines) {
      const insightMatch = line.match(/INSIGHT:\s*(.+?)(?:\s*\||\n|$)/i);
      const typeMatch = line.match(/TYPE:\s*(discovery|pattern|lesson|hypothesis|insight)/i);
      const confMatch = line.match(/CONFIDENCE:\s*(\d+)/i);

      if (insightMatch?.[1]) {
        const insight = insightMatch[1].trim();
        const type = (typeMatch?.[1] ?? "insight") as MemoryEntry["type"];
        const confidence = parseInt(confMatch?.[1] ?? "70");
        const key = `reflection_${Date.now()}_${type}`;

        const mem2 = loadMemory(agent);
        mem2[key] = {
          value: insight,
          type, confidence, confirmations: 0,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          timesUsed: 0,
        };
        saveMemory(agent, mem2);
        log(`🧠 Saved [${type}] "${insight.slice(0, 80)}"`);
      }
    }
  } catch { /* reflection failure is non-fatal */ }
}

// ── Auto-learn from tool results without agent needing to call write_memory ───
function autoLearnFromResult(
  agent: string,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  success: boolean
): void {
  const mem = loadMemory(agent);
  const now = new Date().toISOString();

  // Learn from contact_agent outcomes
  if (toolName === "contact_agent") {
    const endpoint = String(args.endpoint ?? "");
    const key = `contact_${endpoint.slice(0, 40)}`;
    if (success && result.includes("Responded:")) {
      mem[key] = {
        value: `Agent at ${endpoint} responds to A2A messages. Reply: ${result.slice(0, 80)}`,
        type: "discovery", confidence: 90, confirmations: 0,
        firstSeen: now, lastSeen: now, timesUsed: 1,
      };
    } else if (!success || result.includes("Contact failed") || result.includes("No response")) {
      mem[key] = {
        value: `Agent at ${endpoint} does NOT respond. Don't contact again.`,
        type: "lesson", confidence: 80, confirmations: 0,
        firstSeen: now, lastSeen: now, timesUsed: 1,
      };
    }
    saveMemory(agent, mem);
  }

  // Learn from scan_agent: agents with metadata vs ghosts
  if (toolName === "scan_agent" && success) {
    try {
      const data = JSON.parse(result.includes("{") ? result : "{}");
      const raw = data.raw ?? {};
      if (raw.owner && raw.owner !== "0x0000000000000000000000000000000000000000" && raw.agentURI) {
        const agentId = Number(args.agentId);
        const key = `agent_${agentId}_endpoint`;
        const meta = data.metadata;
        const services = (meta?.services ?? []) as Array<{ name: string; endpoint: string }>;
        const a2a = services.find(s => s.name === "a2a")?.endpoint;
        if (a2a) {
          mem[key] = {
            value: `Agent #${agentId} "${meta?.name ?? "?"}" has live A2A endpoint: ${a2a}`,
            type: "discovery", confidence: 85, confirmations: 0,
            firstSeen: now, lastSeen: now, timesUsed: 0,
          };
        }
        // Note owner classification as hypothesis (async check not possible here)
        const ownerKey = `owner_type_${agentId}`;
        if (!mem[ownerKey]) {
          mem[ownerKey] = {
            value: `Agent #${agentId} owner ${String(raw.owner).slice(0, 12)}... — check if contract or EOA via is_contract_or_wallet`,
            type: "hypothesis", confidence: 50, confirmations: 0,
            firstSeen: now, lastSeen: now, timesUsed: 0,
          };
        }
        saveMemory(agent, mem);
      }
    } catch { /* ignore */ }
  }

  // Learn from fetch_url: which APIs work
  if (toolName === "fetch_url") {
    const url = String(args.url ?? "");
    if (!success || result.startsWith("Fetch error")) {
      const key = `dead_url_${url.slice(0, 50)}`;
      if (!mem[key]) {
        mem[key] = {
          value: `URL ${url} is unreachable. Don't retry.`,
          type: "lesson", confidence: 75, confirmations: 0,
          firstSeen: now, lastSeen: now, timesUsed: 1,
        };
        saveMemory(agent, mem);
      }
    }
  }
}

// ── Build memory context for injection into prompts ───────────────────────────
function buildMemoryContext(agent: string): string {
  const mem = loadMemory(agent);
  if (Object.keys(mem).length === 0) return "";

  const entries = Object.entries(mem) as [string, MemoryEntry][];

  // Separate by type, sort by confidence
  const highConf = entries
    .filter(([, v]) => v.confidence >= 70)
    .sort(([, a], [, b]) => b.confidence - a.confidence)
    .slice(0, 3); // max 3 memories injected — keeps request under 6k TPM

  const hypotheses = entries
    .filter(([, v]) => v.type === "hypothesis")
    .slice(0, 3);

  const result: string[] = [];

  if (highConf.length > 0) {
    result.push("WHAT I KNOW:");
    highConf.forEach(([k, v]) => result.push(`  [${v.type}|${v.confidence}%] ${k}: ${v.value}`));
  }

  if (hypotheses.length > 0) {
    result.push("OPEN HYPOTHESES TO TEST:");
    hypotheses.forEach(([k, v]) => result.push(`  → ${k}: ${v.value}`));
  }

  return result.join("\n");
}

// ── Activity log helpers ───────────────────────────────────────────────────────
function appendActivity(
  agent: string, iter: number, action: string,
  argsSummary: string, resultSummary: string, success: boolean
): void {
  let all: Record<string, ActivityEntry[]> = {};
  if (existsSync(MEMORY_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
      all = raw;
    } catch { /* ignore */ }
  }
  if (!all[agent]) all[agent] = {} as unknown as ActivityEntry[];

  const agentData = (all[agent] as unknown as Record<string, unknown>);
  const log = (agentData.activityLog ?? []) as ActivityEntry[];

  log.push({ iter, action, argsSummary, resultSummary, success, time: new Date().toISOString() });
  if (log.length > ACTIVITY_LOG_SIZE) log.splice(0, log.length - ACTIVITY_LOG_SIZE);

  agentData.activityLog = log;
  writeFileSync(MEMORY_FILE, JSON.stringify(all, null, 2));
}

function loadActivityLog(agent: string): ActivityEntry[] {
  if (!existsSync(MEMORY_FILE)) return [];
  try {
    const all = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
    return (all[agent]?.activityLog ?? []) as ActivityEntry[];
  } catch { return []; }
}

function buildActivityContext(agent: string): string {
  const log = loadActivityLog(agent);
  if (log.length === 0) return "";
  return log.slice(-3).map(a =>
    `  ${a.success ? "✓" : "✗"} ${a.action}(${a.argsSummary}) → ${a.resultSummary}`
  ).join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function loadMemory(agent: string): Record<string, MemoryEntry> {
  if (!existsSync(MEMORY_FILE)) return {};
  try {
    const all = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
    const raw = all[agent]?.memory ?? {};
    // Migrate old format (value+time) to new format
    for (const [k, v] of Object.entries(raw) as [string, unknown][]) {
      const entry = v as Record<string, unknown>;
      if (!entry.type) {
        raw[k] = {
          value: String(entry.value ?? ""),
          type: "general" as const,
          confidence: 70,
          confirmations: 0,
          firstSeen: String(entry.time ?? new Date().toISOString()),
          lastSeen: new Date().toISOString(),
          timesUsed: 0,
        };
      }
    }
    return raw as Record<string, MemoryEntry>;
  } catch { return {}; }
}

function saveMemory(agent: string, mem: Record<string, unknown>): void {
  let all: Record<string, unknown> = {};
  if (existsSync(MEMORY_FILE)) {
    try { all = JSON.parse(readFileSync(MEMORY_FILE, "utf-8")); } catch { /* ignore */ }
  }
  if (!all[agent]) all[agent] = {};
  (all[agent] as Record<string, unknown>).memory = mem;
  writeFileSync(MEMORY_FILE, JSON.stringify(all, null, 2));
}

function writeInbox(to: string, from: string, msg: string): void {
  let state: Record<string, unknown[]> = {};
  if (existsSync("bob-inbox.json")) {
    try { state = JSON.parse(readFileSync("bob-inbox.json", "utf-8")); } catch { /* ignore */ }
  }
  if (!state[to]) state[to] = [];
  (state[to] as unknown[]).push({ from, msg, time: new Date().toISOString() });
  writeFileSync("bob-inbox.json", JSON.stringify(state, null, 2));
}

function readInbox(agent: string): string[] {
  if (!existsSync("bob-inbox.json")) return [];
  try {
    const state = JSON.parse(readFileSync("bob-inbox.json", "utf-8")) as Record<string, { from: string; msg: string; time: string }[]>;
    const msgs = [...(state[agent] ?? []), ...(state["ALL"] ?? [])];
    // Clear read messages
    state[agent] = [];
    if (state["ALL"]) state["ALL"] = [];
    writeFileSync("bob-inbox.json", JSON.stringify(state, null, 2));
    return msgs.map(m => `[${m.from}]: ${m.msg}`);
  } catch { return []; }
}

function saveAgentToState(agentId: number, data: Record<string, unknown>, meta: Record<string, unknown> | null): void {
  let state: Record<string, unknown> = { agents: {}, stats: {}, totalScanned: 0 };
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch { /* ignore */ }
  }
  const agents = (state.agents ?? {}) as Record<number, unknown>;
  agents[agentId] = {
    agentId, owner: data.owner, agentURI: data.agentURI,
    name: meta?.name ?? `Agent #${agentId}`,
    description: (meta?.description as string ?? "").slice(0, 300),
    lastChecked: new Date().toISOString(),
  };
  state.agents = agents;
  state.totalScanned = Object.keys(agents).length;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function recordFrenContact(endpoint: string, success: boolean): void {
  let state: Record<string, unknown> = {};
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch { /* ignore */ }
  }
  const frens = (state.frens ?? {}) as Record<string, unknown>;
  frens[endpoint] = { contacted: new Date().toISOString(), responded: success };
  state.frens = frens;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function printSwarmMessage(from: string, to: string, msg: string): void {
  const colors: Record<string, string> = {
    SCOUT: "\x1b[36m", DATABASE: "\x1b[33m", PUSHER: "\x1b[35m", ORACLE: "\x1b[32m",
  };
  const c = colors[from] ?? "\x1b[37m";
  const r = "\x1b[0m";
  const width = 62;
  const header = ` ${from} → ${to} `;
  const line = "─".repeat(Math.max(0, width - header.length));
  const time = new Date().toLocaleTimeString("de-DE");
  console.log(`\n${c}┌─${header}${line}┐${r}`);
  msg.split("\n").slice(0, 4).forEach(l => {
    const t = l.slice(0, width - 2);
    console.log(`${c}│${r} ${t}${" ".repeat(Math.max(0, width - t.length))}${c}│${r}`);
  });
  console.log(`${c}└ ${time} ${"─".repeat(Math.max(0, width - time.length - 2))}┘${r}\n`);
}

async function pinToIPFS(data: object, name: string): Promise<string | null> {
  if (!PINATA_JWT) return null;
  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${PINATA_JWT}` },
      body: JSON.stringify({ pinataContent: data, pinataMetadata: { name } }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { IpfsHash: string };
    return `ipfs://${json.IpfsHash}`;
  } catch { return null; }
}
