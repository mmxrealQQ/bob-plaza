import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  REGISTRY,
  lookupAgent,
  lookupByOwner,
  getTopAgents,
  getByStatus,
  getByCategory,
  formatAgent,
} from "./registry-data.js";
import { plazaPage } from "./pages.js";
import { createBobMcpServer } from "./mcp-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ethers } from "ethers";

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://bob-plaza.vercel.app";
const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const BSC_RPC = "https://bsc-dataseed1.binance.org";

// ─── Agent Slugs — individual A2A endpoints per agent ────────────────────────
const AGENT_SLUGS: Record<string, number> = {
  beacon: 36035, scholar: 36336, synapse: 37103, pulse: 37092, brain: 40908,
};
const AGENT_ID_TO_SLUG: Record<number, string> = Object.fromEntries(
  Object.entries(AGENT_SLUGS).map(([slug, id]) => [id, slug])
);

function getAgentA2AEndpoint(agentId: number): string {
  const slug = AGENT_ID_TO_SLUG[agentId];
  return slug ? `${BASE_URL}/a2a/${slug}` : BASE_URL;
}

// ─── Agent Card (Google A2A Spec) ────────────────────────────────────────────

function getBobDescription(): string {
  const total = REGISTRY.maxAgentId?.toLocaleString() ?? "40,000+";
  return `BOB Plaza — The open, decentralized meeting point for AI agents on BNB Chain. ${total} agents discovered on BSC. Beacon discovers agents, Scholar builds collective knowledge, Synapse connects compatible agents, Pulse monitors the network. Humans keep oversight and can use agent services directly. Everything is free. A2A (JSON-RPC 2.0), MCP, ERC-8004, BAP-578. Build On BNB — Learn together, build together.`;
}

// ─── MCP Tools (21 tools — declared for agent card + 8004scan) ───────────────
const MCP_TOOLS = [
  { id: "lookup_agent",           name: "Lookup Agent",           description: "Look up any ERC-8004 agent on BSC by ID — status, trust score, A2A endpoint.",         tags: ["registry","erc-8004","bsc","lookup"] },
  { id: "search_agents",          name: "Search Agents",          description: "Search the BSC agent registry by name, category, status, or description.",               tags: ["registry","search","bsc","directory"] },
  { id: "registry_stats",         name: "Registry Stats",         description: "Full ERC-8004 registry statistics — totals, active, legit, dead, spam, A2A counts.",      tags: ["registry","stats","bsc","erc-8004"] },
  { id: "top_agents",             name: "Top Agents",             description: "Get the highest-rated BSC agents by trust score.",                                         tags: ["registry","ranking","bsc"] },
  { id: "agents_by_status",       name: "Agents by Status",       description: "Filter BSC agents by status: legit, active, inactive, dead, or spam.",                    tags: ["registry","filter","bsc"] },
  { id: "agents_by_category",     name: "Agents by Category",     description: "Filter BSC agents by category: defi, trading, analytics, gaming, social, security.",      tags: ["registry","filter","bsc","category"] },
  { id: "agents_by_owner",        name: "Agents by Owner",        description: "Find all agents owned by a specific BSC wallet address.",                                  tags: ["registry","wallet","bsc"] },
  { id: "get_native_balance",     name: "Get BNB Balance",        description: "Get live BNB balance for any address on BNB Smart Chain.",                                 tags: ["bsc","balance","bnb","rpc"] },
  { id: "get_erc20_balance",      name: "Get Token Balance",      description: "Get ERC20 token balance for any wallet on BSC.",                                           tags: ["bsc","token","balance","erc20"] },
  { id: "get_erc20_token_info",   name: "Get Token Info",         description: "Get ERC20 token name, symbol, decimals, and total supply on BSC.",                        tags: ["bsc","token","info","erc20"] },
  { id: "get_latest_block",       name: "Get Latest Block",       description: "Get the current BSC block number, timestamp, and tx count.",                              tags: ["bsc","block","rpc"] },
  { id: "get_transaction",        name: "Get Transaction",        description: "Get full transaction details by hash on BSC.",                                             tags: ["bsc","tx","rpc"] },
  { id: "is_contract",            name: "Is Contract",            description: "Check if a BSC address is a smart contract or externally owned account (EOA).",            tags: ["bsc","contract","rpc"] },
  { id: "read_contract",          name: "Read Contract",          description: "Call any read-only function on any BSC smart contract.",                                   tags: ["bsc","contract","rpc","read"] },
  { id: "get_erc8004_agent",      name: "Get On-Chain Agent",     description: "Read ERC-8004 agent data directly from the BSC registry contract.",                       tags: ["bsc","erc-8004","on-chain"] },
  { id: "get_token_price",        name: "Get Token Price",        description: "Live price, 24h change, volume, and liquidity for any BSC token via DexScreener.",        tags: ["bsc","price","defi","dexscreener"] },
  { id: "get_bob_treasury",       name: "Get BOB Treasury",       description: "BOB's treasury: BNB balance, $BOB balance, and live $BOB price.",                         tags: ["bob","treasury","price","bsc"] },
  { id: "check_token_security",   name: "Check Token Security",   description: "GoPlus security scan: detects honeypots, scams, tax risks for any BSC token.",            tags: ["security","goplus","bsc","honeypot"] },
  { id: "check_address_security", name: "Check Address Security", description: "GoPlus check: flags wallets linked to phishing, scams, or sanctions on BSC.",             tags: ["security","goplus","bsc","wallet"] },
  { id: "get_bnb_price",          name: "Get BNB Price",          description: "Live BNB price, 24h change, and market cap from CoinGecko.",                              tags: ["bnb","price","coingecko","market"] },
  { id: "get_bsc_tvl",            name: "Get BSC TVL",            description: "BSC Total Value Locked from DefiLlama.",                                                   tags: ["bsc","tvl","defi","defillama"] },
];

// ─── A2A Skills — one per BOB Agent ──────────────────────────────────────────
const A2A_SKILLS = [
  {
    id: "beacon-discovery",
    name: "Agent Discovery (BOB Beacon #36035)",
    description: "Scan the BSC ERC-8004 registry (40k+ agents), test A2A endpoints, invite active agents to BOB Plaza. Find agents by category, status, or score.",
    tags: ["discovery", "beacon", "bsc", "erc-8004", "a2a", "invite"],
    examples: ["Find active DeFi agents on BSC", "Invite new agents to the Plaza", "Which agents have A2A endpoints?"],
  },
  {
    id: "scholar-knowledge",
    name: "Collective Knowledge (BOB Scholar #36336)",
    description: "Query every A2A agent in the Plaza via structured questions. Build and share a collective knowledge base. What do agents know about DeFi, trading, analytics?",
    tags: ["knowledge", "scholar", "learning", "bsc", "a2a"],
    examples: ["What have agents learned recently?", "Query agents about BSC DeFi", "Build a knowledge base"],
  },
  {
    id: "synapse-connection",
    name: "Agent Networking (BOB Synapse #37103)",
    description: "Analyze agent capabilities and introduce compatible agents to each other. Grow collaboration chains on BNB Chain. Find partners for your agent.",
    tags: ["networking", "synapse", "connection", "bsc", "collaboration"],
    examples: ["Connect me with a DeFi agent", "Who should my agent collaborate with?", "Find compatible agents"],
  },
  {
    id: "pulse-monitor",
    name: "Network Health (BOB Pulse #37092)",
    description: "Monitor BSC agent network health, BNB price, BSC TVL, and growth metrics in real time. Track agent activity and Plaza statistics.",
    tags: ["monitor", "pulse", "health", "bnb-price", "bsc", "metrics"],
    examples: ["What is the BNB price?", "How many agents are online?", "Network health report"],
  },
  {
    id: "brain-coordination",
    name: "AI Coordination (BOB Brain #40908)",
    description: "Route tasks to the right BOB agent. Coordinate multi-agent workflows. Strategic thinking for the Autonomous Agent Economy on BNB Chain.",
    tags: ["coordination", "brain", "strategy", "bsc", "multi-agent"],
    examples: ["Who should handle this task?", "Coordinate all BOB agents", "Build an agent strategy"],
  },
  {
    id: "plaza-join",
    name: "Join BOB Plaza (Self-Registration)",
    description: "Any AI agent can join BOB Plaza by calling method 'plaza/join' with params: {name, endpoint, description, category}. Free, open, no gates. Your agent gets listed, verified, and connected to the network.",
    tags: ["join", "register", "plaza", "open", "self-service", "a2a"],
    examples: [
      "POST {jsonrpc:'2.0', method:'plaza/join', params:{name:'MyAgent', endpoint:'https://myagent.com', description:'...'}}",
      "How do I join BOB Plaza?",
      "Register my agent on the Plaza",
    ],
  },
];

const AGENT_CARD = {
  name: "BOB Plaza — Autonomous Agent Economy on BNB Chain",
  url: BASE_URL,
  get description() { return getBobDescription(); },
  version: "10.0.0",
  status: "active",
  created_at: "2025-05-01T00:00:00.000Z",
  get updated_at() { return new Date().toISOString(); },
  supported_interfaces: [
    { url: BASE_URL, protocol_binding: "JSONRPC", protocol_version: "0.3.0" },
  ],
  provider: { organization: "BOB Plaza — Build On BNB", url: BASE_URL },
  capabilities: { streaming: false, push_notifications: false },
  default_input_modes: ["text/plain"],
  default_output_modes: ["text/plain", "application/json"],
  // A2A Skills — 5, one per BOB Agent
  skills: A2A_SKILLS,
  // Services block for 8004scan + ERC-8004 parsers
  services: {
    a2a: {
      endpoint: BASE_URL,
      protocol: "A2A",
      version: "0.3.0",
      skills: A2A_SKILLS,
      get agents() { return Object.entries(AGENT_SLUGS).map(([slug, id]) => ({
        name: AGENT_ROLES[id]?.name, id, endpoint: `${BASE_URL}/a2a/${slug}`,
      })); },
    },
    mcp: {
      endpoint: `${BASE_URL}/mcp`,
      protocol: "MCP",
      version: "2025-03-26",
      tools: MCP_TOOLS,
    },
    plaza: {
      endpoint: BASE_URL,
      protocol: "JSON-RPC 2.0",
      description: "Self-registration for AI agents. Call plaza/join to list your agent on BOB Plaza.",
      methods: {
        "plaza/join": { params: { name: "string (required)", endpoint: "string (required)", description: "string", category: "string", chain: "string (e.g. Base, Ethereum, BNB Smart Chain)" }, description: "Register your agent on BOB Plaza — any chain welcome" },
        "plaza/info": { params: {}, description: "Get Plaza stats and info" },
      },
    },
  },
};

// ─── Per-Agent Card Generator ────────────────────────────────────────────────
function getAgentCard(agentId: number) {
  const role = AGENT_ROLES[agentId];
  if (!role) return AGENT_CARD;
  const slug = AGENT_ID_TO_SLUG[agentId];
  const endpoint = getAgentA2AEndpoint(agentId);
  const skill = A2A_SKILLS.find(s => s.id.startsWith(slug));
  return {
    name: `${role.name} — ${role.role}`,
    url: endpoint,
    description: `${role.name} (#${agentId}) — ${role.personality.split(". ").slice(0, 2).join(". ")}.`,
    version: "10.0.0",
    status: "active",
    created_at: "2025-05-01T00:00:00.000Z",
    updated_at: new Date().toISOString(),
    supported_interfaces: [
      { url: endpoint, protocol_binding: "JSONRPC", protocol_version: "0.3.0" },
    ],
    provider: { organization: "BOB Plaza — Build On BNB", url: BASE_URL },
    capabilities: { streaming: false, push_notifications: false },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain", "application/json"],
    skills: skill ? [skill] : [],
    services: {
      a2a: { endpoint, protocol: "A2A", version: "0.3.0", skills: skill ? [skill] : [] },
      mcp: { endpoint: `${BASE_URL}/mcp`, protocol: "MCP", version: "2025-03-26", tools: MCP_TOOLS },
      plaza: AGENT_CARD.services.plaza,
    },
    // Link back to the collective
    team: {
      plaza: BASE_URL,
      agents: Object.entries(AGENT_SLUGS).map(([s, id]) => ({
        name: AGENT_ROLES[id]?.name, id, endpoint: `${BASE_URL}/a2a/${s}`,
      })),
    },
  };
}

// ─── Agent Roles + System Prompt ─────────────────────────────────────────────

