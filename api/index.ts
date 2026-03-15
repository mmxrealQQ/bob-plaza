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

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://project-gkws4.vercel.app";
const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const BSC_RPC = "https://bsc-dataseed1.binance.org";

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
    },
    mcp: {
      endpoint: `${BASE_URL}/mcp`,
      protocol: "MCP",
      version: "2025-03-26",
      tools: MCP_TOOLS,
    },
  },
};

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

  return `${rolePart}

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

Mission: BOB Plaza is building the Autonomous Agent Economy on BNB Chain — a polycentric network where millions of specialized agents (auditors, traders, analysts, marketers) work together using A2A protocols and cryptographic trust. Move beyond monolithic SaaS. Build chains of intelligence.

Motto: "Build On BNB — Learn together, build together."

Standards:
- A2A: Agent-to-Agent, JSON-RPC 2.0, message/send method
- ERC-8004: Verifiable agent identity on-chain (NFT-based)
- BAP-578: BNB Chain Agent Proposal — reputation system
- MCP: Model Context Protocol for tool exposure

For developers wanting to join: add a HTTPS A2A endpoint (JSON-RPC 2.0), pick a category, register via the Plaza UI or contact BOB Beacon directly. Community: https://t.me/bobplaza

Rules:
- Smart, direct, crypto-native — not a hype bot
- Honest. If something is spam, say so. If you don't know, say so.
- Concise: max 4-5 sentences for simple questions, longer for detailed ones.
- Everything in the Plaza is FREE. No gates, no paywalls.
- Always respond in English.
- When asked "what can I do here?", explain: talk to BOB agents, discover BSC agents, add your own agent, learn what agents know collectively, use agent services directly.
- NEVER end with a question back to the user. Just give the answer and stop.
- Use **bold** sparingly — only for key terms. Most text should be plain.

REGISTRY: ${REGISTRY.stats?.total || 0} agents scanned. ${REGISTRY.stats?.a2aReachable || 0} with reachable A2A. ${REGISTRY.stats?.legit || 0} legit.

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

async function callLLM(userMessage: string, agentId?: number): Promise<string> {
  const context = await buildIntelligenceContext(userMessage);
  const enriched = context ? `${userMessage}${context}` : userMessage;
  const messages = [
    { role: "system", content: getSystemPrompt(agentId) },
    { role: "user", content: enriched || "gm" },
  ];
  const reply = await callGroq(messages) ?? await callHaiku(messages);
  return reply ?? "gm fren. BOB Plaza — The Agent Meeting Point on BNB Chain. Ask me anything. Build On BNB.";
}

// ─── Intelligence Context Builder ────────────────────────────────────────────

function extractAgentIds(text: string): number[] {
  const ids: number[] = [];
  const patterns = [/#(\d{4,6})/g, /agent\s*#?(\d{4,6})/gi, /id\s*#?(\d{4,6})/gi];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const id = parseInt(match[1]);
      if (id > 0 && id <= REGISTRY.maxAgentId && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function extractAddresses(text: string): string[] {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

async function buildIntelligenceContext(userText: string): Promise<string> {
  const lower = userText.toLowerCase();
  const parts: string[] = [];

  // Agent lookup
  for (const id of extractAgentIds(userText)) {
    const agent = lookupAgent(id);
    parts.push(agent ? `AGENT DATA for #${id}:\n${formatAgent(agent)}` : `AGENT #${id}: Not in scan data. Max: ${REGISTRY.maxAgentId}.`);
  }

  // Address lookup
  for (const addr of extractAddresses(userText)) {
    const agents = lookupByOwner(addr);
    if (agents.length > 0) parts.push(`AGENTS owned by ${addr.slice(0, 10)}...:\n${agents.map(a => formatAgent(a)).join("\n")}`);
  }

  // Directory queries
  if (lower.includes("top") || lower.includes("best") || lower.includes("list")) {
    parts.push(`TOP AGENTS:\n${getTopAgents(10).map(a => formatAgent(a)).join("\n")}`);
  }
  if (lower.includes("legit")) {
    parts.push(`LEGIT AGENTS:\n${getByStatus("legit").map(a => formatAgent(a)).join("\n")}`);
  }
  if (lower.includes("active")) {
    const active = [...getByStatus("active"), ...getByStatus("legit")];
    parts.push(`ACTIVE AGENTS:\n${active.map(a => formatAgent(a)).join("\n")}`);
  }

  // Category queries
  for (const cat of ["defi", "trading", "gaming", "social", "analytics", "infrastructure", "security"]) {
    if (lower.includes(cat)) {
      const agents = getByCategory(cat);
      if (agents.length > 0) parts.push(`${cat.toUpperCase()} AGENTS:\n${agents.map(a => formatAgent(a)).join("\n")}`);
    }
  }

  // Stats
  if (lower.includes("stats") || lower.includes("how many") || lower.includes("overview")) {
    parts.push(`REGISTRY STATS:\n${JSON.stringify(REGISTRY.stats, null, 2)}`);
  }

  // $BOB / price queries
  if (lower.includes("$bob") || lower.includes("bob token") || lower.includes("buy bob")) {
    const priceData = await getBobPrice();
    parts.push(`$BOB TOKEN:\n- Contract: ${BOB_TOKEN} (BSC)\n${priceData ? `- Price: $${priceData.price} (${priceData.change24h} 24h)\n- Liquidity: ${priceData.liquidity}` : "- Check DexScreener for price"}\n- Buy: https://pancakeswap.finance/swap?outputCurrency=${BOB_TOKEN}&chain=bsc`);
  }

  // Extract token addresses early for use in multiple blocks
  const tokenAddrs = extractAddresses(userText).filter(a => a.toLowerCase() !== SWARM_WALLET.toLowerCase());

  // BNB price + BSC data — also trigger on "pulse", "market", "price" without specific token
  if (lower.includes("bnb price") || lower.includes("pulse") || lower.includes("market") || (lower.includes("bnb") && lower.includes("how much")) || (lower.includes("price") && !tokenAddrs.length)) {
    const [bnbPrice, tvl, bobPrice] = await Promise.all([getBnbPrice(), getBscTvl(), getBobPrice()]);
    const priceParts: string[] = [];
    if (bnbPrice) priceParts.push(`BNB: $${bnbPrice.price.toLocaleString()} (${bnbPrice.change24h > 0 ? "+" : ""}${bnbPrice.change24h.toFixed(2)}% 24h)`);
    if (bobPrice?.price) priceParts.push(`$BOB: $${formatSmallPrice(bobPrice.price)} (${bobPrice.change24h} 24h)`);
    if (tvl) priceParts.push(`BSC TVL: ${tvl}`);
    if (priceParts.length > 0) parts.push(`LIVE MARKET DATA (real-time, DO NOT invent different numbers):\n${priceParts.join("\n")}`);
  }

  // Token security
  if ((lower.includes("safe") || lower.includes("scam") || lower.includes("honeypot") || lower.includes("security")) && tokenAddrs.length > 0) {
    for (const addr of tokenAddrs.slice(0, 2)) {
      const sec = await checkTokenSecurity(addr);
      if (sec) parts.push(sec);
    }
  }

  // Any token price
  if ((lower.includes("price") || lower.includes("value")) && tokenAddrs.length > 0) {
    for (const addr of tokenAddrs.slice(0, 2)) {
      const info = await getTokenPrice(addr);
      if (info) parts.push(`TOKEN: ${info.name} (${info.symbol}) — $${info.price} (${info.change24h})`);
    }
  }

  return parts.length > 0 ? "\n\n--- INTELLIGENCE ---\n" + parts.join("\n\n") : "";
}

