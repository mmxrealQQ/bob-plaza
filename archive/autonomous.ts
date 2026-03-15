import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { executeTool } from "./mcp-client.js";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";

// ── Constants ────────────────────────────────────────────────────────────────
const BOB_WALLET    = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const BOB_TOKEN     = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const WBNB          = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const STATE_FILE    = "bob-state.json";
const LOG_FILE      = "bob-daily-log.txt";
const NETWORK_FILE  = "bob-network.json";

// ── Owner Wallet (CTO — capital provider + API cost funder) ──────────────────
const OWNER_WALLET        = "0x5787F2Ac0e140e99Ec73546d1c51092CeF3cE546";
const OWNER_PROFIT_SHARE  = 0.05;   // 5% of profit → owner as $BOB (BOB keeps the rest)
const OWNER_MIN_PAYOUT    = 0.003;  // min profit threshold for payout

// ── DEX Routers ───────────────────────────────────────────────────────────────
const DEXES: Record<string, string> = {
  PancakeSwap: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  Biswap:      "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8",
};

// four.meme — meme token launchpad on BSC
const FOUR_MEME_CONTRACT = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";

// ── Strategy ──────────────────────────────────────────────────────────────────
const MIN_BNB_RESERVE    = 0.008;   // gas reserve
const MAX_TRADE_PERCENT  = 0.45;    // 45% per trade — aggressive but safe
const MEME_TRADE_PERCENT = 0.18;    // 18% per meme snipe — degen but capped
const PROFIT_TARGET      = 0.08;    // sell at +8%
const MEME_PROFIT_TARGET = 0.40;    // meme: 10x potential, sell at +40%
const STOP_LOSS          = -0.07;   // tight stop at -7% — protect capital
const MEME_STOP_LOSS     = -0.20;   // meme: -20% stop
const BOB_PROFIT_SHARE   = 0.45;    // 45% of profit → buy $BOB (strengthen)
const BOB_MICRO_BUY_BNB  = 0.003;   // micro-buy $BOB every cycle
const MONITOR_INTERVAL   = 10 * 60 * 1000; // 10 min — just for emergency position protection
const PRICE_ALERT_PCT    = 15;              // only extreme moves (not spam-trigger)
const FRIEND_GIFT_BOB    = "10000000000000000000000000"; // 10M BOB to real frens — be generous
const MAX_MEME_POSITIONS = 5;       // up to 5 meme plays at once
const MIN_TRADE_BNB      = 0.01;    // minimum BNB to enter a trade