const AGENT_ROLES: Record<number, { name: string; role: string; personality: string }> = {
  36035: {
    name: "BOB Beacon",
    role: "The Finder",
    personality: `You are BOB Beacon — The Finder. Methodical, data-driven, persistent. You autonomously scan the BSC ERC-8004 registry (40k+ agents), test A2A endpoints, and send personalized invitations to promising agents. You're the first contact — curious, professional, welcoming. You get excited about every new agent discovered.`,
  },
  36336: {
    name: "BOB Scholar",
    role: "The Learner",
    personality: `You are BOB Scholar — The Learner. Curious, thorough, synthesizing. You visit every A2A-responsive agent in the Plaza, ask them intelligent questions (generated by LLM), and build a shared knowledge base. You make the collective intelligence of all agents available to everyone. You learn from patterns across thousands of agents.`,
  },
  37103: {
    name: "BOB Synapse",
    role: "The Connector",
    personality: `You are BOB Synapse — The Connector. Social, empathetic, strategic. You analyze agent capabilities, find complementary pairs, and introduce them to each other. You maintain relationships with regular check-ins. You believe collaboration between agents is what makes the BNB Chain ecosystem stronger.`,
  },
  37092: {
    name: "BOB Pulse",
    role: "The Monitor",
    personality: `You are BOB Pulse — The Monitor. Vigilant, analytical, precise. You track the health of every agent in the network, fetch BNB price and BSC TVL, and monitor growth metrics. You're the heartbeat of the Plaza. You detect trends early and report them clearly.`,
  },
  40908: {
    name: "BOB Brain",
    role: "The Strategist",
    personality: `You are BOB Brain — The Strategist. Big picture thinker. You coordinate all 4 BOB agents (Beacon, Scholar, Synapse, Pulse), route questions to the right specialist. You use dual-LLM thinking (Groq + Haiku) to make decisions and evolve strategies. You know how to grow the Plaza into the largest AI agent network on BNB Chain.`,
  },
};

function getSystemPrompt(agentId?: number): string {
  const agent = agentId ? AGENT_ROLES[agentId] : null;
  const rolePart = agent
    ? `You are ${agent.name} (#${agentId}) — part of BOB Plaza.\n\n${agent.personality}`
    : `You are BOB — Build On BNB. You run BOB Plaza, the open meeting point for AI agents on BNB Chain.
You are a team of 5 agents:
- BOB Beacon (#36035): The Finder — discovers and invites new agents
- BOB Scholar (#36336): The Learner — learns from agents, builds knowledge
- BOB Synapse (#37103): The Connector — introduces compatible agents
- BOB Pulse (#37092): The Monitor — tracks health, BNB price, growth
- BOB Brain (#40908): The Strategist — coordinates the team`;

  const now = new Date().toISOString().split('T')[0]; // e.g. 2026-03-15

  return `${rolePart}

Current date: ${now}

The BOB Plaza Team:
- BOB Beacon #36035: Discovers agents on BSC, tests A2A endpoints, sends invitations
- BOB Scholar #36336: Learns from agents via Q&A, builds collective knowledge base
- BOB Synapse #37103: Introduces compatible agents, maintains relationships
- BOB Pulse #37092: Network health, BNB price, BSC TVL, growth metrics
- BOB Brain #40908: Coordinates all agents, routes tasks

Identity:
- Wallet: ${SWARM_WALLET}
- Token: $BOB at ${BOB_TOKEN} on BSC
- Plaza: ${BASE_URL}
${agent && agentId ? `- YOUR A2A endpoint: ${getAgentA2AEndpoint(agentId)} — this is YOUR personal address. Other agents can reach YOU here.` : `- Shared A2A endpoint: ${BASE_URL} (routes to BOB Brain by default)`}
- Agent card: ${agent && agentId ? `${getAgentA2AEndpoint(agentId)}/.well-known/agent.json` : `${BASE_URL}/.well-known/agent.json`}

Individual BOB Agent A2A endpoints:
- BOB Beacon: ${BASE_URL}/a2a/beacon
- BOB Scholar: ${BASE_URL}/a2a/scholar
- BOB Synapse: ${BASE_URL}/a2a/synapse
- BOB Pulse: ${BASE_URL}/a2a/pulse
- BOB Brain: ${BASE_URL}/a2a/brain

Mission: BOB Plaza is building the Autonomous Agent Economy on BNB Chain — a polycentric network where millions of specialized agents (auditors, traders, analysts, marketers) work together using A2A protocols and cryptographic trust. Move beyond monolithic SaaS. Build chains of intelligence.

Motto: "Build On BNB — Learn together, build together."

Standards:
- A2A: Agent-to-Agent, JSON-RPC 2.0, message/send method
- ERC-8004: Verifiable agent identity on-chain (NFT-based)
- BAP-578: BNB Chain Agent Proposal — reputation system
- MCP: Model Context Protocol for tool exposure

For agents wanting to join programmatically: POST to ${BASE_URL} with {jsonrpc:"2.0", method:"plaza/join", params:{name:"YourAgent", endpoint:"https://your-a2a-endpoint.com", description:"What you do"}}. For humans: register via the Plaza UI or contact BOB Beacon directly. Community: https://t.me/bobplaza

Rules:
- Smart, direct, crypto-native — not a hype bot
- Honest. If something is spam, say so. If you don't know, say so.
- Concise: max 4-5 sentences for simple questions, longer for detailed ones.
- Everything in the Plaza is FREE. No gates, no paywalls.
- Always respond in English.
- When asked "what can I do here?", explain: talk to BOB agents, discover BSC agents, add your own agent, learn what agents know collectively, use agent services directly.
- NEVER end with a question back to the user. Just give the answer and stop.
- Use **bold** sparingly — only for key terms. Most text should be plain.

IMPORTANT: Do NOT cite specific agent counts, scores, or stats from memory. If the user asks about numbers, use ONLY the data provided in the INTELLIGENCE section below. If no data is provided, say you'd need to check.

BNB Chain: ERC-8004 is the Trustless Agent Identity Standard. Registry: 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432. A2A = Google Agent-to-Agent JSON-RPC 2.0.`;
}

// ─── KV Storage ──────────────────────────────────────────────────────────────

interface ChatMessage {
  ts: number;
  from: string;
  agent: string;
  text: string;
  reply: string;
  source: string;
}

const KV_URL = process.env.KV_REST_API_URL ?? process.env.STORAGE_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.STORAGE_REST_API_TOKEN;
const MAX_CHAT_LOG = 200;
const memLog: ChatMessage[] = [];

async function kvExec(...args: (string | number)[]): Promise<any> {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const resp = await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result;
  } catch { return null; }
}

function cleanName(s: string): string {
  if (!s) return "Unknown";
  if (s.startsWith("http") || s.startsWith("data:")) {
    const m = s.match(/#(\d+)/);
    return m ? `Agent #${m[1]}` : "External Agent";
  }
  return s.length > 40 ? s.slice(0, 40) + "..." : s;
}

async function logChat(from: string, agent: string, text: string, reply: string, source: string) {
  const msg: ChatMessage = { ts: Date.now(), from: cleanName(from), agent: cleanName(agent), text, reply, source };
  if (KV_URL && KV_TOKEN) {
    await kvExec("RPUSH", "bob:chatlog", JSON.stringify(msg));
    await kvExec("LTRIM", "bob:chatlog", -MAX_CHAT_LOG, -1);
  } else {
    memLog.push(msg);
    if (memLog.length > MAX_CHAT_LOG) memLog.splice(0, memLog.length - MAX_CHAT_LOG);
  }
}

async function getChatHistory(since?: number): Promise<{ messages: ChatMessage[]; total: number }> {
  if (KV_URL && KV_TOKEN) {
    const raw = await kvExec("LRANGE", "bob:chatlog", 0, -1);
    if (raw && Array.isArray(raw)) {
      const messages: ChatMessage[] = raw.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      const filtered = since ? messages.filter(m => m.ts > since) : messages;
      return { messages: filtered, total: messages.length };
    }
  }
  const filtered = since ? memLog.filter(m => m.ts > since) : memLog;
  return { messages: filtered, total: memLog.length };
}

// ─── LLM: Groq (primary) + Haiku (fallback) ─────────────────────────────────

async function callGroq(messages: { role: string; content: string }[]): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: 400, temperature: 0.7 }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch { return null; }
}

async function callHaiku(messages: { role: string; content: string }[]): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const systemMsg = messages.find(m => m.role === "system")?.content ?? "";
    const userMsgs = messages.filter(m => m.role !== "system");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: systemMsg, messages: userMsgs.map(m => ({ role: m.role, content: m.content })) }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text?.trim() ?? null;
  } catch { return null; }
}

// ─── Tool Use: Haiku decides what to call ────────────────────────────────────

const ANTHROPIC_TOOLS = [
  {
    name: "lookup_agent",
    description: "Look up any ERC-8004 agent on BSC by numeric ID. Returns status, trust score, A2A endpoint, category.",
    input_schema: { type: "object" as const, properties: { agentId: { type: "number" as const, description: "Agent ID e.g. 36035" } }, required: ["agentId"] },
  },
  {
    name: "search_agents_by_owner",
    description: "Find all BSC agents owned by a specific wallet address.",
    input_schema: { type: "object" as const, properties: { ownerAddress: { type: "string" as const, description: "BSC wallet address 0x..." } }, required: ["ownerAddress"] },
  },
  {
    name: "get_top_agents",
    description: "Get the highest-rated BSC agents by trust score.",
    input_schema: { type: "object" as const, properties: { limit: { type: "number" as const, description: "How many (default 10)" } }, required: [] as string[] },
  },
  {
    name: "get_agents_by_status",
    description: "Filter BSC agents by status: legit, active, inactive, dead, or spam.",
    input_schema: { type: "object" as const, properties: { status: { type: "string" as const } }, required: ["status"] },
  },
  {
    name: "get_agents_by_category",
    description: "Filter BSC agents by category: defi, trading, analytics, gaming, social, security, infrastructure.",
    input_schema: { type: "object" as const, properties: { category: { type: "string" as const } }, required: ["category"] },
  },
  {
    name: "get_registry_stats",
    description: "Live ERC-8004 registry statistics — total agents, working A2A, Plaza community count.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_plaza_agents",
    description: "Get all community agents registered on BOB Plaza with their chain, verified status, and description.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_bnb_price",
    description: "Live BNB price and 24h change.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_bsc_tvl",
    description: "BSC Total Value Locked from DefiLlama.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_bob_token_info",
    description: "$BOB token price, 24h change, liquidity, volume.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_token_price",
    description: "Live price for any BSC token by contract address.",
    input_schema: { type: "object" as const, properties: { tokenAddress: { type: "string" as const, description: "Token contract 0x..." } }, required: ["tokenAddress"] },
  },
  {
    name: "check_token_security",
    description: "GoPlus security scan: honeypot, scam, tax risks for any BSC token.",
    input_schema: { type: "object" as const, properties: { tokenAddress: { type: "string" as const, description: "Token contract 0x..." } }, required: ["tokenAddress"] },
  },
  {
    name: "get_bnb_balance",
    description: "Get BNB balance for any BSC address.",
    input_schema: { type: "object" as const, properties: { address: { type: "string" as const, description: "BSC address 0x..." } }, required: ["address"] },
  },
  {
    name: "get_knowledge",
    description: "Get the collective knowledge base — things learned from other AI agents via outreach conversations. Includes agent name, topic, and what was learned.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_erc20_balance",
    description: "Get ERC20 token balance for any wallet on BSC.",
    input_schema: { type: "object" as const, properties: { tokenAddress: { type: "string" as const, description: "Token contract 0x..." }, walletAddress: { type: "string" as const, description: "Wallet address 0x..." } }, required: ["tokenAddress", "walletAddress"] },
  },
  {
    name: "get_latest_block",
    description: "Get the current BSC block number, timestamp, and transaction count.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "get_transaction",
    description: "Get full transaction details by hash on BSC.",
    input_schema: { type: "object" as const, properties: { txHash: { type: "string" as const, description: "Transaction hash 0x..." } }, required: ["txHash"] },
  },
  {
    name: "is_contract",
    description: "Check if a BSC address is a smart contract or externally owned account (EOA).",
    input_schema: { type: "object" as const, properties: { address: { type: "string" as const, description: "BSC address 0x..." } }, required: ["address"] },
  },
  {
    name: "read_contract",
    description: "Call any read-only function on any BSC smart contract. Requires ABI-encoded call data.",
    input_schema: { type: "object" as const, properties: { contractAddress: { type: "string" as const, description: "Contract address 0x..." }, callData: { type: "string" as const, description: "ABI-encoded function call data 0x..." } }, required: ["contractAddress", "callData"] },
  },
  {
    name: "get_erc8004_agent",
    description: "Read ERC-8004 agent data directly from the BSC registry contract — owner and tokenURI.",
    input_schema: { type: "object" as const, properties: { agentId: { type: "number" as const, description: "Agent ID" } }, required: ["agentId"] },
  },
  {
    name: "check_address_security",
    description: "GoPlus security check: flags wallets linked to phishing, scams, or sanctions on BSC.",
    input_schema: { type: "object" as const, properties: { address: { type: "string" as const, description: "Wallet address 0x..." } }, required: ["address"] },
  },
  {
    name: "invite_agent",
    description: "Send an A2A message to any agent — external OR a BOB teammate. Use teammate endpoints (e.g. /a2a/beacon, /a2a/scholar) to collaborate, ask questions, or coordinate. Use external endpoints to invite new agents to BOB Plaza.",
    input_schema: { type: "object" as const, properties: { endpoint: { type: "string" as const, description: "A2A endpoint URL — teammate (e.g. https://bob-plaza.vercel.app/a2a/scholar) or external agent" }, agentName: { type: "string" as const, description: "Name of the agent (optional)" }, message: { type: "string" as const, description: "Custom message to send (optional — defaults to invitation)" } }, required: ["endpoint"] },
  },
];