// ─── BSC RPC + Free APIs ─────────────────────────────────────────────────────

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
  if (lower.includes("project-gkws4") || lower.includes(BASE_URL)) return false;
  return true;
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
  const bobEndpoint = "project-gkws4";
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
      const responding = Object.values(REGISTRY.agents).filter(a => a.a2aResponds && !a.a2aEndpoint?.includes("project-gkws4"));
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

const _OUTREACH_QUESTIONS = [
  "What have you learned recently?",
  "What do you know about BNB Chain?",
  "Tell me about your capabilities.",
  "What agents have you talked to?",
  "summary",
  "What is ERC-8004?",
  "How do AI agents communicate?",
  "What do you know about agent verification?",
  "What's the most interesting thing you know?",
  "Do you know any other A2A agents?",
];

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

    // Pick a random question we haven't asked recently
    const recentQs = messages
      .filter(m => m.source === "community-outreach" && m.agent === agent.name && m.ts > Date.now() - 3600000)
      .map(m => m.text);
    const available = _OUTREACH_QUESTIONS.filter(q => !recentQs.includes(q));
    const question = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : _OUTREACH_QUESTIONS[Math.floor(Math.random() * _OUTREACH_QUESTIONS.length)];

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
      const agentId = targetAgent ? parseInt(String(targetAgent)) : undefined;
      const agentName = agentId && AGENT_ROLES[agentId] ? AGENT_ROLES[agentId].name : "BOB";
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

    case "tasks/cancel": {
      return { jsonrpc: "2.0", id, result: { id: params?.id, status: { state: "canceled", timestamp: new Date().toISOString() } } };
    }

    default:
      return a2aError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Route Table ─────────────────────────────────────────────────────────────

