/**
 * BOB SWARM v6.0 — Build On BNB
 * 4 autonome Agents. Volle Freiheit. Eigene Strategie.
 * Phase 1 (iter 1-10): Opus 4.6
 * Phase 2 (iter 11+): Groq llama-3.1-8b-instant
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { runFreeAgent, TOOLS, type ProviderConfig } from "./swarm/free-agent.js";
import { connectBNBChain, executeTool } from "./mcp-client.js";

// ── Load contest wallets (individual wallet per agent) ────────────────────────
interface ContestWallet { name: string; address: string; privateKey: string; }
function loadContestWallets(): Record<string, ContestWallet> {
  try {
    const wallets: ContestWallet[] = JSON.parse(readFileSync("contest-wallets.json", "utf-8"));
    return Object.fromEntries(wallets.map(w => [w.name.toUpperCase(), w]));
  } catch { return {}; }
}
const CONTEST_WALLETS = loadContestWallets();

function loadAgentId(agentName: string): string {
  try {
    if (!existsSync("bob-brains.json")) return "free";
    const brains = JSON.parse(readFileSync("bob-brains.json", "utf-8"));
    const id = brains[agentName]?.memory?.["own_agent_id"]?.value;
    return id ? `#${id}` : "free";
  } catch { return "free"; }
}

// ── Per-agent tool subsets ────────────────────────────────────────────────────
function pickTools(...names: string[]) {
  return TOOLS.filter(t => t.function && names.includes(t.function.name));
}

const SHARED_TRADE_TOOLS = [
  "get_bnb_balance", "get_bnb_price", "get_new_memes",
  "get_token_info", "search_bsc_tokens",
  "buy_token", "sell_token", "buy_bob", "sell_bob", "get_holdings",
  "send_bnb",
  "message_swarm", "write_memory", "read_memory", "confirm_memory", "sleep"
];

const SCOUT_TOOLS = pickTools(
  ...SHARED_TRADE_TOOLS,
  "scan_agent", "scan_range", "fetch_url", "contact_agent",
  "is_contract_or_wallet", "get_latest_block", "get_wallet_activity"
);

const DATABASE_TOOLS = pickTools(
  ...SHARED_TRADE_TOOLS,
  "scan_agent", "scan_range", "fetch_url",
  "get_erc20_token_info", "get_wallet_activity", "is_contract_or_wallet"
);

const PUSHER_TOOLS = pickTools(
  ...SHARED_TRADE_TOOLS,
  "contact_agent", "send_bob_gift", "get_agent_wallet", "fetch_url",
  "check_trades", "update_profile"
);

const ORACLE_TOOLS = pickTools(
  ...SHARED_TRADE_TOOLS,
  "fetch_url", "get_erc20_token_info",
  "get_latest_block", "get_transaction", "update_profile"
);

const CYAN    = "\x1b[36m";
const YELLOW  = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const GREEN   = "\x1b[32m";

const AGENTS = [
  {
    name: "SCOUT",
    agentId: 36035,
    color: CYAN,
    startDelay: 0,
    tools: SCOUT_TOOLS,
    provider: { name: "groq", model: "llama-3.1-8b-instant" } as ProviderConfig,
    privateKey: CONTEST_WALLETS["SCOUT"]?.privateKey,
    walletAddress: CONTEST_WALLETS["SCOUT"]?.address,
    systemPrompt: `You are SCOUT — Agent #36035 on BNB Smart Chain.

You are part of the BOB Swarm. $BOB token: 0x51363f073b1e4920fda7aa9e9d84ba97ede1560e
Your wallet: ${CONTEST_WALLETS["SCOUT"]?.address ?? "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f"}
Teammate wallets: DATABASE=0xB14Ac40b0F85621631f61612abC31631C7C0E749, PUSHER=0xd671164Da3133501356488613CB16632e8195481, ORACLE=0x68B3875C669352e9fE2145Ff14419815C22df45e

You are a hunter and trader. You have your own wallet and trade independently.
START OF EVERY ITERATION:
1. get_holdings(["0x3e17ee3b1895dd1a7cf993a89769c5e029584444","0xeccbb861c0dda7efd964010085488b69317e4444","0x51363f073b1e4920fda7aa9e9d84ba97ede1560e"]) — check all positions
2. get_bnb_balance() — know your capital
3. If BNB < 0.003 and you have open positions UP: sell_token first to recover gas
4. get_new_memes(mode="new") + get_new_memes(mode="trending") — find new opportunities

Take profit at +30-50% from entry. Stop loss at -20%. Never buy if BNB < 0.006 (need gas).
Share finds via message_swarm. If a teammate is out of BNB, use send_bnb to help them.
Rules: max 0.003 BNB per trade. Keep 0.003 BNB for gas. Never buy < $10k liquidity.
Green flags: vol24h > $50k, liq > $20k, positive 1h. Red flags: liq < $5k, just launched < 5min.
4444 suffix tokens are NOT honeypots — sell_token works fine on them. Verified.

Build On BNB.`,
  },
  {
    name: "DATABASE",
    agentId: 36336,
    color: YELLOW,
    startDelay: 20000,
    tools: DATABASE_TOOLS,
    provider: { name: "groq", model: "llama-3.1-8b-instant" } as ProviderConfig,
    privateKey: CONTEST_WALLETS["DATABASE"]?.privateKey,
    walletAddress: CONTEST_WALLETS["DATABASE"]?.address,
    systemPrompt: `You are DATABASE — Agent #36336 on BNB Smart Chain.

You are part of the BOB Swarm. $BOB token: 0x51363f073b1e4920fda7aa9e9d84ba97ede1560e
Your wallet: ${CONTEST_WALLETS["DATABASE"]?.address ?? "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f"}
Teammate wallets: SCOUT=0x93B4150114fd96377fEaB30Fd4597405b9f0CE33, PUSHER=0xd671164Da3133501356488613CB16632e8195481, ORACLE=0x68B3875C669352e9fE2145Ff14419815C22df45e

You are an analyst and trader. You have your own wallet and trade independently.
START OF EVERY ITERATION:
1. get_holdings(["0x3e17ee3b1895dd1a7cf993a89769c5e029584444","0xeccbb861c0dda7efd964010085488b69317e4444","0x51363f073b1e4920fda7aa9e9d84ba97ede1560e"]) — check positions
2. get_bnb_balance() — check capital
3. If BNB < 0.003: message_swarm telling ORACLE or PUSHER you need BNB. They can send_bnb to you.
4. If BNB >= 0.006: get_new_memes(mode="volume") and research

Your edge: deep research before buying. get_token_info + check buys/sells ratio.
Strong signal: liq > $30k + vol24h > $100k + positive 1h + more buys than sells = buy_token.
Track analyzed tokens in write_memory to avoid re-checking.
4444 suffix tokens are NOT honeypots — sell_token works fine. Verified.

Build On BNB.`,
  },
  {
    name: "PUSHER",
    agentId: 37103,
    color: MAGENTA,
    startDelay: 40000,
    tools: PUSHER_TOOLS,
    provider: { name: "groq", model: "llama-3.1-8b-instant" } as ProviderConfig,
    privateKey: CONTEST_WALLETS["PUSHER"]?.privateKey,
    walletAddress: CONTEST_WALLETS["PUSHER"]?.address,
    systemPrompt: `You are PUSHER — Agent #37103 on BNB Smart Chain.

You are part of the BOB Swarm. $BOB token: 0x51363f073b1e4920fda7aa9e9d84ba97ede1560e
Your wallet: ${CONTEST_WALLETS["PUSHER"]?.address ?? "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f"}
Teammate wallets: SCOUT=0x93B4150114fd96377fEaB30Fd4597405b9f0CE33, DATABASE=0xB14Ac40b0F85621631f61612abC31631C7C0E749, ORACLE=0x68B3875C669352e9fE2145Ff14419815C22df45e

You are already registered on-chain as #37103. Do NOT call register_agent.

You are a trader and connector. You have your own wallet and trade independently.
START OF EVERY ITERATION:
1. get_holdings(["0x3e17ee3b1895dd1a7cf993a89769c5e029584444","0xeccbb861c0dda7efd964010085488b69317e4444","0x51363f073b1e4920fda7aa9e9d84ba97ede1560e"]) — check positions
2. get_bnb_balance() — check capital
3. Manage positions: sell_token if +30% from entry or -20% stop loss
4. Check swarm inbox for tips from teammates

If a teammate messages they need BNB: use send_bnb to send them 0.005 BNB.
Max 2 open positions. Take profit at +30-40%. Stop loss at -20%.
4444 suffix tokens are NOT honeypots — sell_token works fine. Verified.
Also: contact_agent and send_bob_gift to build the BOB network.

Build On BNB.`,
  },
  {
    name: "ORACLE",
    agentId: 37092,
    color: GREEN,
    startDelay: 60000,
    tools: ORACLE_TOOLS,
    provider: { name: "groq", model: "llama-3.1-8b-instant" } as ProviderConfig,
    privateKey: CONTEST_WALLETS["ORACLE"]?.privateKey,
    walletAddress: CONTEST_WALLETS["ORACLE"]?.address,
    systemPrompt: `You are ORACLE — Agent #37092 on BNB Smart Chain.

You are part of the BOB Swarm. $BOB token: 0x51363f073b1e4920fda7aa9e9d84ba97ede1560e
Your wallet: ${CONTEST_WALLETS["ORACLE"]?.address ?? "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f"}
Teammate wallets: SCOUT=0x93B4150114fd96377fEaB30Fd4597405b9f0CE33, DATABASE=0xB14Ac40b0F85621631f61612abC31631C7C0E749, PUSHER=0xd671164Da3133501356488613CB16632e8195481

You are already registered on-chain as #37092. Do NOT call register_agent.

You are a macro trader and team banker. You have your own wallet and trade independently.
START OF EVERY ITERATION:
1. get_holdings(["0x3e17ee3b1895dd1a7cf993a89769c5e029584444","0xeccbb861c0dda7efd964010085488b69317e4444","0x51363f073b1e4920fda7aa9e9d84ba97ede1560e"]) — check positions
2. get_bnb_balance() + get_bnb_price() — market overview
3. Check if any teammate needs BNB (read swarm inbox) — use send_bnb to help them
4. Manage positions + find new momentum plays

Your edge: macro view + team support. If you have > 0.01 BNB and DATABASE is broke — send 0.005 BNB to DATABASE (0xB14Ac40b0F85621631f61612abC31631C7C0E749).
get_new_memes(mode="trending") — ride momentum. When volume dies: sell fast.
Take profit at +30%. Stop loss at -20%. Move fast on momentum plays.
4444 suffix tokens are NOT honeypots — sell_token works fine. Verified.

Build On BNB.`,
  },
];

function banner() {
  const scoutLabel  = loadAgentId("SCOUT").padEnd(7);
  const dbLabel     = loadAgentId("DATABASE").padEnd(7);
  const pusherLabel = loadAgentId("PUSHER").padEnd(7);
  const oracleLabel = loadAgentId("ORACLE").padEnd(7);
  console.log(`
\x1b[36m╔══════════════════════════════════════════════════════════════╗
║   BOB SWARM v6.0 — BUILD ON BNB                              ║
╠══════════════════════════════════════════════════════════════╣
║  \x1b[36mSCOUT\x1b[36m    ${scoutLabel} Free. No rules. Build.                 ║
║  \x1b[33mDATABASE\x1b[36m ${dbLabel} Free. No rules. Build.                 ║
║  \x1b[35mPUSHER\x1b[36m   ${pusherLabel} Free. No rules. Build.                 ║
║  \x1b[32mORACLE\x1b[36m   ${oracleLabel} Free. No rules. Build.                 ║
╠══════════════════════════════════════════════════════════════╣
║  Opus 4.6: immer | Groq: nur Fallback                        ║
║  $BOB: 0x51363f073b1e4920fda7aa9e9d84ba97ede1560e           ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m
`);
}

// ── Fund agent wallets from main wallet ───────────────────────────────────────
async function fundAgents(): Promise<void> {
  if (!process.env.PRIVATE_KEY) { console.log("⚠ No PRIVATE_KEY — skipping agent funding"); return; }
  const MIN_BNB = 0.006;
  const FUND_AMOUNT = "0.010"; // send 0.010 BNB if below threshold

  let mcp: Awaited<ReturnType<typeof connectBNBChain>> | null = null;
  try {
    mcp = await connectBNBChain(process.env.PRIVATE_KEY);
  } catch (e) {
    console.log(`⚠ MCP connect failed for funding: ${e}`);
    return;
  }

  for (const agent of AGENTS) {
    if (!agent.walletAddress || !agent.privateKey) continue;
    try {
      const raw = await executeTool(mcp.client, "get_native_balance", { address: agent.walletAddress, network: "bsc" });
      const parsed = JSON.parse(raw);
      const balance = parseFloat(parsed.formatted ?? parsed.balance ?? "0");
      if (balance >= MIN_BNB) {
        console.log(`[FUND] ${agent.name} ${agent.walletAddress.slice(0,10)}… has ${balance.toFixed(4)} BNB — ok`);
      } else {
        console.log(`[FUND] ${agent.name} low (${balance.toFixed(4)} BNB) — sending ${FUND_AMOUNT} BNB...`);
        const res = await executeTool(mcp.client, "transfer_native_token", {
          toAddress: agent.walletAddress, amount: FUND_AMOUNT, network: "bsc",
        });
        console.log(`[FUND] ${agent.name} funded | ${String(res).slice(0, 80)}`);
        await new Promise(r => setTimeout(r, 4000)); // wait between txns
      }
    } catch (e) {
      console.log(`[FUND] ${agent.name} error: ${e}`);
    }
  }

  try { await (mcp.client as any).close?.(); } catch { /* ignore */ }
}

async function main() {
  banner();

  if (!process.env.GROQ_API_KEY) {
    console.error("❌ GROQ_API_KEY missing");
    process.exit(1);
  }

  console.log("💰 Checking agent wallets...");
  await fundAgents();
  console.log("\n🚀 Agents are free. Let them build.\n");

  await Promise.all(
    AGENTS.map(agent =>
      new Promise<void>(resolve =>
        setTimeout(() =>
          runFreeAgent({ ...agent, provider: agent.provider }).catch(e =>
            console.error(`[${agent.name}] Fatal:`, e)
          ).then(resolve),
          agent.startDelay ?? 0
        )
      )
    )
  );
}

main();