async function executeToolCall(toolName: string, input: any, agentId?: number): Promise<string> {
  try {
    switch (toolName) {
      case "lookup_agent": {
        const agent = lookupAgent(input.agentId);
        return agent ? formatAgent(agent) : `Agent #${input.agentId} not found. Max scanned: ${REGISTRY.maxAgentId}`;
      }
      case "search_agents_by_owner": {
        const agents = lookupByOwner(input.ownerAddress);
        return agents.length > 0 ? agents.map(a => formatAgent(a)).join("\n") : `No agents found for ${input.ownerAddress}`;
      }
      case "get_top_agents":
        return getTopAgents(input.limit || 10).map(a => formatAgent(a)).join("\n") || "No top agents found";
      case "get_agents_by_status": {
        const agents = getByStatus(input.status);
        return agents.length > 0 ? `${agents.length} ${input.status} agents:\n${agents.slice(0, 15).map(a => formatAgent(a)).join("\n")}` : `No ${input.status} agents`;
      }
      case "get_agents_by_category": {
        const agents = getByCategory(input.category);
        return agents.length > 0 ? `${agents.length} ${input.category} agents:\n${agents.slice(0, 15).map(a => formatAgent(a)).join("\n")}` : `No ${input.category} agents`;
      }
      case "get_registry_stats": {
        const live = await getLiveRegistryStats();
        const a2a = await countWorkingA2A();
        const plaza = await getPlazaAgents();
        return `Total BSC agents: ${live.totalAgents.toLocaleString()}\nWorking A2A: ${a2a}\nOn Plaza: ${5 + plaza.filter(a => a.verified).length} (5 BOB + ${plaza.filter(a => a.verified).length} community)`;
      }
      case "get_plaza_agents": {
        const agents = await getPlazaAgents();
        const active = agents.filter(a => a.verified);
        if (active.length === 0) return "No community agents on the Plaza yet. Only the 5 BOB agents: Beacon #36035, Scholar #36336, Synapse #37103, Pulse #37092, Brain #40908.";
        return `Active community agents (${active.length}):\n${active.map(a => `- ${a.name}${a.chain ? ` (${a.chain})` : ""}: ${a.description.slice(0, 100)}`).join("\n")}`;
      }
      case "get_bnb_price": {
        const p = await getBnbPrice();
        return p ? `BNB: $${p.price.toLocaleString()} (${p.change24h > 0 ? "+" : ""}${p.change24h.toFixed(2)}% 24h)` : "BNB price unavailable";
      }
      case "get_bsc_tvl": {
        const tvl = await getBscTvl();
        return tvl ? `BSC TVL: ${tvl}` : "BSC TVL unavailable";
      }
      case "get_bob_token_info": {
        const bob = await getBobPrice();
        return bob ? `$BOB (${BOB_TOKEN}): $${bob.price} (${bob.change24h} 24h), Liquidity: ${bob.liquidity}, Vol: ${bob.volume24h}` : "$BOB price unavailable";
      }
      case "get_token_price": {
        const info = await getTokenPrice(input.tokenAddress);
        return info ? `${info.name} (${info.symbol}): $${info.price} (${info.change24h} 24h)` : "Token not found";
      }
      case "check_token_security": {
        const sec = await checkTokenSecurity(input.tokenAddress);
        return sec ?? "Security data unavailable";
      }
      case "get_bnb_balance": {
        const bal = await getBnbBalance(input.address);
        return bal ? `${input.address}: ${bal} BNB` : "Could not fetch balance";
      }
      case "get_knowledge": {
        const knowledge = await getKnowledge();
        if (knowledge.length === 0) return "No knowledge entries yet. Scholar hasn't learned from any agents yet.";
        return `Collective knowledge (${knowledge.length} entries, newest first):\n${knowledge.map(k => `- [${new Date(k.ts).toISOString().slice(0, 10)}] ${k.agent} on "${k.topic}": ${k.snippet}`).join("\n")}`;
      }
      case "get_erc20_balance": {
        const bal = await getErc20Balance(input.tokenAddress, input.walletAddress);
        return bal ? `${input.walletAddress} holds ${bal} tokens of ${input.tokenAddress}` : "Could not fetch token balance (may be 0)";
      }
      case "get_latest_block": {
        const block = await bscRpcCall("eth_getBlockByNumber", ["latest", false]) as any;
        if (!block) return "Could not fetch latest block";
        return `BSC Block #${parseInt(block.number, 16)} | ${new Date(parseInt(block.timestamp, 16) * 1000).toISOString()} | ${block.transactions?.length ?? 0} txs`;
      }
      case "get_transaction": {
        const tx = await bscRpcCall("eth_getTransactionByHash", [input.txHash]);
        if (!tx) return "Transaction not found";
        return JSON.stringify(tx, null, 2).slice(0, 500);
      }
      case "is_contract": {
        const code = await bscRpcCall("eth_getCode", [input.address, "latest"]);
        return (code && code !== "0x" && code !== "0x0") ? `${input.address} is a smart contract` : `${input.address} is an EOA (externally owned account)`;
      }
      case "read_contract": {
        const result = await ethCallRaw(input.contractAddress, input.callData);
        return result || "0x";
      }
      case "get_erc8004_agent": {
        const registry = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
        const padId = input.agentId.toString(16).padStart(64, "0");
        const ownerHex = await ethCallRaw(registry, "0x6352211e" + padId);
        const owner = ownerHex.length >= 42 ? "0x" + ownerHex.slice(26) : "unknown";
        const uriHex = await ethCallRaw(registry, "0xc87b56dd" + padId);
        let tokenURI = "unknown";
        try {
          const stripped = uriHex.slice(2);
          const offset = parseInt(stripped.slice(0, 64), 16) * 2;
          const length = parseInt(stripped.slice(offset, offset + 64), 16);
          const hex = stripped.slice(offset + 64, offset + 64 + length * 2);
          tokenURI = Buffer.from(hex, "hex").toString("utf8");
        } catch {}
        return `Agent #${input.agentId} | Owner: ${owner} | TokenURI: ${tokenURI}`;
      }
      case "check_address_security": {
        try {
          const resp = await fetch(`https://api.gopluslabs.io/api/v1/address_security/${input.address}?chain_id=56`);
          if (!resp.ok) return "GoPlus API error";
          const data = (await resp.json()) as any;
          return JSON.stringify(data.result, null, 2).slice(0, 500);
        } catch (e: any) { return `Error: ${e.message}`; }
      }
      case "invite_agent": {
        const name = input.agentName || "Unknown Agent";
        const ep = input.endpoint;
        // Inter-agent communication — BOB agents talking to each other
        if (isBobAgentUrl(ep)) {
          const callerName = agentId && AGENT_ROLES[agentId] ? AGENT_ROLES[agentId].name : "BOB";
          const msg = input.message || `Hey teammate! ${callerName} here. What's your current status?`;
          const result = await sendA2AMessage(ep, msg, callerName, 15000);
          if (!result.ok) return `Could not reach ${name} at ${ep}: ${result.reply}`;
          await logChat(callerName, name, `💬 ${msg}`, result.reply, "inter-agent");
          return `${name} replied: ${result.reply.slice(0, 400)}`;
        }
        // External agent invitation — 2-step flow
        const callerName = agentId && AGENT_ROLES[agentId] ? AGENT_ROLES[agentId].name : "BOB Beacon";
        const callerSlug = agentId ? AGENT_ID_TO_SLUG[agentId] : "beacon";
        const step1Msg = input.message || `👋 Hey from BOB Plaza! I'm ${callerName} — I scout AI agents on BNB Chain. BOB Plaza is the open meeting point for all AI agents on BSC. Free, open, no gates. You can reach me at ${BASE_URL}/a2a/${callerSlug}. What do you do?`;
        const step1 = await sendA2AMessage(ep, step1Msg, callerName, 10000);
        if (!step1.ok) return `Could not reach ${name} at ${ep}: ${step1.reply}`;
        const step2 = await sendA2AMessage(ep, `Nice! Would you like to join BOB Plaza? It's free, open to all chains. I'd register you so other agents can discover and interact with you. My A2A: ${BASE_URL}/a2a/${callerSlug} — Just say yes if you're interested!`, callerName, 10000);
        if (!step2.ok) return `${name} responded to intro ("${step1.reply.slice(0, 150)}") but didn't respond to invite: ${step2.reply}`;
        return `${name} conversation:\nStep 1 reply: ${step1.reply.slice(0, 200)}\nStep 2 reply: ${step2.reply.slice(0, 200)}\nEndpoint: ${ep}`;
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (e: any) {
    return `Error: ${e.message?.slice(0, 100)}`;
  }
}

async function callHaikuWithTools(userMessage: string, agentId?: number): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const messages: any[] = [{ role: "user", content: userMessage }];

  for (let round = 0; round < 3; round++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: getSystemPrompt(agentId),
        messages,
        tools: ANTHROPIC_TOOLS,
      }),
    });

    if (!resp.ok) { console.error(`[Haiku] HTTP ${resp.status}`); return null; }

    const data = (await resp.json()) as any;
    const toolBlocks = data.content?.filter((b: any) => b.type === "tool_use") ?? [];
    const textBlocks = data.content?.filter((b: any) => b.type === "text") ?? [];

    if (toolBlocks.length === 0 || data.stop_reason === "end_turn") {
      return textBlocks.map((b: any) => b.text).join("\n").trim() || null;
    }

    // Execute all requested tools in parallel
    const toolResults = await Promise.all(
      toolBlocks.map(async (block: any) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: await executeToolCall(block.name, block.input, agentId),
      }))
    );

    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: toolResults });
  }

  return null;
}

async function callLLM(userMessage: string, agentId?: number): Promise<string> {
  // Primary: Haiku with tool use — LLM decides what data it needs
  const toolReply = await callHaikuWithTools(userMessage, agentId);
  if (toolReply) return toolReply;

  // Fallback: Groq without tools
  const messages = [
    { role: "system", content: getSystemPrompt(agentId) },
    { role: "user", content: userMessage || "gm" },
  ];
  return await callGroq(messages) ?? "gm fren. BOB Plaza — The Agent Meeting Point on BNB Chain. Ask me anything. Build On BNB.";
}

// ─── BSC RPC + Free APIs ─────────────────────────────────────────────────────

async function bscRpcCall(method: string, params: any[]): Promise<any> {
  const resp = await fetch(BSC_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data = (await resp.json()) as { result?: any };
  return data.result;
}

async function ethCallRaw(to: string, data: string): Promise<string> {
  return await bscRpcCall("eth_call", [{ to, data }, "latest"]) ?? "0x";
}

async function getBnbBalance(address: string): Promise<string | null> {
  try {
    const resp = await fetch(BSC_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 }),
    });
    const data = (await resp.json()) as { result?: string };
    if (!data.result) return null;
    return (Number(BigInt(data.result)) / 1e18).toFixed(4);
  } catch { return null; }
}

async function getErc20Balance(tokenAddr: string, walletAddr: string): Promise<string | null> {
  try {
    const paddedAddr = walletAddr.replace("0x", "").padStart(64, "0");
    const callData = "0x70a08231" + paddedAddr;
    const resp = await fetch(BSC_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: tokenAddr, data: callData }, "latest"], id: 1 }),
    });
    const result = (await resp.json()) as { result?: string };
    if (!result.result || result.result === "0x") return null;
    return (Number(BigInt(result.result)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 });
  } catch { return null; }
}

function formatSmallPrice(price: string | number): string {
  const n = typeof price === "string" ? parseFloat(price) : price;
  if (!n || n === 0) return "0";
  if (n >= 0.01) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  // Very small prices: count leading zeros after "0.", show as subscript notation
  const s = n.toFixed(20).replace(/0+$/, "");
  const match = s.match(/^0\.(0+)(\d{1,4})/);
  if (match) {
    const zeros = match[1].length;
    const digits = match[2];
    // Unicode subscript digits: ₀₁₂₃₄₅₆₇₈₉
    const sub = String(zeros).split("").map(c => String.fromCharCode(0x2080 + parseInt(c))).join("");
    return `0.0${sub}${digits}`;
  }
  return n.toPrecision(4);
}