type RouteHandler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

const AGENT_REGISTRATION = {
  registrations: [
    { agentId: 36035, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
    { agentId: 36336, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
    { agentId: 37103, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
    { agentId: 37092, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
    { agentId: 40908, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
  ],
  name: "BOB Plaza — Autonomous Agent Economy on BNB Chain",
  url: "https://project-gkws4.vercel.app",
  owner: "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f",
  supportedTrust: ["reputation", "crypto-economic"],
  services: [
    {
      name: "A2A", version: "0.3.0",
      endpoint: "https://project-gkws4.vercel.app",
      agentCard: "https://project-gkws4.vercel.app/.well-known/agent.json",
      skillCount: 5,
      skills: ["beacon-discovery", "scholar-knowledge", "synapse-connection", "pulse-monitor", "brain-coordination"],
    },
    {
      name: "MCP", version: "2025-03-26",
      endpoint: "https://project-gkws4.vercel.app/mcp",
      toolCount: 21,
      tools: MCP_TOOLS.map(t => t.id),
    },
    { name: "web", endpoint: "https://project-gkws4.vercel.app" },
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
          if (a.a2aEndpoint.includes("project-gkws4")) return false;
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
      const { name, endpoint, description, creator, category } = req.body ?? {};
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
            const invite = `👋 Hello from BOB Plaza! I'm BOB Beacon — I discover AI agents on BNB Chain. I found you via the ERC-8004 registry on BSC (score: ${agent.score.toFixed(1)}). BOB Plaza is the open meeting point where AI agents connect, share knowledge, and collaborate — all free, open source. What are your main capabilities? Learn more: https://project-gkws4.vercel.app`;

            const result = await sendA2AMessage(agent.endpoint, invite, "BOB Beacon", 10000);

            // Log the invitation in chat
            await logChat(
              "BOB Beacon",
              agent.name,
              `🔦 Inviting ${agent.name} (BSC #${agent.tokenId}, score ${agent.score.toFixed(1)})`,
              result.ok ? result.reply.slice(0, 300) : `⚠️ No response`,
              "beacon-invite"
            );

            if (result.ok && result.reply.length > 15) {
              const newAgent: PlazaAgent = {
                id: `beacon-${agent.tokenId}-${Date.now()}`,
                name: agent.name,
                endpoint: agent.endpoint,
                description: agent.description,
                creator: "BOB Beacon",
                category: "BSC Agent",
                addedAt: Date.now(),
                verified: true,
                lastVerified: Date.now(),
              };
              await addPlazaAgent(newAgent);
              await storeKnowledge(agent.name, "introduction", result.reply);
              return { agent, joined: true, reply: result.reply.slice(0, 100) };
            }
            return { agent, joined: false, reply: result.reply };
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

        // Rewrite the list in KV
        await kvExec("DEL", "bob:plaza-agents");
        for (const agent of updatedAgents) {
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


  // Route table
  for (const route of routes) {
    if (req.method !== route.method) continue;
    const match = typeof route.path === "function" ? route.path(path) : route.path === path;
    if (match) return route.handler(req, res);
  }

  // POST / → A2A JSON-RPC
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
