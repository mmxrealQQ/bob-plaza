/**
 * BOB MCP Server — Official MCP SDK Implementation
 * Exposes BOB intelligence tools + BNB Chain on-chain tools
 * Built with @modelcontextprotocol/sdk + Streamable HTTP
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  REGISTRY,
  lookupAgent,
  lookupByOwner,
  getTopAgents,
  getByStatus,
  getByCategory,
  formatAgent,
} from "./registry-data.js";

const BSC_RPC = "https://bsc-dataseed1.binance.org";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const ERC8004_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";

// ─── BSC RPC Helpers ────────────────────────────────────────────────────────

async function bscCall(method: string, params: unknown[]): Promise<unknown> {
  const resp = await fetch(BSC_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data = (await resp.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function ethCall(to: string, data: string): Promise<string> {
  const result = await bscCall("eth_call", [{ to, data }, "latest"]);
  return result as string;
}

function padAddress(addr: string): string {
  return addr.replace("0x", "").padStart(64, "0");
}

function padUint256(num: number): string {
  return num.toString(16).padStart(64, "0");
}

// ─── Create MCP Server ──────────────────────────────────────────────────────

export function createBobMcpServer(): McpServer {
  const server = new McpServer({
    name: "BOB — Agent Intelligence Service",
    version: "5.2.0",
  });

  // ════════════════════════════════════════════════════════════════════════
  // BOB Intelligence Tools (from scan data)
  // ════════════════════════════════════════════════════════════════════════

  server.tool(
    "lookup_agent",
    "Look up an ERC-8004 agent on BNB Smart Chain by ID. Returns status, trust score, A2A endpoint, services, and classification from BOB's scan data.",
    { agentId: z.number().describe("The agent ID to look up (e.g. 36035)") },
    async ({ agentId }) => {
      const agent = lookupAgent(agentId);
      if (!agent) {
        return { content: [{ type: "text" as const, text: `Agent #${agentId} not found in scan data. Max scanned: ${REGISTRY.maxAgentId}` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(agent, null, 2) }] };
    }
  );

  server.tool(
    "search_agents",
    "Search the BSC ERC-8004 agent registry by name, category, status, or description. Returns matching agents sorted by trust score.",
    { query: z.string().describe("Search term (name, category, status, or description)") },
    async ({ query }) => {
      const q = query.toLowerCase();
      const results = Object.values(REGISTRY.agents)
        .filter((a: any) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.category.includes(q) || a.status === q)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 20);
      return { content: [{ type: "text" as const, text: JSON.stringify(results.map((a: any) => ({ id: a.id, name: a.name, status: a.status, score: a.score, category: a.category })), null, 2) }] };
    }
  );

  server.tool(
    "registry_stats",
    "Get overall statistics of the ERC-8004 registry on BNB Smart Chain — total agents, active, legit, dead, spam counts, A2A stats.",
    {},
    async () => {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...REGISTRY.stats,
            maxAgentId: REGISTRY.maxAgentId,
            lastScan: new Date(REGISTRY.lastScan).toISOString(),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "top_agents",
    "Get the top agents on BSC by trust score. Returns the highest-rated agents from BOB's scan data.",
    { limit: z.number().optional().default(10).describe("Number of agents to return (max 50)") },
    async ({ limit }) => {
      const top = getTopAgents(Math.min(limit, 50));
      return { content: [{ type: "text" as const, text: JSON.stringify(top.map((a: any) => formatAgent(a)), null, 2) }] };
    }
  );

  server.tool(
    "agents_by_status",
    "Get all agents with a specific status (legit, active, inactive, dead, spam).",
    { status: z.enum(["legit", "active", "inactive", "dead", "spam"]).describe("Agent status to filter by") },
    async ({ status }) => {
      const agents = getByStatus(status);
      return { content: [{ type: "text" as const, text: JSON.stringify(agents.map((a: any) => formatAgent(a)), null, 2) }] };
    }
  );

  server.tool(
    "agents_by_category",
    "Get all agents in a specific category (defi, trading, analytics, gaming, social, infrastructure, security).",
    { category: z.string().describe("Category to filter by") },
    async ({ category }) => {
      const agents = getByCategory(category);
      return { content: [{ type: "text" as const, text: JSON.stringify(agents.map((a: any) => formatAgent(a)), null, 2) }] };
    }
  );

  server.tool(
    "agents_by_owner",
    "Get all agents owned by a specific wallet address.",
    { address: z.string().describe("Owner wallet address (0x...)") },
    async ({ address }) => {
      const agents = lookupByOwner(address);
      return { content: [{ type: "text" as const, text: JSON.stringify(agents.map((a: any) => formatAgent(a)), null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // BNB Chain On-Chain Tools (direct BSC RPC, no subprocess)
  // ════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_native_balance",
    "Get BNB balance for any address on BNB Smart Chain.",
    { address: z.string().describe("Wallet address (0x...)") },
    async ({ address }) => {
      const result = await bscCall("eth_getBalance", [address, "latest"]);
      const wei = BigInt(result as string);
      const bnb = Number(wei) / 1e18;
      return { content: [{ type: "text" as const, text: `${bnb.toFixed(6)} BNB` }] };
    }
  );

  server.tool(
    "get_erc20_balance",
    "Get ERC20 token balance for an address on BSC. Returns the token balance.",
    {
      tokenAddress: z.string().describe("Token contract address (0x...)"),
      walletAddress: z.string().describe("Wallet address to check (0x...)"),
    },
    async ({ tokenAddress, walletAddress }) => {
      const data = "0x70a08231" + padAddress(walletAddress);
      const result = await ethCall(tokenAddress, data);
      if (!result || result === "0x") return { content: [{ type: "text" as const, text: "0" }] };
      const raw = BigInt(result);
      // Get decimals
      let decimals = 18;
      try {
        const decResult = await ethCall(tokenAddress, "0x313ce567"); // decimals()
        decimals = Number(BigInt(decResult));
      } catch {}
      const balance = Number(raw) / Math.pow(10, decimals);
      return { content: [{ type: "text" as const, text: balance.toLocaleString("en-US", { maximumFractionDigits: 4 }) }] };
    }
  );

  server.tool(
    "get_erc20_token_info",
    "Get ERC20 token information on BSC: name, symbol, decimals, total supply.",
    { tokenAddress: z.string().describe("Token contract address (0x...)") },
    async ({ tokenAddress }) => {
      const decodeString = (hex: string): string => {
        if (!hex || hex === "0x") return "unknown";
        try {
          const stripped = hex.slice(2);
          const offset = parseInt(stripped.slice(0, 64), 16) * 2;
          const length = parseInt(stripped.slice(offset, offset + 64), 16);
          const bytes = stripped.slice(offset + 64, offset + 64 + length * 2);
          return Buffer.from(bytes, "hex").toString("utf8");
        } catch {
          return "unknown";
        }
      };

      const [nameHex, symbolHex, decHex, supplyHex] = await Promise.all([
        ethCall(tokenAddress, "0x06fdde03").catch(() => "0x"),  // name()
        ethCall(tokenAddress, "0x95d89b41").catch(() => "0x"),  // symbol()
        ethCall(tokenAddress, "0x313ce567").catch(() => "0x12"), // decimals()
        ethCall(tokenAddress, "0x18160ddd").catch(() => "0x"),   // totalSupply()
      ]);

      const decimals = Number(BigInt(decHex));
      const supply = supplyHex !== "0x" ? Number(BigInt(supplyHex)) / Math.pow(10, decimals) : 0;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            address: tokenAddress,
            name: decodeString(nameHex),
            symbol: decodeString(symbolHex),
            decimals,
            totalSupply: supply.toLocaleString("en-US"),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_latest_block",
    "Get the latest block number and timestamp on BNB Smart Chain.",
    {},
    async () => {
      const result = await bscCall("eth_getBlockByNumber", ["latest", false]);
      const block = result as { number: string; timestamp: string; gasUsed: string; transactions: string[] };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            number: parseInt(block.number, 16),
            timestamp: new Date(parseInt(block.timestamp, 16) * 1000).toISOString(),
            gasUsed: parseInt(block.gasUsed, 16),
            txCount: block.transactions?.length ?? 0,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_transaction",
    "Get transaction details by hash on BSC.",
    { txHash: z.string().describe("Transaction hash (0x...)") },
    async ({ txHash }) => {
      const tx = await bscCall("eth_getTransactionByHash", [txHash]);
      if (!tx) return { content: [{ type: "text" as const, text: "Transaction not found" }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(tx, null, 2) }] };
    }
  );

  server.tool(
    "is_contract",
    "Check if an address is a smart contract or externally owned account (EOA) on BSC.",
    { address: z.string().describe("Address to check (0x...)") },
    async ({ address }) => {
      const code = await bscCall("eth_getCode", [address, "latest"]);
      const isContract = code !== "0x" && code !== "0x0";
      return { content: [{ type: "text" as const, text: isContract ? `${address} is a smart contract` : `${address} is an EOA (externally owned account)` }] };
    }
  );

  server.tool(
    "read_contract",
    "Call a read-only function on any BSC smart contract. Provide the contract address and encoded call data.",
    {
      contractAddress: z.string().describe("Contract address (0x...)"),
      callData: z.string().describe("ABI-encoded function call data (0x...)"),
    },
    async ({ contractAddress, callData }) => {
      const result = await ethCall(contractAddress, callData);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // ERC-8004 Registry Tools (on-chain reads)
  // ════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_erc8004_agent",
    "Get on-chain ERC-8004 agent info: owner and tokenURI (metadata URI). Reads directly from BSC.",
    { agentId: z.number().describe("Agent ID to look up") },
    async ({ agentId }) => {
      try {
        // ownerOf(uint256)
        const ownerHex = await ethCall(ERC8004_REGISTRY, "0x6352211e" + padUint256(agentId));
        const owner = "0x" + ownerHex.slice(26);

        // tokenURI(uint256)
        const uriHex = await ethCall(ERC8004_REGISTRY, "0xc87b56dd" + padUint256(agentId));
        let tokenURI = "unknown";
        try {
          const stripped = uriHex.slice(2);
          const offset = parseInt(stripped.slice(0, 64), 16) * 2;
          const length = parseInt(stripped.slice(offset, offset + 64), 16);
          const bytes = stripped.slice(offset + 64, offset + 64 + length * 2);
          tokenURI = Buffer.from(bytes, "hex").toString("utf8");
        } catch {}

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ agentId, owner, tokenURI, registry: ERC8004_REGISTRY, chain: "BSC (56)" }, null, 2),
          }],
        };
      } catch {
        return { content: [{ type: "text" as const, text: `Agent #${agentId} not found on-chain or does not exist.` }] };
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // Market Data Tools
  // ════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_token_price",
    "Get live price, 24h change, liquidity, and volume for any BSC token via DexScreener.",
    { tokenAddress: z.string().describe("Token contract address on BSC (0x...)") },
    async ({ tokenAddress }) => {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) return { content: [{ type: "text" as const, text: "Failed to fetch price data" }] };
      const data = (await resp.json()) as { pairs?: any[] };
      const pair = data.pairs?.[0];
      if (!pair) return { content: [{ type: "text" as const, text: "No trading pairs found for this token" }] };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            price: pair.priceUsd,
            change24h: pair.priceChange?.h24,
            volume24h: pair.volume?.h24,
            liquidity: pair.liquidity?.usd,
            pairAddress: pair.pairAddress,
            dex: pair.dexId,
            baseToken: pair.baseToken,
            quoteToken: pair.quoteToken,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_bob_treasury",
    "Get BOB's treasury: BNB balance, $BOB balance, and live $BOB price.",
    {},
    async () => {
      const [bnbResult, bobResult, priceResp] = await Promise.all([
        bscCall("eth_getBalance", [SWARM_WALLET, "latest"]).catch(() => "0x0"),
        ethCall(BOB_TOKEN, "0x70a08231" + padAddress(SWARM_WALLET)).catch(() => "0x0"),
        fetch(`https://api.dexscreener.com/latest/dex/tokens/${BOB_TOKEN}`).catch(() => null),
      ]);

      const bnb = Number(BigInt(bnbResult as string)) / 1e18;
      const bob = Number(BigInt(bobResult as string)) / 1e18;

      let price = null;
      if (priceResp && priceResp.ok) {
        const priceData = (await priceResp.json()) as { pairs?: any[] };
        const pair = priceData.pairs?.[0];
        if (pair) price = { usd: pair.priceUsd, change24h: pair.priceChange?.h24, liquidity: pair.liquidity?.usd };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            wallet: SWARM_WALLET,
            bnbBalance: bnb.toFixed(6),
            bobBalance: bob.toLocaleString("en-US"),
            bobToken: BOB_TOKEN,
            bobPrice: price,
          }, null, 2),
        }],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // Free External API Tools (GoPlus, CoinGecko, DefiLlama)
  // ════════════════════════════════════════════════════════════════════════

  server.tool(
    "check_token_security",
    "GoPlus Security check for any BSC token — detects honeypots, scams, tax, ownership risks.",
    { tokenAddress: z.string().describe("Token contract address (0x...)") },
    async ({ tokenAddress }) => {
      try {
        const resp = await fetch(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`);
        if (!resp.ok) return { content: [{ type: "text" as const, text: "GoPlus API error" }] };
        const data = (await resp.json()) as any;
        const info = data.result?.[tokenAddress.toLowerCase()];
        if (!info) return { content: [{ type: "text" as const, text: "Token not found in GoPlus" }] };
        return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "check_address_security",
    "GoPlus address security — checks if a wallet is linked to phishing, scams, sanctions.",
    { address: z.string().describe("Wallet address (0x...)") },
    async ({ address }) => {
      try {
        const resp = await fetch(`https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=56`);
        if (!resp.ok) return { content: [{ type: "text" as const, text: "GoPlus API error" }] };
        const data = (await resp.json()) as any;
        return { content: [{ type: "text" as const, text: JSON.stringify(data.result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "get_bnb_price",
    "Live BNB price and 24h change from CoinGecko.",
    {},
    async () => {
      try {
        const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true");
        if (!resp.ok) return { content: [{ type: "text" as const, text: "CoinGecko API error" }] };
        const data = (await resp.json()) as any;
        return { content: [{ type: "text" as const, text: JSON.stringify(data.binancecoin, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "get_bsc_tvl",
    "BSC Total Value Locked from DefiLlama.",
    {},
    async () => {
      try {
        const resp = await fetch("https://api.llama.fi/v2/chains");
        if (!resp.ok) return { content: [{ type: "text" as const, text: "DefiLlama API error" }] };
        const chains = (await resp.json()) as any[];
        const bsc = chains.find((c: any) => c.name === "BSC");
        return { content: [{ type: "text" as const, text: JSON.stringify(bsc, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // MCP Prompts
  // ════════════════════════════════════════════════════════════════════════

  server.prompt(
    "greeting",
    "BOB's greeting — introduces the agent and its capabilities",
    {},
    () => ({
      messages: [{
        role: "user",
        content: { type: "text", text: "Introduce yourself. What can you do?" },
      }],
    })
  );

  server.prompt(
    "help",
    "Help prompt — explains available MCP tools and how to use them",
    {},
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Available tools:
- lookup_agent: Check any BSC agent by ID
- search_agents: Search registry by name/category/status
- registry_stats: Full registry statistics
- top_agents: Best agents by trust score
- agents_by_status: Filter by legit/active/dead/spam
- agents_by_category: Filter by defi/trading/analytics etc.
- agents_by_owner: Find agents by wallet address
- get_native_balance: BNB balance for any address
- get_erc20_balance: Token balance on BSC
- get_erc20_token_info: Token name/symbol/supply
- get_latest_block: Current BSC block
- get_transaction: TX details by hash
- is_contract: Check if address is contract or EOA
- read_contract: Call any read-only contract function
- get_erc8004_agent: On-chain agent data from registry
- get_token_price: Live token price via DexScreener
- get_bob_treasury: BOB wallet balances and $BOB price
- check_token_security: GoPlus honeypot/scam check for any BSC token
- check_address_security: GoPlus wallet risk check (phishing, sanctions)
- get_bnb_price: Live BNB price from CoinGecko
- get_bsc_tvl: BSC Total Value Locked from DefiLlama`,
        },
      }],
    })
  );

  return server;
}