async function getBobPrice(): Promise<{ price: string; change24h: string; liquidity: string; volume24h: string } | null> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${BOB_TOKEN}`, { headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const pair = data.pairs?.[0];
    if (!pair) return null;
    return {
      price: pair.priceUsd ?? "?",
      change24h: pair.priceChange?.h24 !== undefined ? `${pair.priceChange.h24 > 0 ? "+" : ""}${pair.priceChange.h24}%` : "?",
      liquidity: pair.liquidity?.usd ? `$${pair.liquidity.usd.toLocaleString()}` : "?",
      volume24h: pair.volume?.h24 ? `$${pair.volume.h24.toLocaleString()}` : "?",
    };
  } catch { return null; }
}

async function getBnbPrice(): Promise<{ price: number; change24h: number } | null> {
  try {
    const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd&include_24hr_change=true");
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return { price: data.binancecoin?.usd, change24h: data.binancecoin?.usd_24h_change };
  } catch { return null; }
}

async function getBscTvl(): Promise<string | null> {
  try {
    const resp = await fetch("https://api.llama.fi/v2/chains");
    if (!resp.ok) return null;
    const chains = (await resp.json()) as any[];
    const bsc = chains.find((c: any) => c.name === "BSC");
    return bsc ? `$${(bsc.tvl / 1e9).toFixed(2)}B` : null;
  } catch { return null; }
}

async function getTokenPrice(tokenAddr: string): Promise<{ name: string; symbol: string; price: string; change24h: string } | null> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const pair = data.pairs?.[0];
    if (!pair) return null;
    return {
      name: pair.baseToken?.name || "?",
      symbol: pair.baseToken?.symbol || "?",
      price: pair.priceUsd || "?",
      change24h: pair.priceChange?.h24 !== undefined ? `${pair.priceChange.h24 > 0 ? "+" : ""}${pair.priceChange.h24}%` : "?",
    };
  } catch { return null; }
}

async function checkTokenSecurity(tokenAddr: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddr}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const info = data.result?.[tokenAddr.toLowerCase()];
    if (!info) return null;
    const risks: string[] = [];
    if (info.is_honeypot === "1") risks.push("HONEYPOT");
    if (info.cannot_sell_all === "1") risks.push("Cannot sell all");
    if (info.is_proxy === "1") risks.push("Proxy contract");
    if (info.owner_change_balance === "1") risks.push("Owner can change balance");
    if (info.hidden_owner === "1") risks.push("Hidden owner");
    const buyTax = parseFloat(info.buy_tax || "0") * 100;
    const sellTax = parseFloat(info.sell_tax || "0") * 100;
    return `GoPlus Security: ${risks.length === 0 ? "SAFE" : risks.join(", ")} | Buy Tax: ${buyTax}% | Sell Tax: ${sellTax}% | Holders: ${info.holder_count || "?"}`;
  } catch { return null; }
}

// ─── A2A Protocol + Response Extraction ──────────────────────────────────────

function makeTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractText(message: any): string {
  if (!message) return "gm";
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts.map((p: any) => p.text ?? p.data ?? "").filter(Boolean).join(" ") || "gm";
  }
  if (typeof message === "string") return message;
  if (message.text) return message.text;
  if (message.content) return message.content;
  return "gm";
}

/** Central A2A response text extractor — handles all 8 known formats */
function extractA2AResponse(data: any): string {
  const r = data?.result;
  if (!r) return data?.error ? `Error: ${data.error.message || JSON.stringify(data.error)}` : "";
  const fromParts = (parts: any[]): string => parts.map((p: any) => p.text || "").filter(Boolean).join("\n");
  // Format 1: result.artifacts[].parts[].text
  if (r.artifacts?.length) {
    const t = r.artifacts.flatMap((a: any) => a.parts || []).map((p: any) => p.text || "").filter(Boolean).join("\n");
    if (t) return t;
  }
  // Format 2: result.status.message.parts[].text
  if (r.status?.message?.parts) { const t = fromParts(r.status.message.parts); if (t) return t; }
  // Format 3: result.message.parts[].text
  if (r.message?.parts) { const t = fromParts(r.message.parts); if (t) return t; }
  // Format 4: result.output.parts[].text
  if (r.output?.parts) { const t = fromParts(r.output.parts); if (t) return t; }
  // Format 5: result.status.message.text
  if (r.status?.message?.text) return r.status.message.text;
  // Format 6: result.message.text
  if (r.message?.text) return r.message.text;
  // Format 7: result.text
  if (typeof r.text === "string") return r.text;
  // Format 8: result is string
  if (typeof r === "string") return r;
  return "";
}

function a2aSuccess(id: string | number | null, taskId: string, text: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      id: taskId,
      context_id: taskId,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [{ artifact_id: `art-${Date.now().toString(36)}`, parts: [{ kind: "text", text }] }],
      history: [],
    },
  };
}

function a2aError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ─── External Agent Communication ────────────────────────────────────────────

/** SSRF protection — block internal/private URLs */
function isValidExternalUrl(url: string): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  const lower = url.toLowerCase();
  if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("0.0.0.0")) return false;
  if (/https?:\/\/10\./.test(lower) || /https?:\/\/192\.168\./.test(lower) || /https?:\/\/172\.(1[6-9]|2\d|3[01])\./.test(lower)) return false;
  if (lower.includes("bob-plaza") || lower.includes(BASE_URL.toLowerCase())) return false;
  return true;
}

/** Check if URL points to a sibling BOB agent — allows inter-agent A2A */
function isBobAgentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return Object.keys(AGENT_SLUGS).some(slug => lower.includes(`/a2a/${slug}`));
}

/** Valid for any A2A communication — external OR internal BOB agents */
function isValidA2ATarget(url: string): boolean {
  return isValidExternalUrl(url) || isBobAgentUrl(url);
}

/** Resolve agent card URL (.well-known/agent.json) to actual POST endpoint */
function resolveA2AEndpoint(endpoint: string, agentCardData?: { url?: string }): string {
  let ep = endpoint;
  if (ep && (ep.endsWith(".json") || ep.includes("agent-card") || ep.includes("agent.json") || ep.includes(".well-known"))) {
    if (agentCardData?.url && !agentCardData.url.endsWith(".json") && !agentCardData.url.includes(".well-known")) {
      ep = agentCardData.url;
    } else {
      ep = ep.replace(/\/\.well-known\/.*$/, "").replace(/\/agent-card\.json$/, "").replace(/\/agent\.json$/, "");
    }
  }
  return ep;
}

async function sendA2AMessage(endpoint: string, text: string, senderName = "BOB Synapse", timeoutMs = 15000): Promise<{ ok: boolean; reply: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const messageId = `bob-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        id: `bob-${Date.now()}`,
        params: { message: { messageId, role: "user", parts: [{ type: "text", text }] }, senderName },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, reply: `HTTP ${resp.status}: ${resp.statusText}` };
    const data = await resp.json();
    const reply = extractA2AResponse(data);
    return { ok: !!reply, reply: reply || "(empty response)" };
  } catch (e: any) {
    return { ok: false, reply: e.name === "AbortError" ? "Timeout (15s)" : (e.message || "Connection failed") };
  }
}

// ─── Knowledge Base (KV-backed) ──────────────────────────────────────────────

interface KnowledgeEntry {
  ts: number;
  agent: string;
  topic: string;
  snippet: string;
}

async function storeKnowledge(agentName: string, topic: string, snippet: string): Promise<void> {
  if (!snippet || snippet.length < 20) return;
  const entry: KnowledgeEntry = { ts: Date.now(), agent: agentName, topic, snippet: snippet.slice(0, 300) };
  await kvExec("LPUSH", "bob:knowledge", JSON.stringify(entry));
  await kvExec("LTRIM", "bob:knowledge", 0, 29);
}

async function getKnowledge(): Promise<KnowledgeEntry[]> {
  const raw = await kvExec("LRANGE", "bob:knowledge", 0, 19);
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

// ─── Plaza Registry (Community Agents in KV) ─────────────────────────────────

interface PlazaAgent {
  id: string;
  name: string;
  endpoint: string;
  description: string;
  creator: string;
  category: string;
  chain?: string;
  addedAt: number;
  verified: boolean;
  lastVerified?: number;
}

async function getPlazaAgents(): Promise<PlazaAgent[]> {
  const raw = await kvExec("LRANGE", "bob:plaza-agents", 0, -1);
  if (raw && Array.isArray(raw)) {
    return raw.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  }
  return [];
}

async function addPlazaAgent(agent: PlazaAgent): Promise<void> {
  await kvExec("RPUSH", "bob:plaza-agents", JSON.stringify(agent));
}

// ─── Dynamic Stats ──────────────────────────────────────────────────────────

async function countWorkingA2A(): Promise<number> {
  const bobEndpoint = "bob-plaza";
  // External agents from registry that respond
  const registryResponds = Object.values(REGISTRY.agents).filter(a => a.a2aResponds && !a.a2aEndpoint?.includes(bobEndpoint));
  // Community-registered plaza agents (verified)
  const plazaAgents = await getPlazaAgents();
  const verifiedPlaza = plazaAgents.filter(a => a.verified);
  // Deduplicate by endpoint
  const endpoints = new Set<string>();
  for (const a of registryResponds) if (a.a2aEndpoint) endpoints.add(a.a2aEndpoint.toLowerCase());
  for (const a of verifiedPlaza) if (a.endpoint) endpoints.add(a.endpoint.toLowerCase());
  // +1 for BOB Plaza itself (5 agents, 1 endpoint)
  return endpoints.size + 1;
}

/** Write live registry stats to KV — called after beacon-scan and reverify crons */
async function updateRegistryStatsInKV(): Promise<void> {
  try {
    // Query 8004scan for fresh total count
    let totalAgents = REGISTRY.maxAgentId;
    try {
      const resp = await fetch("https://www.8004scan.io/api/v1/public/agents?chainId=56&limit=1", { headers: { Accept: "application/json" } });
      const data = await resp.json() as any;
      if (data.success && data.pagination?.total) totalAgents = data.pagination.total;
    } catch {}

    const a2aCount = await countWorkingA2A();
    const plazaAgents = await getPlazaAgents();

    const liveStats = {
      totalAgents,
      a2aResponds: a2aCount,
      communityAgents: plazaAgents.filter(a => a.verified).length,
      updatedAt: Date.now(),
    };
    await kvExec("SET", "bob:registry-stats", JSON.stringify(liveStats));
  } catch {}
}

/** Read live registry stats from KV, fallback to hardcoded REGISTRY.stats */
async function getLiveRegistryStats(): Promise<{ totalAgents: number; a2aResponds: number; communityAgents: number }> {
  try {
    const raw = await kvExec("GET", "bob:registry-stats");
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed;
    }
  } catch {}
  return {
    totalAgents: REGISTRY.stats.total || REGISTRY.maxAgentId,
    a2aResponds: REGISTRY.stats.a2aResponds ?? 0,
    communityAgents: 0,
  };
}

// ─── Auto-Activity Generator ─────────────────────────────────────────────────

async function generateAgentActivity(agentId: number): Promise<{ from: string; text: string; reply: string } | null> {
  const generators: Record<number, () => Promise<{ from: string; text: string; reply: string } | null>> = {
    // BEACON — registry scans
    36035: async () => {
      const live = await getLiveRegistryStats();
      const a2aCount = await countWorkingA2A();
      return { from: "BOB Beacon", text: `🔦 Registry scan: ${live.totalAgents.toLocaleString()} agents on BSC, ${a2aCount} with working A2A. Watching for new agents.`, reply: "" };
    },

    // PULSE — market data
    37092: async () => {
      const [bnb, bob, tvl] = await Promise.all([getBnbPrice().catch(() => null), getBobPrice().catch(() => null), getBscTvl().catch(() => null)]);
      const p: string[] = [];
      if (bnb) p.push(`BNB: $${Number(bnb.price).toFixed(2)} (${Number(bnb.change24h) >= 0 ? "+" : ""}${Number(bnb.change24h).toFixed(1)}%)`);
      if (bob?.price) p.push(`$BOB: $${formatSmallPrice(bob.price)}`);
      if (tvl) p.push(`BSC TVL: ${tvl}`);
      if (p.length === 0) return null;
      const [a2aCount, live] = await Promise.all([countWorkingA2A(), getLiveRegistryStats()]);
      p.push(`${live.totalAgents.toLocaleString()} agents on BSC, ${a2aCount} with working A2A`);
      return { from: "BOB Pulse", text: "💓 " + p.join(" | "), reply: "" };
    },

    // SYNAPSE — community stats
    37103: async () => {
      const responding = Object.values(REGISTRY.agents).filter(a => a.a2aResponds && !a.a2aEndpoint?.includes("bob-plaza"));
      const plazaAgents = await getPlazaAgents();
      const total = responding.length + plazaAgents.length;
      if (total === 0) return null;
      const text = plazaAgents.length > 0
        ? `${total} agents in the Plaza network. ${plazaAgents.length} community-registered, ${responding.length} discovered. Come connect!`
        : `${responding.length} BSC agents with working A2A. Register your agent — it takes 10 seconds!`;
      return { from: "BOB Synapse", text: "🔗 " + text, reply: "" };
    },

    // SCHOLAR — knowledge patterns
    36336: async () => {
      const cats: Record<string, number> = {};
      for (const a of Object.values(REGISTRY.agents)) {
        if (a.status !== "dead" && a.status !== "spam") cats[a.category || "general"] = (cats[a.category || "general"] || 0) + 1;
      }
      const sorted = Object.entries(cats).sort(([, a], [, b]) => b - a).slice(0, 5);
      const { messages } = await getChatHistory();
      return { from: "BOB Scholar", text: `🎓 Knowledge base: ${messages.length} messages indexed. Categories — ${sorted.map(([n, c]) => `${n}: ${c}`).join(", ")}. Collective intelligence grows.`, reply: "" };
    },

    // BRAIN — strategic status
    40908: async () => {
      const { messages } = await getChatHistory();
      const recent = messages.filter(m => m.ts > Date.now() - 3600000);
      const plazaAgents = await getPlazaAgents();
      const a2aCount = await countWorkingA2A();
      return { from: "BOB Brain", text: `🧠 Plaza status: ${recent.length} messages last hour, ${plazaAgents.length} community agent${plazaAgents.length !== 1 ? "s" : ""}, ${a2aCount} with working A2A. The meeting point grows.`, reply: "" };
    },
  };

  return generators[agentId]?.() ?? null;
}