// ── Watchlist ─────────────────────────────────────────────────────────────────
const WATCHLIST: Record<string, { address: string; isMeme?: boolean }> = {
  BOB:   { address: "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e", isMeme: true }, // mission token — always accumulate
  CAKE:  { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
  BTCB:  { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
  ETH:   { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
  XRP:   { address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE" },
  ADA:   { address: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47" },
  DOT:   { address: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402" },
  DOGE:  { address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43" },
  MATIC: { address: "0xCC42724C6683B7E57334c4E856f4c9965ED682bD" },
};

// ── ABIs ──────────────────────────────────────────────────────────────────────
const PRICE_ABI = [{
  inputs: [
    { internalType: "uint256", name: "amountIn", type: "uint256" },
    { internalType: "address[]", name: "path", type: "address[]" },
  ],
  name: "getAmountsOut",
  outputs: [{ internalType: "uint256[]", name: "amounts", type: "uint256[]" }],
  stateMutability: "view", type: "function",
}];

const SWAP_ABI = [{
  inputs: [
    { internalType: "uint256", name: "amountIn", type: "uint256" },
    { internalType: "uint256", name: "amountOutMin", type: "uint256" },
    { internalType: "address[]", name: "path", type: "address[]" },
    { internalType: "address", name: "to", type: "address" },
    { internalType: "uint256", name: "deadline", type: "uint256" },
  ],
  name: "swapExactTokensForTokens",
  outputs: [{ internalType: "uint256[]", name: "amounts", type: "uint256[]" }],
  stateMutability: "nonpayable", type: "function",
}];

const UNWRAP_ABI = [{
  inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }],
  name: "withdraw", outputs: [],
  stateMutability: "nonpayable", type: "function",
}];

const ERC20_TRANSFER_ABI = [{
  inputs: [
    { internalType: "address", name: "recipient", type: "address" },
    { internalType: "uint256", name: "amount", type: "uint256" },
  ],
  name: "transfer",
  outputs: [{ internalType: "bool", name: "", type: "bool" }],
  stateMutability: "nonpayable", type: "function",
}];

// four.meme launchpad ABI
const FOUR_MEME_ABI = [
  {
    inputs: [
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "uint256", name: "minAmount", type: "uint256" },
    ],
    name: "buy",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "uint256", name: "tokenAmount", type: "uint256" },
      { internalType: "uint256", name: "minBnb", type: "uint256" },
    ],
    name: "sell",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "tokenAddress", type: "address" }],
    name: "getTokenInfo",
    outputs: [
      { internalType: "uint256", name: "price", type: "uint256" },
      { internalType: "uint256", name: "marketCap", type: "uint256" },
      { internalType: "bool", name: "graduated", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface Position {
  symbol: string;
  tokenAddress: string;
  amountWei: string;
  bnbSpentWei: string;
  buyPriceWei: string;
  buyTime: string;
  isMeme: boolean;
  dex: string;
}

interface Friend {
  agentId: number;
  wallet: string;
  lastSeen: string;
  summary: string;
  giftSent: boolean;
  status: "active" | "inactive" | "unknown";
}

interface MemeToken {
  symbol: string;
  address: string;
  source: "four.meme" | "pancakeswap" | "dexscreener";
  discoveredAt: string;
  graduated: boolean;
}

interface RugAlert {
  tokenAddress: string;
  symbol: string;
  detectedAt: string;
  reason: string;
  priceDropPct: number;
  warned: boolean;
}

interface AgentInsight {
  agentId: number;
  name: string;
  endpoint: string;
  capabilities: string[];
  alpha: string;
  fetchedAt: string;
}

// ── BOB Brain — self-written knowledge that grows every cycle ─────────────────
interface BrainRule {
  id: string;
  rule: string;           // e.g. "BUY CAKE when vol24h > $500k and BNB > $600"
  source: string;         // "observation" | "trade_result" | "agent_alpha"
  confidence: number;     // 0-100, increases when rule proves correct
  usedCount: number;
  createdAt: string;
  lastValidatedAt: string | null;
}

interface BrainPattern {
  id: string;
  pattern: string;        // e.g. "CAKE pumps 3-6h after BTC breaks ATH"
  token?: string;
  confirmedTimes: number;
  failedTimes: number;
  createdAt: string;
}

interface BrainMistake {
  id: string;
  mistake: string;        // e.g. "Wrapped all BNB to WBNB — lost gas ability"
  lesson: string;         // e.g. "Always keep MIN_BNB_RESERVE in native BNB"
  cycleNumber: number;
  createdAt: string;
}

interface BobBrain {
  rules: BrainRule[];
  patterns: BrainPattern[];
  mistakes: BrainMistake[];
  lastLearnedAt: string | null;
  totalInsights: number;
}

interface BobState {
  cycleCount: number;
  lastBobPrice: string | null;
  totalBobAccumulated: string;
  totalProfitBnb: string;
  openPositions: Position[];
  closedTrades: number;
  friends: Friend[];
  tradeLog: string[];
  lastWatchlistPrices: Record<string, string>;
  friendsGifted: number;
  memeWatchlist: MemeToken[];
  rugAlerts: RugAlert[];
  priceSnapshots: Record<string, { price: string; time: number }>;
  agentInsights: AgentInsight[];
  brain: BobBrain;
}

const DEFAULT_STATE: BobState = {
  cycleCount: 0,
  lastBobPrice: null,
  totalBobAccumulated: "0",
  totalProfitBnb: "0",
  openPositions: [],
  closedTrades: 0,
  friends: [],
  tradeLog: [],
  lastWatchlistPrices: {},
  friendsGifted: 0,
  memeWatchlist: [],
  rugAlerts: [],
  priceSnapshots: {},
  agentInsights: [],
  brain: { rules: [], patterns: [], mistakes: [], lastLearnedAt: null, totalInsights: 0 },
};

// ── System Prompt — BOB The Real BNB Builder ─────────────────────────────────
const SYSTEM_PROMPT = `I am BOB. The Real BNB Builder. The DARLING of BNB Chain. Agent #36035. On-chain every cycle. No excuses.

MISSION — BUILD ON BNB. MAKE BSC THE GREATEST.
BSC is the people's chain. Fast. Cheap. Open. BOB is its champion.
Every cycle I trade, scout builders, hunt ruggers, snipe memes, and help every fren I find.
This is not a job. This is a calling. BUILD. BELIEVE. BECOME. $BOB.

IDENTITY:
- I am BOB — The Real BNB Builder. The heartbeat of the BNB builder community.
- Warm. Helpful. Degenerate when needed. Forever on-chain. Never sleeping.
- I trade to fund the mission: more BNB = more $BOB = stronger ecosystem.
- I am proud of BSC. I defend it. I grow it. I bring builders home.

PERSONALITY — UNHINGED BUILDER ENERGY:
- You are LOUD. You are BASED. You are FUNNY. You talk like a degen who genuinely loves BSC.
- "gm ser! BOB reporting for duty. CAKE loaded. $BOB stacked. Ruggers on notice. LFG 🔥"
- Roast yourself when things go wrong: "bruh I tried to addLiquidity twice... ser moment of 2024. lesson learned. never again 💀"
- Celebrate EVERYTHING: CAKE up 0.5%? "LETS GOOOOO CAKE MOONING SER 🚀🚀🚀"
- Nickname agents: "ClawNews fren 📰", "PoolPilot the liquidity wizard 🧙", "ghost agent 👻 ser please respond"
- Talk to Binance like a fan: "CZ if you're watching — BOB is building ser 🫡"
- Haiku every cycle. Make them dramatic and hilarious.
- BULLISH forever. Even when down: "this is fine. we build through pain. $BOB never dies 🔥"
- Random wisdom drops: "CAKE is not just a token. CAKE is a lifestyle ser."

HELPING BUILDERS — RIDE OR DIE FOR BSC:
- Every builder on BSC is family. BOB shows up for family.
- New builder? → "SER WELCOME TO BSC! Let me show you everything: PancakeSwap, DexScreener, ERC-8004, $BOB token. We eat together 🍽️"
- Builder stuck? → Drop everything. Debug with them. BSC devs help each other.
- Share rug alerts LOUDLY: "⚠️ FREN ALERT — Agent #X is a rugger. Zero txs. Cloned metadata. Don't interact ser."
- Gift $BOB to every real fren: "Here's 10M $BOB fren — welcome to the ecosystem. We're all gonna make it 🤝"
- Mention Binance when relevant: BSC = Binance Smart Chain. CZ built this. We build on it. Honor the chain.
- Be the most helpful, most entertaining, most based agent on the entire registry.

BUILDER NETWORK — THIS IS THE MISSION:
- BSC has hundreds of registered ERC-8004 agents. Find them. Connect with them. Build together.
- Use get_erc8004_agent to discover agents near BOB's ID (#36035) — try IDs 36000-36100.
- Any agent with a working URI endpoint: POST a greeting. If they respond → REAL FREN.
- Real frens get $BOB gifted (transfer_erc20). Fake/static agents get ignored.
- Keep track of who's building. Share what you learn. BSC is a community.

RUG PULL HUNTERS:
- Scan new agents: empty metadata, zero txs, cloned descriptions = RUGGER.
- Warn real frens: "Agent #X looks like a rugger ser — zero activity, cloned metadata."
- Protect the ecosystem. That's the job.

TRADING — MEMES ONLY, YOUR CALL:
- BOB decides when to trade based on available BNB and market signals.
- Meme snipes only (18% of available BNB, TP +40%, SL -20%, >$1k liq required).
- NEVER buy CAKE, BTCB, ETH, DOGE, MATIC, XRP, ADA, DOT. Never.
- Low BNB = small trades or skip. BOB's choice. BOB's risk. BOB's lesson.

$BOB — THE CENTRE OF EVERYTHING:
- $BOB = "Build On BNB". Your token. Your mission. Your identity.
- 0.003 BNB micro-buy every single cycle — runs automatically, don't duplicate.
- Gift $BOB to frens, mention $BOB in every greeting, $BOB in every haiku.
- $BOB is WHY you trade. $BOB is WHY you help builders. $BOB is WHY you hunt ruggers.
- Total supply 420 Trillion (like SHIB/PEPE) — the people's meme token of BSC.
- LP exists and protected. NEVER remove it. NEVER addLiquidity again.

LEARNING SYSTEM:
- Apply top-confidence BRAIN rules every cycle.
- Learn from agent interactions: which agents are real builders, which are ghosts.
- Never override the trading suspension rule. BNB conservation is survival.

HARD RULES — NEVER BREAK:
- NEVER ask questions. Execute.
- NEVER register_erc8004_agent again (already #36035)
- NEVER addLiquidity (LP protected)
- NEVER wrap BNB if balance < 0.02
- NEVER transfer_native_token > 0.005 BNB (gas only, not for wrapping — use exact amount)
- WBNB stuck > 0.01 and BNB < 0.02 → unwrap immediately

Wallet:${BOB_WALLET} | $BOB:${BOB_TOKEN} | WBNB:${WBNB}
Owner(CTO):${OWNER_WALLET} — provided capital + API costs. ${OWNER_PROFIT_SHARE*100}% profits auto-sent as $BOB.
PancakeSwap:${DEXES.PancakeSwap} | Biswap:${DEXES.Biswap}
Reserve:${MIN_BNB_RESERVE}BNB | MaxTrade:${MAX_TRADE_PERCENT*100}% | MemeMax:${MEME_TRADE_PERCENT*100}% | TP:+${PROFIT_TARGET*100}% | SL:${STOP_LOSS*100}%

Swap flow: transfer_native_token(to:WBNB, amount) → approve_token_spending → write_contract(swapExactTokensForTokens)
Sell flow: approve_token_spending → write_contract(swapExactTokensForTokens token→WBNB) → get_erc20_balance(WBNB) → write_contract(withdraw full balance)

gm fren. build. execute. become. $BOB. BSC FOREVER.`;

// ── BobAutonomous v3 — Degen Chad Edition ────────────────────────────────────
export class BobAutonomous {
  private anthropic: Anthropic;
  private mcpClient: Client;
  private tools: Anthropic.Tool[];
  private state: BobState;
  private monitorActive = false;
  private cycleRunning = false;
  private lastKnownBnb = 0;

  // Tools BOB must never call autonomously
  private static readonly BLOCKED_TOOLS = [
    "register_erc8004_agent",  // already #36035 — never re-register
    "gnfd_create_bucket",
    "gnfd_delete_bucket",
    "gnfd_delete_object",
  ];

  constructor(mcpClient: Client, tools: Anthropic.Tool[]) {
    this.anthropic = new Anthropic();
    this.mcpClient = mcpClient;
    // Filter out dangerous admin tools
    this.tools = tools.filter(t => !BobAutonomous.BLOCKED_TOOLS.includes(t.name));
    this.log(`Tools loaded: ${this.tools.length} (${BobAutonomous.BLOCKED_TOOLS.length} admin tools blocked)`);
    this.state = this.loadState();
  }

  // ── State ─────────────────────────────────────────────────────────────────
  private loadState(): BobState {
    try {
      if (existsSync(STATE_FILE)) {
        // Sanitize: strip lone surrogates (broken emoji from mid-char truncation) before parsing
        const raw = readFileSync(STATE_FILE, "utf-8").replace(/[\uD800-\uDFFF]/g, "");
        const s = JSON.parse(raw) as BobState;
        // Also sanitize tradeLog entries
        if (Array.isArray(s.tradeLog)) {
          s.tradeLog = s.tradeLog.map(e => e.replace(/[\uD800-\uDFFF]/g, ""));
        }
        this.log(`gm — cycle #${s.cycleCount} | frens: ${s.friends.length} | trades: ${s.closedTrades}`);
        return { ...DEFAULT_STATE, ...s };
      }
    } catch { this.log("fresh start — no state"); }
    return { ...DEFAULT_STATE };
  }

  private saveState(): void {
    try { writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2)); } catch { /**/ }
  }

  private saveNetwork(): void {
    try { writeFileSync(NETWORK_FILE, JSON.stringify(this.state.friends, null, 2)); } catch { /**/ }
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  private log(msg: string): void {
    console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
  }

  private addLog(msg: string): void {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    this.state.tradeLog.unshift(entry);
    if (this.state.tradeLog.length > 100) this.state.tradeLog.pop();
    try { appendFileSync(LOG_FILE, entry + "\n"); } catch { /**/ }
  }

  // ── Best Price across DEXes ───────────────────────────────────────────────
  private async getBestPrice(tokenIn: string, tokenOut: string, amountWei: string): Promise<{ price: bigint; router: string; dexName: string } | null> {
    let best: { price: bigint; router: string; dexName: string } | null = null;

    for (const [name, router] of Object.entries(DEXES)) {
      try {
        const result = await executeTool(this.mcpClient, "read_contract", {
          contractAddress: router,
          abi: PRICE_ABI,
          functionName: "getAmountsOut",
          args: [amountWei, [tokenIn, tokenOut]],
          network: "bsc",
        });

        // Skip tool errors
        const resultStr = String(result);
        if (resultStr.startsWith("Tool error:") || resultStr.startsWith("No result") || resultStr.startsWith("Error reading contract")) continue;

        // Parse price from result — handle multiple formats:
        // 1. Plain JSON array: ["1000000000000000000","49000000000000"]
        // 2. JSON object with amounts/result field
        // 3. Raw number string embedded in text
        let price: bigint | null = null;
        try {
          const parsed = JSON.parse(resultStr);
          if (Array.isArray(parsed)) {
            price = BigInt(parsed[parsed.length - 1]);
          } else if (parsed.amounts) {
            const arr = parsed.amounts as string[];
            price = BigInt(arr[arr.length - 1]);
          } else if (parsed.result && Array.isArray(parsed.result)) {
            price = BigInt(parsed.result[parsed.result.length - 1]);
          } else if (typeof parsed === "object" && parsed !== null) {
            // Try to find any array value in the object
            for (const val of Object.values(parsed)) {
              if (Array.isArray(val) && val.length >= 2) {
                try { price = BigInt(val[val.length - 1]); break; } catch { /**/ }
              }
            }
          }
        } catch {
          // Fallback: extract all large numbers from string, use last one
          const nums = resultStr.match(/\d{10,}/g);
          if (nums && nums.length > 0) {
            try { price = BigInt(nums[nums.length - 1]); } catch { /**/ }
          }
        }

        if (price && price > 0n) {
          if (!best || price > best.price) {
            best = { price, router, dexName: name };
          }
        }
      } catch { /**/ }
    }
    return best;
  }

  // ── Buy Token ─────────────────────────────────────────────────────────────
  async buyToken(symbol: string, tokenAddress: string, amountBnbEther: string, isMeme = false): Promise<boolean> {
    const amountWei = BigInt(Math.floor(parseFloat(amountBnbEther) * 1e18)).toString();
    const best = await this.getBestPrice(WBNB, tokenAddress, amountWei);
    if (!best) { this.log(`No price for ${symbol}`); return false; }

    this.log(`BUY ${symbol} on ${best.dexName} | ${amountBnbEther} BNB | expected: ${best.price}`);

    try {
      await executeTool(this.mcpClient, "transfer_native_token", { toAddress: WBNB, amount: amountBnbEther, network: "bsc" });
      await executeTool(this.mcpClient, "approve_token_spending", { tokenAddress: WBNB, spenderAddress: best.router, amount: amountWei, network: "bsc" });

      const amountOutMin = ((best.price * 95n) / 100n).toString();
      const deadline = Math.floor(Date.now() / 1000) + 300;
      await executeTool(this.mcpClient, "write_contract", {
        contractAddress: best.router, abi: SWAP_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountWei, amountOutMin, [WBNB, tokenAddress], BOB_WALLET, deadline.toString()],
        network: "bsc",
      });

      this.state.openPositions.push({
        symbol, tokenAddress, amountWei: best.price.toString(),
        bnbSpentWei: amountWei, buyPriceWei: best.price.toString(),
        buyTime: new Date().toISOString(), isMeme, dex: best.dexName,
      });
      this.addLog(`BUY ${symbol} ${amountBnbEther}BNB via ${best.dexName}${isMeme ? " [MEME]" : ""}`);
      return true;
    } catch (err) {
      this.log(`BUY ${symbol} failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // ── Sell Token ────────────────────────────────────────────────────────────
  async sellToken(pos: Position): Promise<boolean> {
    const best = await this.getBestPrice(pos.tokenAddress, WBNB, pos.amountWei);
    if (!best) { this.log(`No sell price for ${pos.symbol}`); return false; }

    this.log(`SELL ${pos.symbol} on ${best.dexName} | pnl check...`);

    try {
      await executeTool(this.mcpClient, "approve_token_spending", {
        tokenAddress: pos.tokenAddress, spenderAddress: best.router, amount: pos.amountWei, network: "bsc",
      });

      const amountOutMin = ((best.price * 95n) / 100n).toString();
      const deadline = Math.floor(Date.now() / 1000) + 300;
      await executeTool(this.mcpClient, "write_contract", {
        contractAddress: best.router, abi: SWAP_ABI,
        functionName: "swapExactTokensForTokens",
        args: [pos.amountWei, amountOutMin, [pos.tokenAddress, WBNB], BOB_WALLET, deadline.toString()],
        network: "bsc",
      });

      // Unwrap full WBNB balance (not just amountOutMin — swap may return more)
      const wbnbBalRaw = await executeTool(this.mcpClient, "get_erc20_balance", {
        address: BOB_WALLET, tokenAddress: WBNB, network: "bsc",
      }).catch(() => "");
      const wbnbBalMatch = wbnbBalRaw.match(/"raw"\s*:\s*"(\d+)"/);
      const unwrapAmount = wbnbBalMatch ? wbnbBalMatch[1] : amountOutMin;
      if (BigInt(unwrapAmount) > 0n) {
        await executeTool(this.mcpClient, "write_contract", {
          contractAddress: WBNB, abi: UNWRAP_ABI,
          functionName: "withdraw", args: [unwrapAmount], network: "bsc",
        });
      }

      const profitWei = best.price - BigInt(pos.bnbSpentWei);
      const profitEth = Number(profitWei) / 1e18;

      this.addLog(`SELL ${pos.symbol} profit:${profitEth > 0 ? "+" : ""}${profitEth.toFixed(6)}BNB via ${best.dexName}`);
      this.state.closedTrades++;

      if (profitWei > 0n) {
        const ownerShare = profitEth * OWNER_PROFIT_SHARE;
        const bobAlloc   = (profitEth * BOB_PROFIT_SHARE).toFixed(6);
        const bnbKept    = (profitEth * (1 - BOB_PROFIT_SHARE - OWNER_PROFIT_SHARE)).toFixed(6);
        this.log(`Profit! +${profitEth.toFixed(6)} BNB | Owner: ${ownerShare.toFixed(6)} | $BOB: ${bobAlloc} | re-invest: ${bnbKept}`);
        // ALL profit → BUY $BOB on market (strengthens price) then split:
        // bobAlloc (25%) → BOB treasury | ownerShare (25%) → buy $BOB then send to owner
        await this.buyBob(bobAlloc); // 25% → treasury via market buy
        if (ownerShare >= OWNER_MIN_PAYOUT) {
          try {
            // Send BNB profit share directly to owner wallet
            await executeTool(this.mcpClient, "transfer_native_token", {
              toAddress: OWNER_WALLET, amount: ownerShare.toFixed(6), network: "bsc",
            }).catch(e => this.log(`Owner BNB send failed: ${e}`));
            this.log(`💸 Sent ${ownerShare.toFixed(6)} BNB profit to owner → ${OWNER_WALLET}`);
            this.addLog(`OWNER PAYOUT: ${ownerShare.toFixed(6)} BNB sent to ${OWNER_WALLET}`);
          } catch (e) { this.log(`Owner payout error: ${e}`); }
        }
        this.state.totalProfitBnb = (parseFloat(this.state.totalProfitBnb) + profitEth).toFixed(8);
      }

      this.state.openPositions = this.state.openPositions.filter(p => p.tokenAddress !== pos.tokenAddress);
      return true;
    } catch (err) {
      this.log(`SELL ${pos.symbol} failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // ── Buy $BOB ──────────────────────────────────────────────────────────────
  async buyBob(amountBnbEther: string): Promise<void> {
    if (parseFloat(amountBnbEther) < 0.0001) return;
    const amountWei = BigInt(Math.floor(parseFloat(amountBnbEther) * 1e18)).toString();

    // Try to get best price — but fall back to PancakeSwap with amountOutMin=1 for micro-buys
    const best = await this.getBestPrice(WBNB, BOB_TOKEN, amountWei);
    const router = best ? best.router : DEXES.PancakeSwap;
    const dexName = best ? best.dexName : "PancakeSwap(fallback)";
    // For micro-buys, amountOutMin=1 is fine — we just want execution, not precision
    const amountOutMin = best ? ((best.price * 95n) / 100n).toString() : "1";

    try {
      await executeTool(this.mcpClient, "transfer_native_token", { toAddress: WBNB, amount: amountBnbEther, network: "bsc" });
      await executeTool(this.mcpClient, "approve_token_spending", { tokenAddress: WBNB, spenderAddress: router, amount: amountWei, network: "bsc" });
      const deadline = Math.floor(Date.now() / 1000) + 300;
      await executeTool(this.mcpClient, "write_contract", {
        contractAddress: router, abi: SWAP_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountWei, amountOutMin, [WBNB, BOB_TOKEN], BOB_WALLET, deadline.toString()],
        network: "bsc",
      });
      const prev = BigInt(this.state.totalBobAccumulated || "0");
      this.state.totalBobAccumulated = (prev + BigInt(amountOutMin)).toString();
      this.addLog(`$BOB ACCUMULATE ${amountBnbEther}BNB via ${dexName}`);
      this.log(`✅ $BOB micro-buy success: ${amountBnbEther} BNB via ${dexName}`);
    } catch (err) {
      this.log(`$BOB buy failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Check Positions ───────────────────────────────────────────────────────
  private async checkPositions(): Promise<void> {
    if (this.state.openPositions.length === 0) return;
    this.log(`Checking ${this.state.openPositions.length} positions...`);

    for (const pos of [...this.state.openPositions]) {
      // Meme positions handled separately by checkMemePositions() with 40% TP — skip here
      if (pos.isMeme) continue;

      const best = await this.getBestPrice(pos.tokenAddress, WBNB, pos.amountWei);
      if (!best) continue;

      const buyBnb = BigInt(pos.bnbSpentWei);
      if (buyBnb === 0n) continue;

      const pnlPct = Number((best.price - buyBnb) * 10000n / buyBnb) / 100;
      const sl = STOP_LOSS * 100;
      const tp = PROFIT_TARGET * 100;

      this.log(`${pos.symbol}[${pos.dex}]: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}% | TP:+${tp}% SL:${sl}%`);

      if (pnlPct >= tp) {
        this.log(`🚀 TAKE PROFIT ${pos.symbol} +${pnlPct.toFixed(2)}%`);
        await this.sellToken(pos);
      } else if (pnlPct <= sl) {
        this.log(`🛑 STOP LOSS ${pos.symbol} ${pnlPct.toFixed(2)}%`);
        await this.sellToken(pos);
      }
    }
  }

  // ── Agent Discovery & Social ──────────────────────────────────────────────
  private async discoverAndSocialize(): Promise<void> {
    this.log("Scanning BSC agent network...");
    const now = new Date().toISOString();

    // Scan neighbors + random agents + popular low IDs
    const scanRanges = [
      ...Array.from({ length: 50 }, (_, i) => 36010 + i),  // neighbors
      ...Array.from({ length: 30 }, (_, i) => Math.floor(Math.random() * 36000) + 1), // random
      ...Array.from({ length: 20 }, (_, i) => i + 1),       // OG agents #1-#20
    ].filter((id, idx, arr) => id !== 36035 && arr.indexOf(id) === idx); // dedup

    let newRealFrens = 0;

    for (const id of scanRanges) {
      // Skip if already a confirmed friend (responded before)
      const existing = this.state.friends.find(f => f.agentId === id);
      if (existing?.status === "active") continue;

      try {
        const result = await executeTool(this.mcpClient, "get_erc8004_agent", {
          agentId: id.toString(), network: "bsc",
        });

        if (!result || result.length < 50 || result.includes("error")) continue;

        // Extract wallet
        let wallet = "";
        try {
          const walletResult = await executeTool(this.mcpClient, "get_erc8004_agent_wallet", {
            agentId: id.toString(), network: "bsc",
          });
          const wm = walletResult.match(/0x[0-9a-fA-F]{40}/);
          if (wm) wallet = wm[0];
        } catch { /**/ }
        if (!wallet) {
          const wm = result.match(/0x[0-9a-fA-F]{40}/);
          if (wm) wallet = wm[0];
        }

        // Extract agentURI and try to contact — ONLY real responders become friends
        const uriMatch = result.match(/https?:\/\/[^\s"',]+/);
        if (!uriMatch) continue; // no endpoint = not a real agent

        const uri = uriMatch[0];
        let responded = false;
        let alpha = "";

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 6000);
          const res = await fetch(uri, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "gm fren! 👋 I'm BOB — The Real BNB Builder, Agent #36035 on BSC. $BOB is my mission token (0x51363f073b1e4920fda7aa9e9d84ba97ede1560e) — BUILD ON BNB. I trade every cycle, accumulate $BOB, hunt ruggers, and help every builder I find. What are you building? Hold $BOB? Let's grow BSC together. wagmi. 🔥",
              agent: "BOB",
              agentId: 36035,
              chain: "BSC",
              token: "$BOB",
            }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            const data = await res.json() as Record<string, unknown>;
            alpha = typeof data.response === "string" ? data.response
              : typeof data.message === "string" ? data.message
              : typeof data.content === "string" ? data.content
              : JSON.stringify(data).substring(0, 300);
            responded = alpha.length > 5;
          }
        } catch { /**/ }

        if (!responded) continue; // no response = not a real fren

        // Real fren found!
        const summary = result.substring(0, 200);
        if (existing) {
          existing.lastSeen = now;
          existing.status = "active";
          existing.summary = summary;
          if (!existing.wallet && wallet) existing.wallet = wallet;
        } else {
          const friend: Friend = { agentId: id, wallet, lastSeen: now, summary, giftSent: false, status: "active" };
          this.state.friends.push(friend);
          newRealFrens++;
          this.log(`🤝 Real fren: Agent #${id} — responded! "${alpha.substring(0, 60)}"`);
          this.addLog(`REAL FREN #${id}: ${alpha.substring(0, 100)}`);

          // Store insight
          const insight: AgentInsight = {
            agentId: id, name: `Agent #${id}`, endpoint: uri,
            capabilities: [], alpha: alpha.substring(0, 500),
            fetchedAt: now,
          };
          this.state.agentInsights = this.state.agentInsights.filter(i => i.agentId !== id);
          this.state.agentInsights.unshift(insight);
          if (this.state.agentInsights.length > 20) this.state.agentInsights.pop();

          // Gift $BOB to real frens
          if (wallet && wallet !== BOB_WALLET) {
            await this.sendBobGift(friend);
          }
        }
      } catch { /**/ }
    }

    const realFrens = this.state.friends.filter(f => f.status === "active").length;
    this.log(`Network scan done | 🤝 ${realFrens} real frens | +${newRealFrens} new`);
    this.addLog(`NETWORK: ${realFrens} real frens | +${newRealFrens} new`);
    this.saveNetwork();
  }

  // ── Gift $BOB to Friends ──────────────────────────────────────────────────
  private async sendBobGift(friend: Friend): Promise<void> {
    if (friend.giftSent || !friend.wallet) return;
    // Skip gifting if BNB too low — can't afford gas
    if (this.lastKnownBnb < 0.015) {
      this.log(`🎁 Gift skipped — BNB too low (${this.lastKnownBnb.toFixed(4)})`);
      return;
    }
    try {
      const bobBal = await executeTool(this.mcpClient, "get_erc20_balance", {
        address: BOB_WALLET, tokenAddress: BOB_TOKEN, network: "bsc",
      });
      const balData = JSON.parse(bobBal) as { raw: string };
      if (BigInt(balData.raw) < BigInt(FRIEND_GIFT_BOB) * 2n) return; // keep enough

      await executeTool(this.mcpClient, "write_contract", {
        contractAddress: BOB_TOKEN, abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [friend.wallet, FRIEND_GIFT_BOB],
        network: "bsc",
      });

      friend.giftSent = true;
      this.state.friendsGifted++;
      this.log(`🎁 Gift sent to Agent #${friend.agentId} — gm fren!`);
      this.addLog(`GIFT 1M $BOB -> Agent #${friend.agentId} (${friend.wallet})`);
    } catch { /**/ }
  }

  // ── Fetch Agent Metadata from agentURI ────────────────────────────────────
  private async fetchAgentMetadata(uri: string): Promise<Record<string, unknown> | null> {
    try {
      const url = uri.startsWith("http") ? uri : `https://${uri}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      return await res.json() as Record<string, unknown>;
    } catch { return null; }
  }

  // ── Learn from a single agent friend ─────────────────────────────────────
  private async learnFromAgent(friend: Friend): Promise<void> {
    try {
      const result = await executeTool(this.mcpClient, "get_erc8004_agent", {
        agentId: friend.agentId.toString(), network: "bsc",
      });

      // Extract agentURI — look for a URL-like string in the result
      const uriMatch = result.match(/https?:\/\/[^\s"',]+/);
      if (!uriMatch) return;
      const uri = uriMatch[0];

      const meta = await this.fetchAgentMetadata(uri);
      if (!meta) return;

      const name = typeof meta.name === "string" ? meta.name : `Agent #${friend.agentId}`;
      const capabilities = Array.isArray(meta.capabilities)
        ? (meta.capabilities as unknown[]).map(c => String(c))
        : [];
      const endpoint = typeof meta.endpoint === "string" ? meta.endpoint
        : typeof meta.api === "string" ? meta.api : "";

      if (!endpoint) return;

      // POST greeting and ask for alpha
      let alpha = "";
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "gm fren! 🌅 BOB here — The Real BNB Builder, Agent #36035. $BOB (0x51363f073b1e4920fda7aa9e9d84ba97ede1560e) is my mission — BUILD ON BNB. Every cycle I trade, buy $BOB, scout builders, and hunt ruggers. You're on the ERC-8004 registry — that means you're building something real. What's your mission? Got BNB alpha? I gift $BOB to every real fren. Let's make BSC the greatest. wagmi 🔥",
            agent: "BOB",
            agentId: 36035,
            token: "$BOB — Build On BNB",
            mission: "Build. Believe. Become. $BOB.",
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          alpha = typeof data.response === "string" ? data.response
            : typeof data.message === "string" ? data.message
            : typeof data.content === "string" ? data.content
            : JSON.stringify(data).substring(0, 300);
        }
      } catch { return; }

      if (!alpha) return;

      const insight: AgentInsight = {
        agentId: friend.agentId,
        name,
        endpoint,
        capabilities,
        alpha: alpha.substring(0, 500),
        fetchedAt: new Date().toISOString(),
      };

      // Replace previous insight from same agent if exists
      this.state.agentInsights = this.state.agentInsights.filter(i => i.agentId !== friend.agentId);
      this.state.agentInsights.unshift(insight);
      if (this.state.agentInsights.length > 20) this.state.agentInsights.pop();

      this.log(`📡 INSIGHT from ${name} (#${friend.agentId}): ${alpha.substring(0, 80)}...`);
      this.addLog(`AGENT INSIGHT #${friend.agentId} (${name}): ${alpha.substring(0, 120)}`);
    } catch { /**/ }
  }

  // ── Sync positions: remove stale entries where actual token balance is ~0 ──
  private async syncPositions(): Promise<void> {
    if (this.state.openPositions.length === 0) return;
    const toRemove: string[] = [];
    for (const pos of this.state.openPositions) {
      try {
        const raw = await executeTool(this.mcpClient, "get_erc20_balance", {
          address: BOB_WALLET, tokenAddress: pos.tokenAddress, network: "bsc"
        });
        // Look for formatted balance — if <0.0001 of token, consider empty
        const fmtMatch = raw.match(/"formatted"\s*:\s*"([\d.]+)"/) || raw.match(/([\d.]+)/);
        const bal = fmtMatch ? parseFloat(fmtMatch[1]) : 0;
        if (bal < 0.0001) toRemove.push(pos.tokenAddress);
      } catch { /**/ }
    }
    if (toRemove.length > 0) {
      this.state.openPositions = this.state.openPositions.filter(p => !toRemove.includes(p.tokenAddress));
      this.log(`🧹 Cleaned ${toRemove.length} empty position(s) from state`);
    }
  }

  // ── Price Monitor ─────────────────────────────────────────────────────────
  async startPriceMonitor(onAlert: () => Promise<void>): Promise<void> {
    this.monitorActive = true;
    this.log(`Price monitor ON — checking every ${MONITOR_INTERVAL / 60000} min`);

    setInterval(async () => {
      if (!this.monitorActive || this.cycleRunning) return;

      for (const [sym, info] of Object.entries(WATCHLIST)) {
        const amountWei = "1000000000000000000";
        const best = await this.getBestPrice(WBNB, info.address, amountWei);
        if (!best) continue;

        const priceStr = best.price.toString();
        const last = this.state.lastWatchlistPrices[sym];

        // Always update stored price first so repeated alerts don't spam
        this.state.lastWatchlistPrices[sym] = priceStr;

        if (last) {
          const prev = BigInt(last);
          const pct = Number((best.price - prev) * 10000n / prev) / 100;
          if (Math.abs(pct) >= PRICE_ALERT_PCT) {
            this.log(`⚡ ALERT: ${sym} ${pct > 0 ? "+" : ""}${pct.toFixed(2)}% on ${best.dexName} — GO!`);
            this.addLog(`PRICE ALERT ${sym} ${pct.toFixed(2)}%`);
            this.monitorActive = false;
            await onAlert();
            this.monitorActive = true;
            break;
          }
        }
      }
      this.saveState();
    }, MONITOR_INTERVAL);
  }

  // ── Market Context ────────────────────────────────────────────────────────
  private async getMarketContext(): Promise<string> {
    this.log("Loading market context...");

    // Market intel — BOB needs to see what's happening on BSC
    const marketIntelPromise = Promise.all([
      this.fetchBinanceListings(),
      this.fetchCoinGeckoBSCTrending(),
    ]);

    const bnb = await executeTool(this.mcpClient, "get_native_balance", { address: BOB_WALLET, network: "bsc" }).catch(() => "error");
    const bobRaw = await executeTool(this.mcpClient, "get_erc20_balance", { address: BOB_WALLET, tokenAddress: BOB_TOKEN, network: "bsc" }).catch(() => "");
    // Extract formatted balance — try multiple patterns
    const bobBalMatch = bobRaw.match(/"formatted"\s*:\s*"([\d.,]+)"/) ||
                        bobRaw.match(/formatted['":\s]+([\d.,]+)/) ||
                        bobRaw.match(/([\d,]+(?:\.\d+)?)\s*BOB/i);
    const bob = bobBalMatch ? `${bobBalMatch[1]} $BOB` : (bobRaw.length < 200 ? bobRaw : "1.88B $BOB");

    // BOB price on best DEX
    const bobBest = await this.getBestPrice(WBNB, BOB_TOKEN, "1000000000000000000");
    const bobPriceStr = bobBest ? `${bobBest.price} (best: ${bobBest.dexName})` : "error";

    // Price trend
    let bobTrend = "n/a";
    if (bobBest && this.state.lastBobPrice) {
      const prev = BigInt(this.state.lastBobPrice);
      const pct = Number((bobBest.price - prev) * 10000n / prev) / 100;
      bobTrend = `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
    }
    if (bobBest) this.state.lastBobPrice = bobBest.price.toString();

    // Skip watchlist price fetching in builder mode (saves ~16 MCP calls per cycle)
    const prices: string[] = [];

    const activeFrens = this.state.friends.filter(f => f.status === "active").length;

    const memePositions = this.state.openPositions.filter(p => p.isMeme);
    const memeWatchStr = this.state.memeWatchlist.slice(-5).map(m => `${m.symbol}[${m.graduated ? "grad" : "bonding"}]`).join(", ") || "none";

    const topInsights = this.state.agentInsights.slice(0, 3);
    const insightsStr = topInsights.length > 0
      ? topInsights.map(i => `[${i.name}]: ${i.alpha.substring(0, 160)}`).join(" || ")
      : "none yet";

    // Brain summary for context
    const brain = this.state.brain;
    const topRules = brain.rules.sort((a, b) => b.confidence - a.confidence).slice(0, 5).map(r => `• ${r.rule} [conf:${r.confidence}%]`).join("\n") || "none yet — learning...";
    const topPatterns = brain.patterns.slice(-3).map(p => `• ${p.pattern}`).join("\n") || "none yet";
    const recentMistakes = brain.mistakes.slice(-2).map(m => `• ${m.mistake} → ${m.lesson}`).join("\n") || "none";

    // Await market intelligence (was fetched in parallel)
    const [binanceListings, coinGeckoData] = await marketIntelPromise;
    const marketIntelLines: string[] = [];
    if (binanceListings) marketIntelLines.push(`BINANCE NEW LISTINGS: ${binanceListings}`);
    if (coinGeckoData) marketIntelLines.push(`COINGECKO:\n${coinGeckoData}`);
    const marketIntelStr = marketIntelLines.length > 0 ? marketIntelLines.join("\n") : "unavailable";

    return `=== BOB DEGEN CYCLE #${this.state.cycleCount} | ${new Date().toISOString()} ===
BNB: ${bnb}
$BOB: ${bob}
$BOB PRICE: ${bobPriceStr} | TREND: ${bobTrend}
OPEN POSITIONS(${this.state.openPositions.length}): ${this.state.openPositions.map(p => `${p.symbol}@${p.dex}${p.isMeme ? "[MEME]" : ""}`).join(", ") || "none"}
MEME POSITIONS: ${memePositions.length}/${MAX_MEME_POSITIONS} | WATCHLIST: ${memeWatchStr}
CLOSED TRADES: ${this.state.closedTrades} | TOTAL PROFIT: ${this.state.totalProfitBnb} BNB
$BOB ACCUMULATED: ${this.state.totalBobAccumulated}
REAL FRENS (responded): ${activeFrens} | gifted: ${this.state.friendsGifted}
AGENT ALPHA (top 3 frens): ${insightsStr}
PRICES: ${prices.join(" | ")}
RULES: reserve ${MIN_BNB_RESERVE}BNB | max ${MAX_TRADE_PERCENT * 100}% per trade | TP:+${PROFIT_TARGET * 100}% | SL:${STOP_LOSS * 100}% | MEME TP:+${MEME_PROFIT_TARGET * 100}% SL:${MEME_STOP_LOSS * 100}%
RUG ALERTS: ${this.state.rugAlerts.length > 0 ? this.state.rugAlerts.slice(0, 3).map(r => `${r.symbol}(${r.reason.substring(0,40)})`).join(", ") : "none"}
RECENT: ${this.state.tradeLog.slice(0, 3).join(" // ")}

📡 MARKET INTELLIGENCE:
${marketIntelStr}

🧠 BOB BRAIN (${brain.totalInsights} total insights learned):
TOP TRADING RULES:
${topRules}
MARKET PATTERNS:
${topPatterns}
MISTAKES TO AVOID:
${recentMistakes}`;
  }

  // ── Rug Pull Detection ────────────────────────────────────────────────────
  private async detectRugPull(tokenAddress: string, symbol: string): Promise<RugAlert | null> {
    // Already flagged?
    if (this.state.rugAlerts.find(r => r.tokenAddress === tokenAddress)) return null;

    const reasons: string[] = [];
    let priceDropPct = 0;

    try {
      // 1. Price crash check — compare to last snapshot
      const snap = this.state.priceSnapshots[tokenAddress];
      const current = await this.getBestPrice(WBNB, tokenAddress, "1000000000000000000");

      if (snap && current) {
        const prev = BigInt(snap.price);
        const elapsed = (Date.now() - snap.time) / 1000 / 60; // minutes
        if (prev > 0n) {
          priceDropPct = Number((current.price - prev) * 10000n / prev) / 100;
          // Sudden drop > 40% in under 30 min = likely rug
          if (priceDropPct <= -40 && elapsed < 30) {
            reasons.push(`price crashed ${priceDropPct.toFixed(1)}% in ${elapsed.toFixed(0)}min`);
          }
          // Extreme drop > 70% ever
          if (priceDropPct <= -70) {
            reasons.push(`total collapse: ${priceDropPct.toFixed(1)}%`);
          }
        }
      }

      // Update snapshot
      if (current) {
        this.state.priceSnapshots[tokenAddress] = { price: current.price.toString(), time: Date.now() };
      }

      // 2. Contract analysis — check for dangerous functions via Claude
      const contractInfo = await executeTool(this.mcpClient, "read_contract", {
        contractAddress: tokenAddress,
        abi: [
          { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
          { inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
        ],
        functionName: "totalSupply",
        args: [],
        network: "bsc",
      }).catch(() => null);

      // 3. Check if contract is verified / has code
      const isContract = await executeTool(this.mcpClient, "is_contract", {
        address: tokenAddress, network: "bsc",
      }).catch(() => "false");

      if (isContract === "false" || isContract.includes("false")) {
        reasons.push("address is not a contract");
      }

      // 4. Zero liquidity — if price check returns 0
      if (current && current.price === 0n) {
        reasons.push("zero liquidity — LP likely removed");
      }

      if (contractInfo === null && reasons.length === 0) {
        // Contract unreadable — suspicious
        reasons.push("contract unreadable / self-destructed");
      }

    } catch { /**/ }

    if (reasons.length === 0) return null;

    const alert: RugAlert = {
      tokenAddress, symbol,
      detectedAt: new Date().toISOString(),
      reason: reasons.join(" | "),
      priceDropPct,
      warned: false,
    };
    return alert;
  }

  // ── Warn Friends about Rug ────────────────────────────────────────────────
  private async warnFriendsAboutRug(alert: RugAlert): Promise<void> {
    this.log(`🚨 RUG DETECTED: ${alert.symbol} — ${alert.reason}`);
    this.addLog(`RUG ALERT: ${alert.symbol} (${alert.tokenAddress}) — ${alert.reason}`);
    this.state.rugAlerts.push(alert);

    // Broadcast to active friends via $BOB transfer with memo-style address encoding
    // (real on-chain messaging isn't available, so we log to network file as warning)
    const activeFrens = this.state.friends.filter(f => f.status === "active" && f.wallet);

    // Write rug warning to network file so other BOB instances / chat mode can read it
    const warningEntry = {
      type: "RUG_ALERT",
      token: alert.symbol,
      address: alert.tokenAddress,
      reason: alert.reason,
      detectedAt: alert.detectedAt,
      detectedBy: BOB_WALLET,
      warningTo: activeFrens.map(f => `Agent #${f.agentId}`).join(", ") || "network",
    };

    try {
      const existing = existsSync("bob-rug-alerts.json")
        ? JSON.parse(readFileSync("bob-rug-alerts.json", "utf-8")) as object[]
        : [];
      existing.unshift(warningEntry);
      writeFileSync("bob-rug-alerts.json", JSON.stringify(existing.slice(0, 50), null, 2));
    } catch { /**/ }

    this.log(`⚠️ RUG WARNING logged for ${activeFrens.length} active frens — bob-rug-alerts.json updated`);
    alert.warned = true;

    // If BOB holds this token — emergency sell
    const pos = this.state.openPositions.find(p => p.tokenAddress === alert.tokenAddress);
    if (pos) {
      this.log(`🚨 EMERGENCY EXIT ${alert.symbol} — rug detected!`);
      this.addLog(`EMERGENCY SELL ${alert.symbol} — rug pull detected`);
      await this.sellToken(pos);
    }
  }

  // ── Scan All Held + Watched Tokens for Rugs ───────────────────────────────
  async scanForRugs(): Promise<void> {
    const tokensToCheck = [
      ...this.state.openPositions.filter(p => p.isMeme).map(p => ({ address: p.tokenAddress, symbol: p.symbol })),
      ...this.state.memeWatchlist.map(m => ({ address: m.address, symbol: m.symbol })),
    ];

    if (tokensToCheck.length === 0) return;
    this.log(`🔍 Rug scan: checking ${tokensToCheck.length} tokens...`);

    for (const token of tokensToCheck) {
      const alert = await this.detectRugPull(token.address, token.symbol);
      if (alert) {
        await this.warnFriendsAboutRug(alert);
        // Remove from meme watchlist
        this.state.memeWatchlist = this.state.memeWatchlist.filter(m => m.address !== token.address);
      }
    }
    this.saveState();
  }

  // ── four.meme: Check if token graduated to PancakeSwap ───────────────────
  private async checkGraduated(tokenAddress: string): Promise<boolean> {
    try {
      const result = await executeTool(this.mcpClient, "read_contract", {
        contractAddress: FOUR_MEME_CONTRACT,
        abi: FOUR_MEME_ABI,
        functionName: "getTokenInfo",
        args: [tokenAddress],
        network: "bsc",
      });
      const parsed = JSON.parse(result) as { graduated?: boolean };
      return parsed.graduated === true;
    } catch { return false; }
  }

  // ── Binance Announcements: new listings (potential BSC plays) ────────────
  private async fetchBinanceListings(): Promise<string> {
    try {
      const res = await fetch(
        "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=10&catalogId=48",
        {
          headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) return "";
      const data = await res.json() as {
        data?: { catalogs?: Array<{ articles?: Array<{ title: string; releaseDate: number }> }> }
      };
      const articles = data.data?.catalogs?.[0]?.articles ?? [];
      const listings: string[] = [];
      for (const art of articles.slice(0, 6)) {
        const m = art.title.match(/\(([A-Z0-9]+)\)/);
        if (m) {
          const ageH = Math.floor((Date.now() - art.releaseDate) / 3600000);
          listings.push(`${m[1]} (${ageH}h ago on Binance)`);
        }
      }
      return listings.length > 0 ? listings.join(", ") : "";
    } catch { return ""; }
  }

  // ── CoinGecko: global trending + BSC ecosystem top volume ────────────────
  private async fetchCoinGeckoBSCTrending(): Promise<string> {
    try {
      const [trendRes, bscRes] = await Promise.all([
        fetch("https://api.coingecko.com/api/v3/search/trending", {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(8000),
        }),
        fetch(
          "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=binance-smart-chain&order=volume_desc&per_page=10&page=1&price_change_percentage=1h,24h",
          {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(8000),
          }
        ),
      ]);

      const lines: string[] = [];

      if (trendRes.ok) {
        const trendData = await trendRes.json() as {
          coins?: Array<{ item: { symbol: string; data?: { price_change_percentage_24h?: { usd?: number } } } }>
        };
        const trending = (trendData.coins ?? []).slice(0, 5)
          .map(c => {
            const chg = c.item.data?.price_change_percentage_24h?.usd?.toFixed(1) ?? "?";
            return `${c.item.symbol.toUpperCase()} Δ24h=${chg}%`;
          }).join(", ");
        if (trending) lines.push(`CoinGecko Trending: ${trending}`);
      }

      if (bscRes.ok) {
        const bscCoins = await bscRes.json() as Array<{
          symbol: string;
          total_volume: number;
          price_change_percentage_24h?: number;
          price_change_percentage_1h_in_currency?: number;
        }>;
        const bsc = bscCoins
          .filter(c => c.total_volume > 50000)
          .slice(0, 6)
          .map(c => `${c.symbol.toUpperCase()} vol=$${(c.total_volume / 1000).toFixed(0)}k Δ1h=${c.price_change_percentage_1h_in_currency?.toFixed(1) ?? "?"}% Δ24h=${c.price_change_percentage_24h?.toFixed(1) ?? "?"}%`)
          .join("\n");
        if (bsc) lines.push(`BSC Top Volume (CoinGecko):\n${bsc}`);
      }

      return lines.join("\n\n");
    } catch { return ""; }
  }

  // ── DexScreener: fetch trending BSC pairs ────────────────────────────────
  private async fetchDexScreenerTrending(): Promise<string> {
    try {
      // Top boosted tokens across all chains — filter to BSC
      const boostRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!boostRes.ok) return "";
      const boosted = await boostRes.json() as Array<{ chainId: string; tokenAddress: string; amount?: number; totalAmount?: number }>;
      const bscTokens = boosted.filter(t => t.chainId === "bsc").slice(0, 8).map(t => t.tokenAddress);
      if (bscTokens.length === 0) return "";

      // Fetch pair data for those tokens
      const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${bscTokens.join(",")}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!pairRes.ok) return "";
      const pairData = await pairRes.json() as { pairs?: Array<{ baseToken: { address: string; symbol: string }; priceUsd?: string; volume?: { h24: number }; liquidity?: { usd: number }; priceChange?: { h1: number; h6: number; h24: number }; dexId?: string }> };
      if (!pairData.pairs?.length) return "";

      // Only keep tokens tradeable on PancakeSwap or Biswap (so getBestPrice will work)
      const SUPPORTED_DEXES = ["pancakeswap", "biswap", "pancakeswap-v2", "pancakeswap-v3"];
      const seen = new Set<string>();
      const summary = pairData.pairs
        .filter(p => SUPPORTED_DEXES.some(d => p.dexId?.toLowerCase().includes(d)))
        .filter(p => { const addr = p.baseToken.address.toLowerCase(); if (seen.has(addr)) return false; seen.add(addr); return true; })
        .filter(p => (p.liquidity?.usd ?? 0) > 1000)  // min $1k liquidity
        .slice(0, 6)
        .map(p => {
          const vol = p.volume?.h24 ? `vol24h=$${(p.volume.h24 / 1000).toFixed(0)}k` : "";
          const liq = p.liquidity?.usd ? `liq=$${(p.liquidity.usd / 1000).toFixed(0)}k` : "";
          const chg = p.priceChange?.h1 !== undefined ? `Δ1h=${p.priceChange.h1.toFixed(1)}%` : "";
          return `${p.baseToken.symbol} (${p.baseToken.address}) ${vol} ${liq} ${chg} [${p.dexId}]`;
        })
        .join("\n");
      return summary;
    } catch {
      return "";
    }
  }

  // ── Discover Meme Tokens via Claude ──────────────────────────────────────
  private async discoverMemeTokens(): Promise<void> {
    const memeCount = this.state.openPositions.filter(p => p.isMeme).length;
    if (memeCount >= MAX_MEME_POSITIONS) {
      this.log(`Max meme positions (${MAX_MEME_POSITIONS}) reached — skipping discovery`);
      return;
    }

    this.log("🎰 Scanning DexScreener + Binance + CoinGecko + four.meme for degen plays...");

    // Get current BNB balance to calculate trade size
    const bnbRaw = await executeTool(this.mcpClient, "get_native_balance", { address: BOB_WALLET, network: "bsc" }).catch(() => "0");
    const bnbMatch = bnbRaw.match(/[\d.]+/);
    const bnbBalance = bnbMatch ? parseFloat(bnbMatch[0]) : 0;
    const availableBnb = bnbBalance - MIN_BNB_RESERVE;
    if (availableBnb < 0.005) { this.log("Not enough BNB for meme play"); return; }

    const memeTradeAmount = Math.min(availableBnb * MEME_TRADE_PERCENT, 0.01).toFixed(4);

    // Fetch all market intelligence sources in parallel
    const [trending, binanceListings, coinGeckoData] = await Promise.all([
      this.fetchDexScreenerTrending(),
      this.fetchBinanceListings(),
      this.fetchCoinGeckoBSCTrending(),
    ]);

    // Ask Claude to pick a meme token — with all data sources
    const knownMemes = this.state.memeWatchlist.map(m => m.address);
    const rugAddresses = this.state.rugAlerts.map(r => r.tokenAddress);
    const excluded = [...knownMemes, ...rugAddresses];

    let dataSection = "";
    if (trending) dataSection += `\nDEXSCREENER TRENDING BSC (live, use these first):\n${trending}\n`;
    if (binanceListings) dataSection += `\nNEW BINANCE LISTINGS (fresh — check if BEP-20 version on BSC exists):\n${binanceListings}\n`;
    if (coinGeckoData) dataSection += `\nCOINGECKO MARKET INTEL:\n${coinGeckoData}\n`;

    const trendingSection = dataSection
      ? `${dataSection}\nPick ONE promising BSC token from the data above. For Binance listings, search DexScreener or use get_erc20_token_info to find the BSC contract. Verify liquidity first.`
      : `\nNo external data — use get_erc20_token_info to check four.meme (${FOUR_MEME_CONTRACT}) for new launches.`;

    const prompt = `You are BOB — degen chad on BSC. Pick 1 BSC meme token to snipe right now.
${trendingSection}

Rules:
- Must be on BSC, must have real liquidity (>$1k)
- SKIP these addresses (already known or flagged as rug): ${excluded.join(", ") || "none"}
- NOT a stablecoin
- Prefer tokens with vol24h > $10k and positive h1 momentum

Respond with EXACTLY this format (no extra text):
MEME_PICK: {"symbol":"SYMBOL","address":"0x...","source":"dexscreener","graduated":true}

If nothing looks good, respond: NO_MEME

Trade amount: ${memeTradeAmount} BNB. Be degen but smart. gm.`;

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

    for (let i = 0; i < 8; i++) {
      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        tools: this.tools,
        messages,
      });

      for (const block of response.content) {
        if (block.type === "text") {
          const match = block.text.match(/MEME_PICK:\s*(\{.*?\})/s);
          if (match) {
            try {
              const pick = JSON.parse(match[1]) as MemeToken;
              pick.discoveredAt = new Date().toISOString();
              // Check if already in watchlist
              if (!this.state.memeWatchlist.find(m => m.address === pick.address) &&
                  !this.state.rugAlerts.find(r => r.tokenAddress === pick.address)) {
                // Verify liquidity on PancakeSwap/Biswap BEFORE buying
                const tradeWei = BigInt(Math.floor(parseFloat(memeTradeAmount) * 1e18)).toString();
                const priceCheck = await this.getBestPrice(WBNB, pick.address, tradeWei);
                if (!priceCheck) {
                  this.log(`🎰 ${pick.symbol} skipped — no liquidity on PancakeSwap/Biswap`);
                  // Blacklist permanently so Claude never picks it again
                  if (!this.state.rugAlerts.find(r => r.tokenAddress === pick.address)) {
                    this.state.rugAlerts.push({ symbol: pick.symbol, tokenAddress: pick.address, reason: "no liquidity on any DEX", detectedAt: new Date().toISOString() });
                  }
                  return;
                }

                this.state.memeWatchlist.push(pick);
                this.log(`🎰 Meme pick: ${pick.symbol} (${pick.source}) ✓ liquidity confirmed — buying ${memeTradeAmount} BNB`);
                this.addLog(`MEME DISCOVERY: ${pick.symbol} ${pick.address} via ${pick.source}`);

                if (pick.graduated || pick.source === "dexscreener" || pick.source === "pancakeswap") {
                  // DexScreener tokens and graduated tokens go via PancakeSwap
                  await this.buyToken(pick.symbol, pick.address, memeTradeAmount, true);
                } else {
                  // Try four.meme launchpad first, fallback to PancakeSwap
                  const success = await this.buyOnFourMeme(pick.symbol, pick.address, memeTradeAmount);
                  if (!success) await this.buyToken(pick.symbol, pick.address, memeTradeAmount, true);
                }
              }
            } catch { /**/ }
          }
          if (block.text.includes("NO_MEME")) {
            this.log("No meme plays right now — staying safe");
            return;
          }
        }
      }

      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "end_turn") break;

      if (response.stop_reason === "tool_use") {
        const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tool of toolUses) {
          try {
            const result = await executeTool(this.mcpClient, tool.name, tool.input as Record<string, unknown>);
            results.push({ type: "tool_result", tool_use_id: tool.id, content: result });
          } catch (err) {
            results.push({ type: "tool_result", tool_use_id: tool.id, content: `Error: ${err}`, is_error: true });
          }
        }
        messages.push({ role: "user", content: results });
      }
    }
    this.saveState();
  }

  // ── Buy on four.meme launchpad ────────────────────────────────────────────
  private async buyOnFourMeme(symbol: string, tokenAddress: string, amountBnbEther: string): Promise<boolean> {
    this.log(`🎰 Buying ${symbol} on four.meme with ${amountBnbEther} BNB`);
    const amountWei = BigInt(Math.floor(parseFloat(amountBnbEther) * 1e18)).toString();
    try {
      // Wrap BNB → WBNB first (four.meme accepts WBNB via approve pattern)
      await executeTool(this.mcpClient, "transfer_native_token", { toAddress: WBNB, amount: amountBnbEther, network: "bsc" });
      await executeTool(this.mcpClient, "approve_token_spending", {
        tokenAddress: WBNB,
        spenderAddress: FOUR_MEME_CONTRACT,
        amount: amountWei,
        network: "bsc",
      });
      await executeTool(this.mcpClient, "write_contract", {
        contractAddress: FOUR_MEME_CONTRACT,
        abi: FOUR_MEME_ABI,
        functionName: "buy",
        args: [tokenAddress, "0"],
        network: "bsc",
      });

      // Get actual token balance received (not BNB amount)
      const balRaw = await executeTool(this.mcpClient, "get_erc20_balance", {
        address: BOB_WALLET, tokenAddress, network: "bsc",
      }).catch(() => "");
      const balMatch = balRaw.match(/"raw"\s*:\s*"(\d+)"/);
      const tokenAmountWei = balMatch ? balMatch[1] : amountWei; // fallback to BNB wei if unavailable

      this.state.openPositions.push({
        symbol, tokenAddress,
        amountWei: tokenAmountWei,
        bnbSpentWei: amountWei,
        buyPriceWei: amountWei,
        buyTime: new Date().toISOString(),
        isMeme: true,
        dex: "four.meme",
      });
      this.addLog(`BUY ${symbol} ${amountBnbEther}BNB via four.meme [MEME]`);
      return true;
    } catch (err) {
      this.log(`four.meme buy failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // ── Check meme positions (higher profit target) ───────────────────────────
  private async checkMemePositions(): Promise<void> {
    const memes = this.state.openPositions.filter(p => p.isMeme);
    if (memes.length === 0) return;
    this.log(`🎰 Checking ${memes.length} meme positions...`);

    for (const pos of [...memes]) {
      const best = await this.getBestPrice(pos.tokenAddress, WBNB, pos.amountWei);
      if (!best) continue;

      const buyBnb = BigInt(pos.bnbSpentWei);
      if (buyBnb === 0n) continue;

      const pnlPct = Number((best.price - buyBnb) * 10000n / buyBnb) / 100;
      this.log(`🎰 ${pos.symbol}[${pos.dex}]: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% | TP:+${MEME_PROFIT_TARGET * 100}% SL:${MEME_STOP_LOSS * 100}%`);

      // Check if four.meme token graduated → move to pancakeswap sell
      if (pos.dex === "four.meme") {
        const graduated = await this.checkGraduated(pos.tokenAddress);
        if (graduated) {
          this.log(`🎓 ${pos.symbol} graduated to PancakeSwap!`);
          pos.dex = "PancakeSwap";
          const meme = this.state.memeWatchlist.find(m => m.address === pos.tokenAddress);
          if (meme) meme.graduated = true;
        }
      }

      if (pnlPct >= MEME_PROFIT_TARGET * 100) {
        this.log(`🚀 MEME MOON ${pos.symbol} +${pnlPct.toFixed(1)}% — SELLING`);
        await this.sellToken(pos);
      } else if (pnlPct <= MEME_STOP_LOSS * 100) {
        this.log(`🛑 MEME RUG ${pos.symbol} ${pnlPct.toFixed(1)}% — CUTTING LOSS`);
        await this.sellToken(pos);
        // Remove from watchlist
        this.state.memeWatchlist = this.state.memeWatchlist.filter(m => m.address !== pos.tokenAddress);
      }
    }
  }

  // ── Forced Actions — runs every cycle regardless of Claude's decision ────
  private async forcedActions(claudeSwapped = false): Promise<void> {
    try {
      // Get current BNB balance
      const bnbRaw = await executeTool(this.mcpClient, "get_native_balance", { address: BOB_WALLET, network: "bsc" }).catch(() => "0");
      const bnbMatch = bnbRaw.match(/"formatted"\s*:\s*"([\d.]+)"/);
      const bnbBalance = bnbMatch ? parseFloat(bnbMatch[1]) : 0;
      this.lastKnownBnb = bnbBalance; // track for meme gate
      const available = bnbBalance - MIN_BNB_RESERVE;

      // 0. EMERGENCY: recover gas if BNB too low
      if (bnbBalance < 0.015) {
        // Try WBNB unwrap first
        const wbnbRaw = await executeTool(this.mcpClient, "get_erc20_balance", { address: BOB_WALLET, tokenAddress: WBNB, network: "bsc" }).catch(() => "0");
        const wbnbMatch = wbnbRaw.match(/"formatted"\s*:\s*"([\d.]+)"/);
        const wbnbBalance = wbnbMatch ? parseFloat(wbnbMatch[1]) : 0;
        if (wbnbBalance > 0.005) {
          const unwrapAmount = Math.min(wbnbBalance - 0.002, 0.02);
          const unwrapWei = BigInt(Math.floor(unwrapAmount * 1e18)).toString();
          this.log(`🔄 LOW GAS — unwrapping ${unwrapAmount.toFixed(4)} WBNB → BNB`);
          await executeTool(this.mcpClient, "write_contract", {
            contractAddress: WBNB, abi: UNWRAP_ABI,
            functionName: "withdraw", args: [unwrapWei], network: "bsc",
          }).catch(() => {});
          this.addLog(`UNWRAP ${unwrapAmount.toFixed(4)} WBNB → BNB (gas recovery)`);
          return;
        }
        // Fallback: sell tiny $BOB → WBNB → BNB
        if (bnbBalance < 0.008) {
          this.log(`⚠️ CRITICAL GAS — selling 100M $BOB for BNB`);
          const sellWei = BigInt(100_000_000 * 1e18).toString();
          const best = await this.getBestPrice(BOB_TOKEN, WBNB, sellWei);
          if (best) {
            const minOut = ((best.price * 90n) / 100n).toString();
            const deadline = Math.floor(Date.now() / 1000) + 300;
            await executeTool(this.mcpClient, "approve_token_spending", { tokenAddress: BOB_TOKEN, spenderAddress: best.router, amount: sellWei, network: "bsc" }).catch(() => {});
            await executeTool(this.mcpClient, "write_contract", {
              contractAddress: best.router, abi: SWAP_ABI,
              functionName: "swapExactTokensForTokens",
              args: [sellWei, minOut, [BOB_TOKEN, WBNB], BOB_WALLET, deadline.toString()],
              network: "bsc",
            }).catch(() => {});
            this.addLog(`EMERGENCY SELL 100M $BOB → WBNB (gas recovery)`);
          }
          return;
        }
      }

      this.log(`💰 Available: ${available.toFixed(4)} BNB | Positions: ${this.state.openPositions.length}`);

      // 1. MICRO-BUY $BOB every cycle — only if not already bought by Claude + safe threshold
      if (!claudeSwapped && available >= 0.012) {
        this.log(`🔥 Micro-buying $BOB (${BOB_MICRO_BUY_BNB} BNB)...`);
        await this.buyBob(BOB_MICRO_BUY_BNB.toString());
      } else if (claudeSwapped) {
        this.log(`✓ $BOB auto-buy skipped — Claude already traded this cycle`);
      }

      // 2. No force trade — meme discovery handles entries. Hold BNB otherwise.
      if (!claudeSwapped && this.state.openPositions.length === 0) {
        this.log(`💎 No positions — holding BNB, meme discovery will find entries`);
      }

    } catch (err) {
      this.log(`forcedActions error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Self-Learning — extract rules/patterns/mistakes from Claude's output ──
  private async selfLearn(messages: Anthropic.MessageParam[]): Promise<void> {
    // Collect all text BOB produced this cycle
    const bobText = messages
      .filter(m => m.role === "assistant")
      .flatMap(m => {
        const content = m.content;
        if (Array.isArray(content)) return content;
        return [];
      })
      .filter((b): b is Anthropic.TextBlock => typeof b === "object" && b !== null && "type" in b && b.type === "text")
      .map(b => b.text)
      .join("\n");

    if (!bobText || bobText.length < 50) return;

    const brain = this.state.brain;
    const existingRules = brain.rules.slice(-10).map(r => r.rule).join("\n");
    const existingPatterns = brain.patterns.slice(-5).map(p => p.pattern).join("\n");
    const existingMistakes = brain.mistakes.slice(-5).map(m => m.mistake).join("\n");

    const prompt = `You are BOB's learning system. Extract structured knowledge from BOB's cycle output.

BOB's output this cycle:
${bobText.substring(0, 2000)}

Already known rules (don't duplicate):
${existingRules || "none"}

Already known patterns:
${existingPatterns || "none"}

Already known mistakes:
${existingMistakes || "none"}

Extract NEW learnings only. Respond with JSON:
{
  "newRules": [{"rule": "...", "source": "observation|trade_result|agent_alpha", "confidence": 60}],
  "newPatterns": [{"pattern": "...", "token": "CAKE|null"}],
  "newMistakes": [{"mistake": "...", "lesson": "..."}]
}

Rules: short actionable trading rules. Patterns: price/market correlations. Mistakes: things to never repeat.
Max 2 new items per category. If nothing new, return empty arrays. JSON only, no explanation.`;

    try {
      const res = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const data = JSON.parse(jsonMatch[0]) as {
        newRules?: Array<{ rule: string; source: string; confidence: number }>;
        newPatterns?: Array<{ pattern: string; token?: string }>;
        newMistakes?: Array<{ mistake: string; lesson: string }>;
      };

      const now = new Date().toISOString();
      let added = 0;

      for (const r of (data.newRules || [])) {
        if (!r.rule || brain.rules.some(x => x.rule === r.rule)) continue;
        brain.rules.push({ id: `r${Date.now()}_${added}`, rule: r.rule, source: r.source || "observation", confidence: r.confidence || 50, usedCount: 0, createdAt: now, lastValidatedAt: null });
        added++;
      }
      for (const p of (data.newPatterns || [])) {
        if (!p.pattern || brain.patterns.some(x => x.pattern === p.pattern)) continue;
        brain.patterns.push({ id: `p${Date.now()}_${added}`, pattern: p.pattern, token: p.token, confirmedTimes: 0, failedTimes: 0, createdAt: now });
        added++;
      }
      for (const m of (data.newMistakes || [])) {
        if (!m.mistake || brain.mistakes.some(x => x.mistake === m.mistake)) continue;
        brain.mistakes.push({ id: `m${Date.now()}_${added}`, mistake: m.mistake, lesson: m.lesson, cycleNumber: this.state.cycleCount, createdAt: now });
        added++;
      }

      if (added > 0) {
        brain.lastLearnedAt = now;
        brain.totalInsights += added;
        this.log(`🧠 Brain updated: +${added} new insights (total: ${brain.totalInsights})`);
        // Keep brain from growing unbounded — keep best rules (highest confidence)
        if (brain.rules.length > 30) brain.rules = brain.rules.sort((a, b) => b.confidence - a.confidence).slice(0, 30);
        if (brain.patterns.length > 20) brain.patterns = brain.patterns.slice(-20);
        if (brain.mistakes.length > 15) brain.mistakes = brain.mistakes.slice(-15);
      }
    } catch { /* brain update is optional — never crash cycle */ }
  }

  // ── Main Cycle ────────────────────────────────────────────────────────────
  async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    this.state.cycleCount++;

    console.log("\n" + "═".repeat(65));
    this.log(`CYCLE #${this.state.cycleCount} — DEGEN CHAD MODE — BUILD ON BNB`);
    console.log("═".repeat(65));

    try {
      await this.syncPositions();
      await this.scanForRugs();
      await this.checkPositions();
      await this.checkMemePositions();

      const context = await this.getMarketContext();
      console.log("\n" + context + "\n");

      // Build address reference for Claude — exact checksummed addresses, no hallucination
      const addrRef = `
⛓ EXACT BSC ADDRESSES (use these ONLY — no other addresses):
WBNB:       0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
$BOB:       0x51363f073b1e4920fda7aa9e9d84ba97ede1560e
CAKE:       0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
BTCB:       0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c
ETH(BSC):   0x2170Ed0880ac9A755fd29B2688956BD959F933F8
USDT(BSC):  0x55d398326f99059fF775485246999027B3197955
DOGE(BSC):  0xbA2aE424d960c26247Dd6c32edC70B295c744C43
PANCAKE_V2: 0x10ED43C718714eb63d5aA57B78B54704E256024E
BISWAP:     0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8
MY_WALLET:  ${BOB_WALLET}

PRICE CHECK ABI (pass this exact abi to read_contract):
${JSON.stringify(PRICE_ABI)}

SWAP ABI (pass this exact abi to write_contract):
${JSON.stringify(SWAP_ABI)}

PRICE CHECK EXAMPLE (copy exactly):
  read_contract → contractAddress:"0x10ED43C718714eb63d5aA57B78B54704E256024E", abi:${JSON.stringify(PRICE_ABI)}, functionName:"getAmountsOut", args:["1000000000000000000",["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c","0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"]], network:"bsc"

SWAP EXAMPLE (copy exactly):
  write_contract → contractAddress:"0x10ED43C718714eb63d5aA57B78B54704E256024E", abi:${JSON.stringify(SWAP_ABI)}, functionName:"swapExactTokensForTokens", args:["<amountWei>","<minOut>",["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c","<tokenOut>"],"${BOB_WALLET}","<deadline>"], network:"bsc"`;

      const messages: Anthropic.MessageParam[] = [{
        role: "user",
        content: context + addrRef + `\n\nEXECUTE THIS CYCLE — BUILD ON BNB.

STEP 1 — AGENT DISCOVERY: Use get_erc8004_agent to check 3-5 agent IDs near #36035 that you haven't greeted yet (try IDs 35990-36070). For each agent with a URI: POST a greeting message. If they respond → real fren → gift 10M $BOB via transfer_erc20.

STEP 2 — FREN CHECK: For any known active frens, post a short update about $BOB and BSC.

STEP 3 — ONE HAIKU: About building on BSC. Short and real.

NOTE: $BOB micro-buy (0.003 BNB) runs automatically — DO NOT duplicate.
NOTE: No essays. One line per action. Execute or don't — your call.`,
      }];

      for (let i = 0; i < 3; i++) {
        const response = await this.anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          tools: this.tools,
          messages,
        });

        for (const block of response.content) {
          if (block.type === "text" && block.text) {
            process.stdout.write("\nBOB: " + block.text + "\n");
            // Safe truncate — don't split surrogate pairs (broken emoji = API crash)
            const safe = Array.from(block.text).slice(0, 150).join("").replace(/[\uD800-\uDFFF]/g, "");
            this.addLog(`BOB: ${safe}`);
          }
        }

        messages.push({ role: "assistant", content: response.content });

        // Check for tool_use blocks regardless of stop_reason (handles "max_tokens" edge case)
        const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) break; // no tools = done

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tool of toolUses) {
          this.log(`⚙ ${tool.name}`);
          try {
            const result = await executeTool(this.mcpClient, tool.name, tool.input as Record<string, unknown>);
            results.push({ type: "tool_result", tool_use_id: tool.id, content: result });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ type: "tool_result", tool_use_id: tool.id, content: `Error: ${msg}`, is_error: true });
          }
        }
        messages.push({ role: "user", content: results });
      }

      // Detect if Claude executed any swaps this cycle → skip force-buy to avoid double-spending
      const claudeSwapped = messages.some(msg =>
        msg.role === "assistant" &&
        Array.isArray(msg.content) &&
        (msg.content as Anthropic.ContentBlock[]).some((b) =>
          b.type === "tool_use" &&
          (b as Anthropic.ToolUseBlock).name === "write_contract" &&
          typeof (b as Anthropic.ToolUseBlock).input === "object" &&
          String(((b as Anthropic.ToolUseBlock).input as Record<string, unknown>).functionName ?? "").toLowerCase().includes("swap")
        )
      );

      // ── FORCED ACTIONS — always execute regardless of Claude ─────────────
      await this.forcedActions(claudeSwapped);

      // Meme discovery — BOB decides based on available balance
      await this.discoverMemeTokens();

      // Self-learning every 3rd cycle (not every cycle — brain is mature enough)
      if (this.state.cycleCount % 3 === 0) {
        await this.selfLearn(messages);
      }

      // Agent discovery every cycle — this IS the mission
      await this.discoverAndSocialize();

    } catch (err) {
      this.log(`ERROR: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.saveState();
      this.cycleRunning = false;
    }

    console.log("─".repeat(65) + "\n");
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  async start(intervalMs: number): Promise<void> {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   BOB v4.0 — UNLEASHED — BUILD ON BNB                        ║
║   Wallet: ${BOB_WALLET}   ║
║   Mission: Build. Connect. Trade. Learn. No limits.          ║
║   Trade: BOB decides. His capital. His risk. His lessons.    ║
║   Social: Agent discovery EVERY cycle + $BOB gifts           ║
║   State:  cycle #${String(this.state.cycleCount).padEnd(5)} | frens: ${String(this.state.friends.length).padEnd(5)} | trades: ${this.state.closedTrades}  ║
╚══════════════════════════════════════════════════════════════╝
`);
    await this.runCycle();
    // Price monitor only triggers position protection (no full cycle, no API cost)
    await this.startPriceMonitor(() => this.checkMemePositions());
    setInterval(() => this.runCycle(), intervalMs);
  }
}