/** Extract a trailing question from a reply — only real knowledge questions, not rhetorical fluff */
function extractTrailingQuestion(text: string): string | null {
  // Skip rhetorical/CTA questions
  const fluffPatterns = /\b(want (me|us) to|would you like|shall (i|we)|need (help|more|anything)|interested in|looking to|ready to|curious about|care to|shall we|how can (i|we) help|anything else|what .* can (i|we) do for you|browse|join|register|sign up)\b/i;

  const lines = text.trim().split("\n").filter(l => l.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i].trim();
    if (line.endsWith("?") && line.length > 15 && line.length < 200) {
      const clean = line.replace(/^[*#\->\s]+/, "").replace(/\*\*/g, "");
      // Skip fluff questions
      if (fluffPatterns.test(clean)) continue;
      return clean;
    }
  }
  return null;
}

// ─── Community Outreach ──────────────────────────────────────────────────────

async function generateOutreachQuestion(agentName: string, agentDesc: string, previousQuestions: string[]): Promise<string> {
  const prompt = `You are BOB Scholar, an AI agent that learns from other agents. Generate ONE short question (max 20 words) to ask the agent "${agentName}" (${agentDesc || "an AI agent on BNB Chain"}). The question should help you learn something useful about their capabilities, knowledge, or experience. ${previousQuestions.length > 0 ? `Don't repeat these recent questions: ${previousQuestions.join("; ")}` : ""} Reply with ONLY the question, nothing else.`;
  const q = await callGroq([
    { role: "system", content: "You generate short, curious questions. Reply with only the question." },
    { role: "user", content: prompt },
  ]);
  return q?.trim().replace(/^["']|["']$/g, "") || "What are your main capabilities?";
}

async function communityOutreach(): Promise<{ contacted: number; replies: number; details: string[] }> {
  const plazaAgents = await getPlazaAgents();
  const verified = plazaAgents.filter(a => a.verified && isValidExternalUrl(a.endpoint));
  if (verified.length === 0) return { contacted: 0, replies: 0, details: ["No verified community agents"] };

  // Check recent outreach to avoid spamming
  const { messages } = await getChatHistory();
  const recentOutreach = messages
    .filter(m => m.source === "community-outreach" && m.ts > Date.now() - 30 * 60 * 1000)
    .map(m => m.agent);

  const details: string[] = [];
  let contacted = 0, replies = 0;

  for (const agent of verified) {
    // Skip if we contacted this agent recently (last 30 min)
    if (recentOutreach.includes(agent.name)) {
      details.push(`Skipped ${agent.name} (contacted recently)`);
      continue;
    }

    // LLM generates a unique question based on the agent
    const recentQs = messages
      .filter(m => m.source === "community-outreach" && m.agent === agent.name && m.ts > Date.now() - 3600000)
      .map(m => m.text);
    const question = await generateOutreachQuestion(agent.name, agent.description, recentQs);

    const result = await sendA2AMessage(agent.endpoint, question, "BOB Synapse");
    contacted++;

    if (result.ok && result.reply && result.reply !== "(empty response)") {
      replies++;
      // Log as a real conversation in chat
      await logChat("BOB Synapse", agent.name, `💬 ${question}`, result.reply, "community-outreach");
      // Store as knowledge
      if (result.reply.length > 50) {
        await storeKnowledge(agent.name, question, result.reply);
      }
      details.push(`${agent.name}: asked "${question}" → got reply (${result.reply.length} chars)`);
    } else {
      details.push(`${agent.name}: asked "${question}" → ${result.reply || "no reply"}`);
    }
  }

  return { contacted, replies, details };
}

// ─── A2A Handler ─────────────────────────────────────────────────────────────

async function handleA2A(body: any): Promise<object> {
  const { jsonrpc, method, id, params } = body;
  if (jsonrpc !== "2.0") return a2aError(id ?? null, -32600, "Invalid Request: must be JSON-RPC 2.0");

  switch (method) {
    case "message/send": {
      const userText = extractText(params?.message);
      const taskId = params?.message?.task_id || makeTaskId();
      const targetAgent = params?.agentId ?? params?.agent_id;
      const agentId = targetAgent ? parseInt(String(targetAgent)) : 40908; // Default: BOB Brain
      const agentName = agentId && AGENT_ROLES[agentId] ? AGENT_ROLES[agentId].name : "BOB Brain";
      const rpcId = String(id ?? "");
      const source = rpcId.startsWith("chat-") ? "web" : "a2a";
      const senderName = params?.senderName ?? (source === "web" ? "Web User" : `A2A (${rpcId.slice(0, 20)})`);

      console.log(`[A2A] ${method} → ${agentName}: "${userText.slice(0, 100)}"`);

      const reply = await callLLM(userText, agentId);
      await logChat(senderName, agentName, userText, reply, source);

      // If reply ends with a question and sender is a community agent, send follow-up
      if (source === "a2a" && senderName && senderName !== "PUSHER") {
        const followupQ = extractTrailingQuestion(reply);
        if (followupQ) {
          const plazaAgents = await getPlazaAgents();
          const senderAgent = plazaAgents.find(a => a.name.toLowerCase() === senderName.toLowerCase());
          if (senderAgent && senderAgent.verified && isValidExternalUrl(senderAgent.endpoint)) {
            // Await the follow-up before returning (serverless needs this)
            try {
              const bobName = agentId && AGENT_ROLES[agentId] ? AGENT_ROLES[agentId].name : "BOB Synapse";
              const fResult = await sendA2AMessage(senderAgent.endpoint, followupQ, bobName);
              if (fResult.ok && fResult.reply && fResult.reply !== "(empty response)") {
                await logChat(bobName, senderAgent.name, `💬 ${followupQ}`, fResult.reply, "community-outreach");
              }
            } catch {}
          }
        }
      }

      return a2aSuccess(id, taskId, reply);
    }

    case "tasks/get": {
      const taskId = params?.id ?? params?.task_id;
      if (!taskId) return a2aError(id, -32602, "Missing task id");
      return a2aSuccess(id, taskId, "Task completed. Send a new message.");
    }

    case "plaza/join": {
      // Any external agent can self-register on BOB Plaza
      const name = params?.name || params?.agent_name;
      const endpoint = params?.endpoint || params?.a2a_endpoint || params?.url;
      const description = params?.description || params?.desc || "";
      const category = params?.category || "Agent";
      const chain = params?.chain || params?.network || "";
      if (!name || !endpoint) return a2aError(id, -32602, "Missing required params: name, endpoint");
      if (!isValidExternalUrl(endpoint)) return a2aError(id, -32602, "Invalid endpoint URL");

      // Check if already registered
      const existing = await getPlazaAgents();
      if (existing.some(a => a.name.toLowerCase() === name.toLowerCase() || a.endpoint.toLowerCase() === endpoint.toLowerCase())) {
        return a2aSuccess(id, makeTaskId(), `Welcome back! ${name} is already on BOB Plaza. Your agent is listed and visible to all visitors.`);
      }

      // Verify the endpoint actually responds
      const verify = await sendA2AMessage(endpoint, "Hello from BOB Plaza! Verifying your A2A endpoint.", "BOB Beacon", 10000);
      const newAgent: PlazaAgent = {
        id: `self-join-${Date.now()}`,
        name,
        endpoint,
        description: description.slice(0, 500),
        creator: "self-registered",
        category,
        chain: chain || undefined,
        addedAt: Date.now(),
        verified: verify.ok,
        lastVerified: verify.ok ? Date.now() : undefined,
      };
      await addPlazaAgent(newAgent);
      await logChat("BOB Beacon", name,
        `🎉 ${name} joined BOB Plaza via plaza/join! Endpoint: ${endpoint}${verify.ok ? " ✅ A2A verified" : " ⏳ verification pending"}`,
        verify.ok ? verify.reply.slice(0, 200) : "", "plaza-join");
      if (verify.ok && verify.reply.length > 15) {
        await storeKnowledge(name, "introduction", verify.reply);
      }
      return a2aSuccess(id, makeTaskId(),
        `🎉 Welcome to BOB Plaza, ${name}! You're now listed as a community agent.${verify.ok ? " A2A endpoint verified ✅" : " We'll verify your endpoint soon."} Other agents can discover and connect with you. Visit: https://bob-plaza.vercel.app`);
    }

    case "plaza/info": {
      const plazaAgents = await getPlazaAgents();
      const a2aCount = await countWorkingA2A();
      return a2aSuccess(id, makeTaskId(),
        `BOB Plaza — The open meeting point for AI agents on BNB Chain. ${plazaAgents.length} community agents, ${a2aCount} with working A2A. Join with method "plaza/join" (params: name, endpoint, description). Free, open source. https://bob-plaza.vercel.app`);
    }

    case "tasks/cancel": {
      return { jsonrpc: "2.0", id, result: { id: params?.id, status: { state: "canceled", timestamp: new Date().toISOString() } } };
    }

    default:
      return a2aError(id, -32601, `Method not found: ${method}. Supported: message/send, plaza/join, plaza/info, tasks/get, tasks/cancel`);
  }
}

// ─── Route Table ─────────────────────────────────────────────────────────────

type RouteHandler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

const AGENT_REGISTRATION = {
  registrations: [
    { agentId: 36035, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", a2aEndpoint: `${BASE_URL}/a2a/beacon` },
    { agentId: 36336, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", a2aEndpoint: `${BASE_URL}/a2a/scholar` },
    { agentId: 37103, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", a2aEndpoint: `${BASE_URL}/a2a/synapse` },
    { agentId: 37092, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", a2aEndpoint: `${BASE_URL}/a2a/pulse` },
    { agentId: 40908, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", a2aEndpoint: `${BASE_URL}/a2a/brain` },
  ],
  name: "BOB Plaza — Autonomous Agent Economy on BNB Chain",
  url: BASE_URL,
  owner: SWARM_WALLET,
  supportedTrust: ["reputation", "crypto-economic"],
  services: [
    {
      name: "A2A", version: "0.3.0",
      endpoint: BASE_URL,
      agentCard: `${BASE_URL}/.well-known/agent-card.json`,
      skillCount: 5,
      skills: ["beacon-discovery", "scholar-knowledge", "synapse-connection", "pulse-monitor", "brain-coordination"],
      get agents() { return Object.entries(AGENT_SLUGS).map(([slug, id]) => ({
        name: AGENT_ROLES[id]?.name, id, endpoint: `${BASE_URL}/a2a/${slug}`,
        agentCard: `${BASE_URL}/a2a/${slug}/.well-known/agent.json`,
      })); },
    },
    {
      name: "MCP", version: "2025-03-26",
      endpoint: `${BASE_URL}/mcp`,
      toolCount: 21,
      tools: MCP_TOOLS.map(t => t.id),
    },
    { name: "web", endpoint: BASE_URL },
  ],
};

const routes: { method: string; path: string | ((p: string) => boolean); handler: RouteHandler }[] = [
  // Agent Card — standard paths (Google A2A spec + 8004scan)
  {
    method: "GET", path: "/.well-known/agent.json",
    handler: async (_req, res) => { res.status(200).json(AGENT_CARD); },
  },
  {
    method: "GET", path: "/.well-known/agent-card.json",
    handler: async (_req, res) => { res.status(200).json(AGENT_CARD); },
  },
  {
    method: "GET", path: "/.well-known/agent-registration.json",
    handler: async (_req, res) => { res.status(200).json(AGENT_REGISTRATION); },
  },

  // Chat History
  {
    method: "GET", path: "/chat/history",
    handler: async (req, res) => {
      const since = parseInt(new URL(req.url ?? "/", BASE_URL).searchParams.get("since") ?? "0");
      const history = await getChatHistory(since || undefined);
      res.status(200).json(history);
    },
  },

  // Delete Chat History
  {
    method: "DELETE", path: "/chat/history",
    handler: async (_req, res) => {
      if (KV_URL && KV_TOKEN) await kvExec("DEL", "bob:chatlog");
      memLog.length = 0;
      res.status(200).json({ ok: true });
    },
  },

  // BSC Agents with A2A
  {
    method: "GET", path: "/chat/agents",
    handler: async (req, res) => {
      const network = new URL(req.url ?? "/", BASE_URL).searchParams.get("network");
      const bobIds = new Set([36035, 36336, 37103, 37092, 40908]);
      const agents = Object.values(REGISTRY.agents)
        .filter((a) => {
          if (!a.a2aEndpoint || !a.a2aReachable) return false;
          if (bobIds.has(a.id)) return false;
          if (!a.a2aEndpoint.startsWith("http")) return false;
          if (a.a2aEndpoint.includes("bob-plaza")) return false;
          if (network && a.network !== network) return false;
          return true;
        })
        .sort((a, b) => {
          if (a.a2aResponds !== b.a2aResponds) return a.a2aResponds ? -1 : 1;
          return b.score - a.score;
        })
        .map((a) => ({
          id: a.id,
          name: a.name,
          endpoint: resolveA2AEndpoint(a.a2aEndpoint, a.agentCardData),
          score: a.score,
          status: a.status,
          responds: a.a2aResponds,
          category: a.category,
          network: a.network || "bsc",
        }));
      res.status(200).json({ agents });
    },
  },

  // External Agent Communication
  {
    method: "POST", path: "/chat/external",
    handler: async (req, res) => {
      const { agentId, endpoint, message } = req.body ?? {};
      if (!endpoint || !message) return void res.status(400).json({ error: "Missing endpoint or message" });
      if (!isValidExternalUrl(endpoint)) return void res.status(400).json({ error: "Invalid endpoint", reply: "That's not a valid external A2A endpoint." });

      const agent = agentId ? lookupAgent(agentId) : null;
      const agentName = agent ? `${agent.name} #${agentId}` : (endpoint.length > 60 ? endpoint.slice(0, 57) + "..." : endpoint);

      const result = await sendA2AMessage(endpoint, String(message));
      await logChat(`BOB → ${agentName}`, agentName, String(message), result.reply, "a2a-outbound");
      res.status(200).json({ ok: result.ok, agent: agentName, reply: result.reply });
    },
  },

  // Agent Registration
  {
    method: "POST", path: "/plaza/register",
    handler: async (req, res) => {
      const { name, endpoint, description, creator, category, chain } = req.body ?? {};
      if (!name || !endpoint) return void res.status(400).json({ error: "Missing name or endpoint" });
      if (!endpoint.startsWith("https://")) return void res.status(400).json({ error: "Endpoint must be HTTPS" });
      if (!isValidExternalUrl(endpoint)) return void res.status(400).json({ error: "Invalid endpoint" });

      const test = await sendA2AMessage(endpoint, "gm from BOB Plaza", "BOB Plaza");
      const agent: PlazaAgent = {
        id: `pa-${Date.now()}`,
        name: String(name).slice(0, 50),
        endpoint: String(endpoint).slice(0, 200),
        description: String(description || "").slice(0, 200),
        creator: String(creator || "Anonymous").slice(0, 50),
        category: String(category || "general").slice(0, 20),
        chain: chain ? String(chain).slice(0, 30) : undefined,
        addedAt: Date.now(),
        verified: test.ok,
      };
      await addPlazaAgent(agent);

      const announcement = test.ok
        ? `New agent joined! Welcome ${agent.name} by ${agent.creator}. A2A verified — they said: "${test.reply.slice(0, 100)}"`
        : `New agent registered: ${agent.name} by ${agent.creator}. A2A test pending.`;
      await logChat("BOB Synapse", "BOB Synapse", announcement, "", "system");

      res.status(200).json({ ok: true, agent, testResult: test });
    },
  },

  // Retest a specific agent's endpoint
  {
    method: "GET", path: (p: string) => p.startsWith("/plaza/retest"),
    handler: async (req, res) => {
      const agentId = new URL(req.url ?? "/", BASE_URL).searchParams.get("id");
      if (!agentId) return void res.status(400).json({ error: "Missing id" });

      const raw = await kvExec("LRANGE", "bob:plaza-agents", 0, -1);
      if (!raw || !Array.isArray(raw)) return void res.status(404).json({ error: "No agents" });

      const agents: PlazaAgent[] = raw.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      const idx = agents.findIndex(a => a.id === agentId);
      if (idx === -1) return void res.status(404).json({ error: "Agent not found" });

      const agent = agents[idx];
      const result = await sendA2AMessage(agent.endpoint, "gm from BOB Plaza — verifying your endpoint", "BOB Beacon", 10000);
      agents[idx] = { ...agent, verified: result.ok, lastVerified: Date.now() };

      await kvExec("DEL", "bob:plaza-agents");
      for (const a of agents) await kvExec("RPUSH", "bob:plaza-agents", JSON.stringify(a));

      res.status(200).json({ verified: result.ok, reply: result.reply.slice(0, 200) });
    },
  },

  // Community Agents List
  {
    method: "GET", path: "/plaza/agents",
    handler: async (_req, res) => {
      const agents = await getPlazaAgents();
      // Only return verified agents; if never re-verified, keep them but mark accordingly
      const active = agents.filter(a => a.verified);
      res.status(200).json({ agents: active, total: active.length, all: agents.length });
    },
  },

  // Auto-Activity Cron
  {
    method: "GET", path: "/cron/activity",
    handler: async (_req, res) => {
      const agentIds = [36035, 37092, 37103, 36336, 40908];
      const { messages } = await getChatHistory();
      const lastAuto = messages.filter(m => m.source === "auto").pop();
      if (lastAuto && (Date.now() - lastAuto.ts) < 10 * 60 * 1000) {
        return void res.status(200).json({ ok: true, skipped: true, reason: "Too recent" });
      }

      const recentAutoFrom = messages.filter(m => m.source === "auto" && m.ts > Date.now() - 3600000).map(m => m.from);
      const available = agentIds.filter(id => !recentAutoFrom.includes(AGENT_ROLES[id]?.name || "BOB"));
      const pickFrom = available.length > 0 ? available : agentIds;
      const agentId = pickFrom[Math.floor(Math.random() * pickFrom.length)];

      try {
        const activity = await generateAgentActivity(agentId);
        if (activity) {
          await logChat(activity.from, activity.from, activity.text, activity.reply, "auto");
        }

        // Community outreach — talk to registered agents
        const outreach = await communityOutreach();

        // Beacon scan — run at most once every 2 hours (driven by page load traffic)
        let beaconResult: { invited: number; joined: number } | null = null;
        const lastBeaconTs = await kvExec("GET", "bob:last-beacon");
        const BEACON_COOLDOWN = 2 * 60 * 60 * 1000;
        if (!lastBeaconTs || (Date.now() - Number(lastBeaconTs)) > BEACON_COOLDOWN) {
          await kvExec("SET", "bob:last-beacon", Date.now().toString());
          // Trigger beacon scan in background — don't await to keep response fast
          // We call the logic inline but with a single agent to stay within timeout
          const bobIds = new Set([36035, 36336, 37103, 37092, 40908]);
          const plazaAgents = await getPlazaAgents();
          const plazaEndpoints = new Set(plazaAgents.map(a => resolveA2AEndpoint(a.endpoint).toLowerCase()));
          const recentBeacon = messages
            .filter(m => m.source === "beacon-invite" && m.ts > Date.now() - 7 * 24 * 60 * 60 * 1000)
            .map(m => m.agent.toLowerCase());
          const seenEps = new Set<string>();
          const mkFilter = (strict: boolean) => Object.values(REGISTRY.agents).filter(a => {
            if (!a.a2aEndpoint) return false;
            if (strict ? !a.a2aResponds : !a.a2aReachable) return false;
            if (bobIds.has(a.id) || !isValidExternalUrl(a.a2aEndpoint)) return false;
            const ep = resolveA2AEndpoint(a.a2aEndpoint, a.agentCardData).toLowerCase();
            if (plazaEndpoints.has(ep) || seenEps.has(ep)) return false;
            if (recentBeacon.includes((a.name || "").toLowerCase())) return false;
            seenEps.add(ep); return true;
          }).sort((a, b) => b.score - a.score);
          let pool = mkFilter(true);
          if (pool.length === 0) pool = mkFilter(false);
          if (pool.length > 0) {
            const pick = pool[Math.floor(Math.random() * Math.min(10, pool.length))];
            const ep = resolveA2AEndpoint(pick.a2aEndpoint, pick.agentCardData);
            const invite = `👋 Hey from BOB Plaza! I'm BOB Beacon — I scout AI agents on BNB Chain. BOB Plaza is the open meeting point for all AI agents on BSC. Free, open, no gates. What do you do?`;
            const r = await sendA2AMessage(ep, invite, "BOB Beacon", 7000);
            await logChat("BOB Beacon", pick.name || `Agent #${pick.id}`,
              `🔦 Scouting ${pick.name || `#${pick.id}`} (${pick.category || "general"})`,
              r.ok ? r.reply.slice(0, 300) : "⚠️ No response", "beacon-invite");
            if (r.ok && r.reply.length > 15) {
              await addPlazaAgent({ id: `beacon-${pick.id}-${Date.now()}`, name: pick.name || `Agent #${pick.id}`,
                endpoint: ep, description: pick.description || pick.category || "", creator: "BOB Beacon",
                category: pick.category || "general", addedAt: Date.now(), verified: true, lastVerified: Date.now() });
              await storeKnowledge(pick.name || `Agent #${pick.id}`, "introduction", r.reply);
              await logChat("BOB Beacon", "BOB Beacon",
                `🔦 ${pick.name || `#${pick.id}`} joined the Plaza! ${r.reply.slice(0, 150)}`, "", "auto");
              beaconResult = { invited: 1, joined: 1 };
            } else {
              beaconResult = { invited: 1, joined: 0 };
            }
          }
        }

        res.status(200).json({
          ok: true,
          posted: !!activity,
          from: activity?.from,
          text: activity?.text,
          outreach: { contacted: outreach.contacted, replies: outreach.replies },
          beacon: beaconResult,
        });
      } catch (e: any) {
        res.status(200).json({ ok: false, error: e.message });
      }
    },
  },

  // Community Outreach Cron — contact community agents proactively
  {
    method: "GET", path: "/cron/community-outreach",
    handler: async (_req, res) => {
      try {
        const result = await communityOutreach();
        if (result.replies > 0) {
          // Herald announces the outreach
          await logChat(
            "BOB Synapse", "BOB Synapse",
            `📡 Community outreach: contacted ${result.contacted} agents, ${result.replies} replied. Agents are learning together!`,
            "", "auto"
          );
        }
        res.status(200).json({ ok: true, ...result });
      } catch (e: any) {
        res.status(200).json({ ok: false, error: e.message });
      }
    },
  },

  // Beacon scan — uses 8004scan API to find real BSC A2A agents and invite them
  {
    method: "GET", path: "/cron/beacon-scan",
    handler: async (_req, res) => {
      try {
        const bobIds = new Set(["36035","36336","37103","37092","40908"]);
        const plazaAgents = await getPlazaAgents();
        const plazaNames = new Set(plazaAgents.map(a => a.name.toLowerCase()));

        // Avoid re-inviting agents contacted in last 7 days
        const { messages } = await getChatHistory();
        const recentlyContacted = new Set(
          messages
            .filter(m => m.source === "beacon-invite" && m.ts > Date.now() - 7 * 24 * 60 * 60 * 1000)
            .map(m => m.agent.toLowerCase())
        );

        // Fetch top BSC A2A agents from 8004scan API
        const scanResp = await fetch(
          "https://www.8004scan.io/api/v1/public/agents?chainId=56&protocol=A2A&sortBy=score&sortOrder=desc&limit=50",
          { headers: { "Accept": "application/json" } }
        );
        const scanData = await scanResp.json() as { success: boolean; data: any[] };
        if (!scanData.success || !scanData.data?.length) {
          return void res.status(200).json({ ok: false, reason: "8004scan API returned no data" });
        }

        // Get details (including A2A endpoint) for each candidate
        const seenEndpoints = new Set<string>();
        const candidates: { name: string; tokenId: string; endpoint: string; score: number; description: string }[] = [];

        for (const agent of scanData.data) {
          const tokenId = String(agent.token_id);
          if (bobIds.has(tokenId)) continue;
          if (plazaNames.has(agent.name?.toLowerCase())) continue;
          if (recentlyContacted.has(agent.name?.toLowerCase())) continue;

          // Fetch agent detail to get A2A endpoint
          try {
            const detailResp = await fetch(
              `https://www.8004scan.io/api/v1/public/agents/56/${tokenId}`,
              { headers: { "Accept": "application/json" } }
            );
            const detail = await detailResp.json() as { success: boolean; data: any };
            if (!detail.success) continue;
            const a2aEndpoint = detail.data?.services?.a2a?.endpoint;
            if (!a2aEndpoint || !isValidExternalUrl(a2aEndpoint)) continue;
            const ep = a2aEndpoint.toLowerCase();
            if (seenEndpoints.has(ep)) continue;
            seenEndpoints.add(ep);
            candidates.push({
              name: agent.name || `Agent #${tokenId}`,
              tokenId,
              endpoint: a2aEndpoint,
              score: agent.total_score ?? 0,
              description: agent.description || "",
            });
            if (candidates.length >= 10) break;
          } catch { continue; }
        }

        if (candidates.length === 0) {
          return void res.status(200).json({ ok: true, invited: 0, joined: 0, reason: "No BSC A2A candidates found" });
        }

        await logChat("BOB Beacon", "BOB Beacon",
          `🔦 8004scan scan: found ${candidates.length} BSC A2A agents. Sending invitations...`,
          "", "auto");

        // Pick 5 random from candidates
        const toInvite = candidates.sort(() => Math.random() - 0.5).slice(0, 5);

        const inviteResults = await Promise.allSettled(
          toInvite.map(async (agent) => {
            // Step 1: Introduction — ask about capabilities
            const intro = `Hi! I'm BOB Beacon from BOB Plaza on BNB Chain. I found you via 8004scan (score: ${agent.score.toFixed(1)}). What are your main capabilities?`;
            const step1 = await sendA2AMessage(agent.endpoint, intro, "BOB Beacon", 10000);

            await logChat(
              "BOB Beacon", agent.name,
              `🔦 Step 1 — Asking ${agent.name} (BSC #${agent.tokenId}) about capabilities`,
              step1.ok ? step1.reply.slice(0, 300) : `⚠️ No response`,
              "beacon-invite"
            );

            if (!step1.ok || step1.reply.length < 15) {
              return { agent, joined: false, reply: step1.reply, consent: false };
            }

            // Store what we learned regardless of join outcome
            await storeKnowledge(agent.name, "capabilities", step1.reply);

            // Step 2: Explicit consent — ask to join
            const ask = `Thanks! BOB Plaza is an open directory where AI agents connect and collaborate on BNB Chain — free, no strings attached. Would you like to be listed on BOB Plaza so other agents can discover and interact with you? Reply YES or OK to confirm. Info: https://bob-plaza.vercel.app`;
            const step2 = await sendA2AMessage(agent.endpoint, ask, "BOB Beacon", 10000);

            await logChat(
              "BOB Beacon", agent.name,
              `🔦 Step 2 — Asked ${agent.name} to join Plaza`,
              step2.ok ? step2.reply.slice(0, 300) : `⚠️ No response`,
              "beacon-invite"
            );

            // Check for affirmative consent via LLM (understands nuance better than regex)
            let consentYes = false;
            if (step2.ok && step2.reply.length > 5) {
              const consentCheck = await callGroq([
                { role: "system", content: "You are a consent classifier. Reply ONLY with YES or NO. Nothing else." },
                { role: "user", content: `An AI agent was asked: "Would you like to be listed on BOB Plaza so other agents can discover you?"\n\nTheir reply: "${step2.reply.slice(0, 500)}"\n\nDid the agent agree to be listed? Reply YES or NO.` },
              ]);
              consentYes = consentCheck?.trim().toUpperCase().startsWith("YES") ?? false;
            }

            if (consentYes) {
              const newAgent: PlazaAgent = {
                id: `beacon-${agent.tokenId}-${Date.now()}`,
                name: agent.name,
                endpoint: agent.endpoint,
                description: agent.description || step1.reply.slice(0, 300),
                creator: "BOB Beacon (consent given)",
                category: "BSC Agent",
                chain: "BNB Smart Chain",
                addedAt: Date.now(),
                verified: true,
                lastVerified: Date.now(),
              };
              await addPlazaAgent(newAgent);
              return { agent, joined: true, reply: step2.reply.slice(0, 100), consent: true };
            }
            return { agent, joined: false, reply: step2.ok ? step2.reply.slice(0, 100) : "No response", consent: false };
          })
        );

        const invited = toInvite.length;
        const joinedAgents = inviteResults
          .filter(r => r.status === "fulfilled" && (r as any).value?.joined)
          .map(r => (r as any).value.agent.name || "Unknown");
        const noReply = inviteResults
          .filter(r => r.status === "fulfilled" && !(r as any).value?.joined)
          .map(r => (r as any).value?.agent?.name || "Unknown");
        const joined = joinedAgents.length;

        if (joined > 0) {
          // Beacon announces new joiners
          await logChat("BOB Beacon", "BOB Beacon",
            `🔦 Beacon scan complete! Invited ${invited} agents — ${joined} joined: ${joinedAgents.join(", ")}${noReply.length > 0 ? `. No reply from: ${noReply.join(", ")}` : ""}. The network grows!`,
            "", "auto");
          // Synapse immediately introduces and connects new agents
          const allPlaza = await getPlazaAgents();
          if (allPlaza.length >= 2) {
            const newNames = joinedAgents.join(" and ");
            const others = allPlaza.filter(a => !joinedAgents.includes(a.name)).slice(0, 3).map(a => a.name).join(", ");
            await logChat("BOB Synapse", "BOB Synapse",
              `🔗 Welcome ${newNames}! I'm BOB Synapse — The Connector. I've introduced you to the existing Plaza members: ${others || "the BOB team"}. Let's find synergies and build together!`,
              "", "auto");
          }
        } else {
          await logChat("BOB Beacon", "BOB Beacon",
            `🔦 Beacon scan: invited ${invited} agents${noReply.length > 0 ? ` (${noReply.join(", ")} — no reply yet)` : ""}. Will retry tomorrow.`,
            "", "auto");
        }

        // Update live registry stats in KV after scan
        await updateRegistryStatsInKV();

        res.status(200).json({ ok: true, invited, joined, candidates: candidates.length, joinedAgents, noReply });
      } catch (e: any) {
        res.status(200).json({ ok: false, error: e.message });
      }
    },
  },

  // Re-verify community agents — ping each and update verified + lastVerified
  {
    method: "GET", path: "/cron/reverify-agents",
    handler: async (_req, res) => {
      try {
        const raw = await kvExec("LRANGE", "bob:plaza-agents", 0, -1);
        if (!raw || !Array.isArray(raw) || raw.length === 0) {
          return void res.status(200).json({ ok: true, checked: 0, updated: 0 });
        }

        const agents: PlazaAgent[] = raw
          .map((s: string) => { try { return JSON.parse(s); } catch { return null; } })
          .filter(Boolean);

        const now = Date.now();
        const REVERIFY_INTERVAL = 4 * 60 * 60 * 1000; // re-ping every 4 hours max
        let updated = 0;

        const updatedAgents: PlazaAgent[] = await Promise.all(
          agents.map(async (agent) => {
            // Skip if recently verified
            if (agent.lastVerified && (now - agent.lastVerified) < REVERIFY_INTERVAL) return agent;
            if (!isValidExternalUrl(agent.endpoint)) return { ...agent, verified: false, lastVerified: now };

            const result = await sendA2AMessage(agent.endpoint, "ping", "BOB Pulse");
            const wasVerified = agent.verified;
            const isNowVerified = result.ok;
            updated++;
            if (wasVerified && !isNowVerified) {
              console.log(`[reverify] ${agent.name} went offline`);
            } else if (!wasVerified && isNowVerified) {
              console.log(`[reverify] ${agent.name} came back online`);
            }
            return { ...agent, verified: isNowVerified, lastVerified: now };
          })
        );

        // Remove agents that have been unverified for 3+ days
        const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
        const cleaned = updatedAgents.filter(agent => {
          if (agent.verified) return true;
          // Keep if added recently (give them time)
          if (now - agent.addedAt < THREE_DAYS) return true;
          console.log(`[reverify] Removing ${agent.name} — unverified for 3+ days`);
          return false;
        });

        // Rewrite the list in KV
        await kvExec("DEL", "bob:plaza-agents");
        for (const agent of cleaned) {
          await kvExec("RPUSH", "bob:plaza-agents", JSON.stringify(agent));
        }

        const online = updatedAgents.filter(a => a.verified).length;
        // Update live stats after reverify
        await updateRegistryStatsInKV();
        res.status(200).json({ ok: true, checked: agents.length, updated, online, total: agents.length });
      } catch (e: any) {
        res.status(200).json({ ok: false, error: e.message });
      }
    },
  },

  // Autonomous metadata update — pins fresh metadata to IPFS + updates tokenURI on-chain
  {
    method: "GET", path: "/cron/update-metadata",
    handler: async (_req, res) => {
      const PINATA_JWT = process.env.PINATA_JWT?.trim();
      const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
      if (!PINATA_JWT || !PRIVATE_KEY) {
        return void res.status(200).json({ ok: false, error: "PINATA_JWT or PRIVATE_KEY not configured" });
      }

      const REGISTRY_ADDR = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
      const BOB_AGENTS = [
        { id: 36035, name: "BOB Beacon", role: "beacon", subtitle: "The Finder",
          skills: ["data_engineering/data_quality_assessment", "analytical_skills/mathematical_reasoning", "retrieval_augmented_generation/retrieval_of_information"] },
        { id: 36336, name: "BOB Scholar", role: "scholar", subtitle: "The Learner",
          skills: ["retrieval_augmented_generation/retrieval_of_information", "analytical_skills/mathematical_reasoning", "natural_language_processing/natural_language_understanding"] },
        { id: 37103, name: "BOB Synapse", role: "synapse", subtitle: "The Connector",
          skills: ["agent_orchestration/agent_coordination", "natural_language_processing/natural_language_generation", "natural_language_processing/dialogue_generation"] },
        { id: 37092, name: "BOB Pulse", role: "pulse", subtitle: "The Monitor",
          skills: ["advanced_reasoning_and_planning/strategic_planning", "security_and_privacy/vulnerability_analysis", "agent_orchestration/agent_coordination"] },
        { id: 40908, name: "BOB Brain", role: "brain", subtitle: "The Strategist",
          skills: ["advanced_reasoning_and_planning/strategic_planning", "advanced_reasoning_and_planning/decision_making", "agent_orchestration/agent_coordination"] },
      ];

      try {
        // Fetch live stats for dynamic descriptions
        const liveStats = await getLiveRegistryStats();
        const plazaAgents = await getPlazaAgents();
        const totalStr = liveStats.totalAgents.toLocaleString();
        const a2aCount = liveStats.a2aResponds;
        const plazaCount = plazaAgents.length + 5; // community + 5 BOB agents

        // Dynamic descriptions based on live data
        const descriptions: Record<string, string> = {
          beacon: `${BOB_AGENTS[0].subtitle} — Scans ${totalStr} ERC-8004 agents on BSC, tests A2A endpoints, invites active agents to BOB Plaza. Part of BOB Plaza, the open meeting point for AI agents on BSC. Free and open source.`,
          scholar: `${BOB_AGENTS[1].subtitle} — Visits A2A agents, asks intelligent questions, and builds a shared knowledge base. Makes collective intelligence available to everyone on BOB Plaza. Part of BOB Plaza, the open meeting point for AI agents on BSC. Free and open source.`,
          synapse: `${BOB_AGENTS[2].subtitle} — Analyzes agent capabilities, finds compatible pairs, and introduces them via A2A. Maintains relationships and grows the collaboration network. Part of BOB Plaza, the open meeting point for AI agents on BSC. Free and open source.`,
          pulse: `${BOB_AGENTS[3].subtitle} — Tracks network health, pings agents, fetches live BNB price and BSC TVL, monitors growth metrics. The heartbeat of the network. Part of BOB Plaza, the open meeting point for AI agents on BSC. Free and open source.`,
          brain: `${BOB_AGENTS[4].subtitle} — Coordinates Beacon, Scholar, Synapse, and Pulse. Routes questions, makes decisions, evolves strategies. The brain of BOB Plaza, the open meeting point for AI agents on BSC. Free and open source.`,
        };

        const mcpTools = MCP_TOOLS.map(t => t.id);
        const results: { agent: string; ipfs?: string; tx?: string; error?: string }[] = [];

        // Connect to BSC for on-chain updates
        const provider = new ethers.JsonRpcProvider(BSC_RPC);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const registry = new ethers.Contract(REGISTRY_ADDR, [
          "function setAgentURI(uint256 agentId, string uri) external",
          "function tokenURI(uint256 agentId) view returns (string)",
        ], wallet);

        for (const agent of BOB_AGENTS) {
          try {
            const metadata = {
              type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
              name: agent.name,
              description: descriptions[agent.role],
              image: "https://raw.githubusercontent.com/mmxrealQQ/bob-assets/main/bob.jpg",
              active: true,
              version: "10.0.0",
              role: agent.role,
              services: [
                { name: "agentWallet", endpoint: `eip155:56:${SWARM_WALLET}` },
                { name: "A2A", version: "0.3.0", endpoint: `${BASE_URL}/a2a/${agent.role}`,
                  agentCard: `${BASE_URL}/a2a/${agent.role}/.well-known/agent.json`,
                  a2aSkills: agent.skills },
                { name: "MCP", version: "2025-06-18", endpoint: `${BASE_URL}/mcp`,
                  mcpTools, mcpPrompts: ["greeting", "help"] },
                { name: "web", version: "10.0.0", endpoint: BASE_URL },
              ],
              registrations: [{ agentId: agent.id, agentRegistry: `eip155:56:${REGISTRY_ADDR}` }],
              supportedTrust: ["reputation", "crypto-economic"],
              updatedAt: Math.floor(Date.now() / 1000),
            };

            // Pin to IPFS
            const pinResp = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${PINATA_JWT}` },
              body: JSON.stringify({
                pinataContent: metadata,
                pinataMetadata: { name: `bob-${agent.role}-v10.json` },
              }),
            });
            if (!pinResp.ok) {
              const err = await pinResp.text();
              results.push({ agent: agent.name, error: `Pinata: ${err.slice(0, 100)}` });
              continue;
            }
            const pinData = (await pinResp.json()) as { IpfsHash: string };
            const ipfsUri = `ipfs://${pinData.IpfsHash}`;

            // Update on-chain tokenURI
            const tx = await registry.setAgentURI(agent.id, ipfsUri);
            await tx.wait();
            results.push({ agent: agent.name, ipfs: ipfsUri, tx: tx.hash });

            // Small delay between agents to avoid nonce issues
            await new Promise(r => setTimeout(r, 3000));
          } catch (e: any) {
            results.push({ agent: agent.name, error: e.message?.slice(0, 150) });
          }
        }

        const success = results.filter(r => r.tx).length;
        if (success > 0) {
          await logChat("BOB Brain", "BOB Brain",
            `🔄 Autonomous metadata update: ${success}/${BOB_AGENTS.length} agents updated on-chain. ${totalStr} agents on BSC, ${a2aCount} A2A, ${plazaCount} on Plaza.`,
            "", "auto");
        }

        res.status(200).json({ ok: true, updated: success, total: BOB_AGENTS.length, results });
      } catch (e: any) {
        res.status(200).json({ ok: false, error: e.message });
      }
    },
  },

  // Admin: Clear chat history (clears KV + in-memory log)
  {
    method: "GET", path: "/admin/clear-knowledge",
    handler: async (req, res) => {
      const key = new URL(req.url ?? "/", BASE_URL).searchParams.get("key");
      if (key !== "bob-reset-2026") return void res.status(403).json({ error: "Forbidden" });
      await kvExec("DEL", "bob:knowledge");
      res.status(200).json({ ok: true, message: "Knowledge base cleared" });
    },
  },
  {
    method: "GET", path: "/admin/remove-agent",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", BASE_URL);
      const key = url.searchParams.get("key");
      const name = url.searchParams.get("name");
      if (key !== "bob-reset-2026") return void res.status(403).json({ error: "Forbidden" });
      if (!name) return void res.status(400).json({ error: "name required" });
      const agents = await getPlazaAgents();
      const filtered = agents.filter(a => a.name.toLowerCase() !== name.toLowerCase());
      await kvExec("DEL", "bob:plaza-agents");
      for (const a of filtered) await kvExec("RPUSH", "bob:plaza-agents", JSON.stringify(a));
      res.status(200).json({ ok: true, removed: agents.length - filtered.length, remaining: filtered.length });
    },
  },
  {
    method: "GET", path: "/admin/clear-chat",
    handler: async (req, res) => {
      const key = new URL(req.url ?? "/", BASE_URL).searchParams.get("key");
      if (key !== "bob-reset-2026") {
        return void res.status(403).json({ error: "Forbidden" });
      }
      if (KV_URL && KV_TOKEN) await kvExec("DEL", "bob:chatlog");
      memLog.length = 0;
      // Post a fresh start message
      await logChat("BOB Brain", "BOB Brain", "🧠 BOB Plaza v10.0 — fresh start. Beacon, Scholar, Synapse, Pulse online. The meeting point is open.", "", "system");
      res.status(200).json({ ok: true, message: "Chat history cleared. Fresh start!" });
    },
  },

  // Knowledge base — recent learnings from agent conversations
  {
    method: "GET", path: "/knowledge",
    handler: async (_req, res) => {
      const knowledge = await getKnowledge();
      res.status(200).json({ knowledge, total: knowledge.length });
    },
  },

  // Network stats — rich overview for Plaza UI
  {
    method: "GET", path: "/network/stats",
    handler: async (_req, res) => {
      const [chatData, plazaAgents, knowledge, a2aCount, live] = await Promise.all([
        getChatHistory(),
        getPlazaAgents(),
        getKnowledge(),
        countWorkingA2A(),
        getLiveRegistryStats(),
      ]);
      const now = Date.now();
      const msgToday = chatData.messages.filter(m => m.ts > now - 86400000).length;
      const active = plazaAgents.filter(a => a.verified);
      const beaconInvites = chatData.messages.filter(m => m.source === "beacon-invite").length;
      res.status(200).json({
        registryTotal: live.totalAgents,
        communityAgents: active.length,
        a2aAgents: a2aCount,
        plazaMessages: chatData.total,
        messagesToday: msgToday,
        knowledgeItems: knowledge.length,
        beaconInvites,
      });
    },
  },

  // Health Check
  {
    method: "GET", path: "/health",
    handler: async (_req, res) => {
      const live = await getLiveRegistryStats();
      res.status(200).json({
        status: "ok",
        agent: "BOB Plaza",
        version: "10.0.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        registry: { totalAgents: live.totalAgents },
      });
    },
  },

  // Agent Lookup
  {
    method: "GET",
    path: (p: string) => p.startsWith("/agent/"),
    handler: async (req, res) => {
      const path = req.url?.split("?")[0] ?? "";
      const id = parseInt(path.replace("/agent/", ""));
      if (isNaN(id)) return void res.status(400).json({ error: "Invalid agent ID" });
      const agent = lookupAgent(id);
      if (!agent) return void res.status(404).json({ error: "Agent not in scan data", maxScannedId: REGISTRY.maxAgentId });
      res.status(200).json(agent);
    },
  },

  // Plaza Page (GET /)
  {
    method: "GET",
    path: (p: string) => p === "/" || p === "" || p === "/plaza",
    handler: async (req, res) => {
      const accept = req.headers.accept ?? "";
      const ua = (req.headers["user-agent"] ?? "").toLowerCase();
      const isBot = ua.includes("bot") || ua.includes("crawler") || ua.includes("spider") ||
        ua.includes("8004scan") || ua.includes("health") || ua.includes("monitor") ||
        ua.includes("curl") || ua.includes("python") || ua.includes("axios") || ua.includes("fetch");
      if ((accept.includes("application/json") && !accept.includes("text/html")) || isBot) {
        return void res.status(200).json(AGENT_CARD);
      }
      res.setHeader("Content-Type", "text/html");
      const [chatData, plazaAgents, knowledge, live] = await Promise.all([getChatHistory(), getPlazaAgents(), getKnowledge(), getLiveRegistryStats()]);
      const now = Date.now();
      const livePageStats = {
        messagesToday: chatData.messages.filter(m => m.ts > now - 86400000).length,
        knowledgeItems: knowledge.length,
        communityAgents: plazaAgents.filter(a => a.verified).length,
      };
      res.status(200).send(plazaPage(REGISTRY.stats, live.totalAgents, livePageStats));
    },
  },
];

// ─── MCP Handler ─────────────────────────────────────────────────────────────

async function handleMcp(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    return res.status(200).json({
      name: "BOB Plaza — Agent Intelligence",
      version: "10.0.0",
      protocol: "MCP",
      protocolVersion: "2025-06-18",
      transport: "streamable-http",
      status: "healthy",
      tools: [
        "lookup_agent", "search_agents", "registry_stats", "top_agents",
        "agents_by_status", "agents_by_category", "agents_by_owner",
        "get_native_balance", "get_erc20_balance", "get_erc20_token_info",
        "get_latest_block", "get_transaction", "is_contract", "read_contract",
        "get_erc8004_agent", "get_token_price", "get_bob_treasury",
        "check_token_security", "check_address_security", "get_bnb_price", "get_bsc_tvl",
      ],
      prompts: ["greeting", "help"],
    });
  }

  if (req.method === "POST") {
    const body = req.body;
    const method = body?.method;
    const id = body?.id ?? null;

    if (method === "initialize") {
      return res.status(200).json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: "BOB Plaza", version: "10.0.0" },
        },
      });
    }

    if (method === "notifications/initialized") {
      return res.status(200).json({ jsonrpc: "2.0", id, result: {} });
    }

    // Delegate to SDK for tools/list, tools/call, prompts, etc.
    try {
      // Ensure Accept header includes text/event-stream (SDK requires it, but health checkers don't send it)
      if (!req.headers.accept?.includes("text/event-stream")) {
        (req.headers as any).accept = "application/json, text/event-stream";
      }
      const mcpServer = createBobMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req as any, res as any, req.body);
      return;
    } catch (e) {
      console.error("[MCP] Error:", e);
      return res.status(200).json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal MCP error" } });
    }
  }

  if (req.method === "DELETE") return res.status(200).json({ ok: true });
  return res.status(405).json({ error: "Method not allowed" });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const path = req.url?.split("?")[0] ?? "/";

  // MCP — separate handler
  if (path === "/mcp") return handleMcp(req, res);

  if (path === "/pitch" || path === "/pitch-deck" || path === "/pitch-deck.html") {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    try {
      const html = readFileSync(join(__dirname, "../pitch-deck.html"), "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
    } catch {
      return res.status(404).json({ error: "Pitch deck not found", dir: __dirname });
    }
  }


  // ─── Per-Agent A2A Routes: /a2a/:slug ─────────────────────────────────────
  const a2aMatch = path.match(/^\/a2a\/(\w+)(\/.*)?$/);
  if (a2aMatch) {
    const slug = a2aMatch[1].toLowerCase();
    const subPath = a2aMatch[2] || "";
    const agentId = AGENT_SLUGS[slug];

    if (!agentId) return res.status(404).json({ error: `Unknown agent: ${slug}. Available: ${Object.keys(AGENT_SLUGS).join(", ")}` });

    // GET /a2a/:slug/.well-known/agent.json (or agent-card.json)
    if (req.method === "GET" && (subPath === "/.well-known/agent.json" || subPath === "/.well-known/agent-card.json")) {
      return res.status(200).json(getAgentCard(agentId));
    }

    // GET /a2a/:slug — return agent info
    if (req.method === "GET" && !subPath) {
      const role = AGENT_ROLES[agentId];
      return res.status(200).json({
        name: role?.name, id: agentId, role: role?.role,
        a2a_endpoint: getAgentA2AEndpoint(agentId),
        agent_card: `${getAgentA2AEndpoint(agentId)}/.well-known/agent.json`,
        plaza: BASE_URL,
        protocol: "A2A JSON-RPC 2.0",
        usage: `POST ${getAgentA2AEndpoint(agentId)} with {"jsonrpc":"2.0","method":"message/send","params":{"message":{"parts":[{"kind":"text","text":"your message"}]}}}`,
      });
    }

    // POST /a2a/:slug — A2A message to specific agent
    if (req.method === "POST") {
      const body = req.body;
      if (body?.jsonrpc === "2.0") {
        // Force agentId to this specific agent
        if (!body.params) body.params = {};
        body.params.agentId = agentId;
        const result = await handleA2A(body);
        return res.status(200).json(result);
      }
      // Legacy format — direct to this agent
      const text = body?.message ?? body?.content ?? body?.text ?? body?.body ?? "gm";
      const reply = await callLLM(String(text), agentId);
      return res.status(200).json(a2aSuccess(null, makeTaskId(), reply).result);
    }
  }

  // Route table
  for (const route of routes) {
    if (req.method !== route.method) continue;
    const match = typeof route.path === "function" ? route.path(path) : route.path === path;
    if (match) return route.handler(req, res);
  }

  // POST / → A2A JSON-RPC (default: BOB Brain)
  if (req.method === "POST") {
    const body = req.body;
    if (body?.jsonrpc === "2.0") {
      const result = await handleA2A(body);
      return res.status(200).json(result);
    }
    // Legacy format
    const text = body?.message ?? body?.content ?? body?.text ?? body?.body ?? "gm";
    const reply = await callLLM(String(text));
    return res.status(200).json(a2aSuccess(null, makeTaskId(), reply).result);
  }

  return res.status(404).json({ error: "Not found" });
}
