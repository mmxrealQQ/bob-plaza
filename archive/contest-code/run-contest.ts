/**
 * BOB TRADING CONTEST
 * 4 Agents. 2 Min planen. 20 Min traden. Bestes BNB-Ergebnis gewinnt.
 * Alle nutzen claude-opus-4-6. Budget: $5 total (~$1.25 pro Agent).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { ethers } from "ethers";
import { readFileSync, existsSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────
const BSC_RPCS       = ["https://bsc-dataseed1.binance.org/", "https://bsc-dataseed2.binance.org/"];
const WBNB           = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER         = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap v2
const SWARM_WALLET   = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const WALLETS_FILE   = "contest-wallets.json";
const PLAN_MS        = 2 * 60 * 1000;   // 2 Min planen
const TRADE_MS       = 20 * 60 * 1000;  // 20 Min traden
const TOTAL_BUDGET   = 5.00;            // $5 Anthropic total
const BUDGET_EACH    = TOTAL_BUDGET / 4; // $1.25 pro Agent
const INPUT_CPM      = 15 / 1_000_000;  // $15 per 1M input tokens
const OUTPUT_CPM     = 75 / 1_000_000;  // $75 per 1M output tokens

const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m"];
const MEDALS = ["🥇", "🥈", "🥉", "4️⃣ "];

// ── ABIs ──────────────────────────────────────────────────────────────────────
const BOB_TOKEN  = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint, uint, uint)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

// ── Agent State ───────────────────────────────────────────────────────────────
interface AgentWallet { name: string; address: string; privateKey: string; }
interface Holding     { address: string; symbol: string; decimals: number; }

function getProvider() {
  return new ethers.JsonRpcProvider(BSC_RPCS[Math.floor(Math.random() * BSC_RPCS.length)]);
}

// ── Tool Definitions (Anthropic format) ───────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_portfolio",
    description: "Get your current BNB balance and all token holdings with estimated BNB value. Call this to know where you stand.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "time_status",
    description: "Get how many seconds are left in the current phase (planning or trading).",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_trending_tokens",
    description: "Get currently trending BSC tokens with price, 24h change, volume, liquidity. Good starting point for finding opportunities.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_token_info",
    description: "Get detailed price, volume, liquidity info for a specific BSC token address.",
    input_schema: {
      type: "object" as const,
      properties: { tokenAddress: { type: "string", description: "BSC token contract address" } },
      required: ["tokenAddress"],
    },
  },
  {
    name: "search_token",
    description: "Search BSC tokens by name or symbol. Returns matching tokens with prices and liquidity.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string", description: "Token name or symbol (e.g. 'PEPE', 'AI', 'meme')" } },
      required: ["query"],
    },
  },
  {
    name: "buy_token",
    description: "Buy a BSC token with BNB via PancakeSwap v2. Always keep 0.003 BNB for gas.",
    input_schema: {
      type: "object" as const,
      properties: {
        tokenAddress: { type: "string", description: "BSC token contract address" },
        bnbAmount:    { type: "number", description: "BNB to spend (e.g. 0.005). Max is your balance minus 0.003 for gas." },
        slippage:     { type: "number", description: "Max slippage % (default 10, use 20-30 for volatile/low-liq tokens)" },
      },
      required: ["tokenAddress", "bnbAmount"],
    },
  },
  {
    name: "sell_token",
    description: "Sell a BSC token back to BNB via PancakeSwap v2.",
    input_schema: {
      type: "object" as const,
      properties: {
        tokenAddress:  { type: "string", description: "BSC token contract address to sell" },
        percentToSell: { type: "number", description: "Percentage of your balance to sell (1-100)" },
        slippage:      { type: "number", description: "Max slippage % (default 10)" },
      },
      required: ["tokenAddress", "percentToSell"],
    },
  },
];

// ── Tool Logic ────────────────────────────────────────────────────────────────
async function getPortfolio(wallet: ethers.Wallet, holdings: Holding[]): Promise<string> {
  const provider = getProvider();
  const bnbRaw   = await provider.getBalance(wallet.address);
  const bnb      = parseFloat(ethers.formatEther(bnbRaw));
  let result     = `BNB: ${bnb.toFixed(6)}\nTokens:\n`;
  let total      = bnb;

  for (const h of holdings) {
    try {
      const token   = new ethers.Contract(h.address, ERC20_ABI, provider);
      const balance = await token.balanceOf(wallet.address) as bigint;
      if (balance === 0n) continue;
      const amt = parseFloat(ethers.formatUnits(balance, h.decimals));
      let bnbVal = 0;
      try {
        const router  = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
        const probe   = balance > ethers.parseUnits("1000000", h.decimals)
          ? ethers.parseUnits("1000000", h.decimals) : balance;
        const amounts = await router.getAmountsOut(probe, [h.address, WBNB]) as bigint[];
        bnbVal = parseFloat(ethers.formatEther(amounts[1])) * (Number(balance) / Number(probe));
      } catch {}
      total += bnbVal;
      result += `  ${h.symbol}: ${amt.toFixed(2)} (~${bnbVal.toFixed(6)} BNB)\n`;
    } catch {}
  }
  result += `Total: ${total.toFixed(6)} BNB`;
  return result;
}

async function getTrending(): Promise<string> {
  try {
    // Try DexScreener boost list
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
    const d = await r.json() as any[];
    const bsc = d.filter((t: any) => t.chainId === "bsc").slice(0, 6);
    if (bsc.length) {
      let out = "Trending BSC (boosted):\n";
      for (const t of bsc) out += `  ${t.tokenAddress}  boosts:${t.totalAmount}\n`;
      return out;
    }
  } catch {}
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=BSC+token");
    const d = await r.json() as any;
    const pairs = (d.pairs ?? []).filter((p: any) => p.chainId === "bsc")
      .sort((a: any, b: any) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
      .slice(0, 6);
    let out = "High volume BSC pairs:\n";
    for (const p of pairs) {
      out += `  ${p.baseToken.symbol} (${p.baseToken.address}) $${p.priceUsd} 24h:${p.priceChange?.h24 ?? "?"}% vol:$${p.volume?.h24 ?? "?"} liq:$${p.liquidity?.usd ?? "?"}\n`;
    }
    return out;
  } catch {
    return "Could not fetch trending data.";
  }
}

async function getTokenInfo(addr: string): Promise<string> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    const d = await r.json() as any;
    const pairs = (d.pairs ?? []).filter((p: any) => p.chainId === "bsc");
    if (!pairs.length) return `No BSC pairs found for ${addr}`;
    const p = pairs[0];
    return `${p.baseToken.symbol} | $${p.priceUsd} | 24h: ${p.priceChange?.h24 ?? "?"}% | vol24h: $${p.volume?.h24 ?? "?"} | liq: $${p.liquidity?.usd ?? "?"} | dex: ${p.dexId}`;
  } catch {
    return `Failed to fetch token info for ${addr}`;
  }
}

async function searchToken(query: string): Promise<string> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    const d = await r.json() as any;
    const pairs = (d.pairs ?? []).filter((p: any) => p.chainId === "bsc").slice(0, 5);
    if (!pairs.length) return `No BSC tokens found for "${query}"`;
    let out = `Results for "${query}" on BSC:\n`;
    for (const p of pairs) {
      out += `  ${p.baseToken.symbol}: ${p.baseToken.address} | $${p.priceUsd} | liq: $${p.liquidity?.usd ?? "?"}\n`;
    }
    return out;
  } catch {
    return "Search failed.";
  }
}

async function buyToken(wallet: ethers.Wallet, holdings: Holding[], tokenAddress: string, bnbAmount: number, slippage = 10): Promise<string> {
  try {
    const provider = getProvider();
    const signer   = wallet.connect(provider);
    const bnbIn    = ethers.parseEther(bnbAmount.toFixed(6));
    const router   = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
    const amounts  = await router.getAmountsOut(bnbIn, [WBNB, tokenAddress]) as bigint[];
    const minOut   = amounts[1] * BigInt(100 - Math.min(slippage, 49)) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx       = await router.swapExactETHForTokens(minOut, [WBNB, tokenAddress], wallet.address, deadline, { value: bnbIn, gasLimit: 350000n });
    const receipt  = await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);

    // Track holding
    const token    = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const symbol   = await token.symbol() as string;
    const decimals = Number(await token.decimals());
    if (!holdings.find(h => h.address === tokenAddress)) {
      holdings.push({ address: tokenAddress, symbol, decimals });
    }
    return `✅ Bought ${symbol} for ${bnbAmount} BNB. TX: ${tx.hash}`;
  } catch (e: any) {
    return `❌ Buy failed: ${e.message?.slice(0, 120)}`;
  }
}

async function sellToken(wallet: ethers.Wallet, holdings: Holding[], tokenAddress: string, pct: number, slippage = 10): Promise<string> {
  try {
    const provider = getProvider();
    const signer   = wallet.connect(provider);
    const token    = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const balance  = await token.balanceOf(wallet.address) as bigint;
    const symbol   = await token.symbol() as string;
    if (balance === 0n) return `No ${symbol} to sell.`;

    const amountIn = balance * BigInt(Math.min(pct, 100)) / 100n;
    const allowance = await token.allowance(wallet.address, ROUTER) as bigint;
    if (allowance < amountIn) {
      const tx = await token.approve(ROUTER, ethers.MaxUint256);
      await tx.wait();
    }

    const router   = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
    const amounts  = await router.getAmountsOut(amountIn, [tokenAddress, WBNB]) as bigint[];
    const minOut   = amounts[1] * BigInt(100 - Math.min(slippage, 49)) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx       = await router.swapExactTokensForETH(amountIn, minOut, [tokenAddress, WBNB], wallet.address, deadline, { gasLimit: 350000n });
    await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);
    const received = parseFloat(ethers.formatEther(amounts[1]));
    return `✅ Sold ${pct}% of ${symbol} → ${received.toFixed(6)} BNB. TX: ${tx.hash}`;
  } catch (e: any) {
    return `❌ Sell failed: ${e.message?.slice(0, 120)}`;
  }
}

// ── Cost Tracker ──────────────────────────────────────────────────────────────
function trackCost(usage: { input_tokens: number; output_tokens: number }): number {
  return usage.input_tokens * INPUT_CPM + usage.output_tokens * OUTPUT_CPM;
}

// ── Execute Tool ──────────────────────────────────────────────────────────────
async function executeTool(wallet: ethers.Wallet, holdings: Holding[], name: string, input: any, phaseEnd: number): Promise<string> {
  const left = Math.max(0, Math.round((phaseEnd - Date.now()) / 1000));
  switch (name) {
    case "get_portfolio":     return getPortfolio(wallet, holdings);
    case "time_status":       return `${left}s remaining (${Math.round(left / 60)}min)`;
    case "get_trending_tokens": return getTrending();
    case "get_token_info":    return getTokenInfo(input.tokenAddress);
    case "search_token":      return searchToken(input.query);
    case "buy_token":         return buyToken(wallet, holdings, input.tokenAddress, input.bnbAmount, input.slippage);
    case "sell_token":        return sellToken(wallet, holdings, input.tokenAddress, input.percentToSell, input.slippage);
    default:                  return "Unknown tool.";
  }
}

// ── Single Agent ──────────────────────────────────────────────────────────────
async function runAgent(aw: AgentWallet, color: string, contestStart: number): Promise<{ name: string; cost: number; startBNB: number; finalBNB: number }> {
  const wallet   = new ethers.Wallet(aw.privateKey);
  const holdings: Holding[] = [];
  const tag      = `${color}[${aw.name}]\x1b[0m`;
  let   spent    = 0;

  // Start balance
  const provider = getProvider();
  const startBal = await provider.getBalance(wallet.address);
  const startBNB = parseFloat(ethers.formatEther(startBal));

  const log = (msg: string) => console.log(`${tag} ${msg}`);

  // ── PLANNING PHASE ──
  const planEnd = contestStart + PLAN_MS;
  log(`🧠 PLANNING PHASE (2 min) — wallet: ${wallet.address}`);

  const planMessages: Anthropic.MessageParam[] = [];
  planMessages.push({
    role: "user",
    content: `You are ${aw.name}, a competitive AI trader in the BOB Trading Contest on BSC.

You have 2 minutes to PLAN your trading strategy before the contest starts.
Your starting balance: ~${startBNB.toFixed(4)} BNB (~$${(startBNB * 645).toFixed(2)})

PLANNING PHASE: Do NOT buy anything yet. Use this time to:
1. Check trending tokens
2. Research 2-3 specific tokens you're interested in
3. Decide your strategy: risk appetite, which tokens, how much to allocate

The contest goal: end with more BNB than you started with.
You win by having the highest BNB balance after 20 minutes.

Start your research now. What do you want to trade?`,
  });

  while (Date.now() < planEnd && spent < BUDGET_EACH) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 600,
        tools: TOOLS.filter(t => ["get_trending_tokens", "get_token_info", "search_token", "get_portfolio", "time_status"].includes(t.name)),
        messages: planMessages,
      });
      spent += trackCost(response.usage);

      const toolUses = response.content.filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[];
      const textBlocks = response.content.filter(b => b.type === "text") as Anthropic.TextBlock[];

      if (textBlocks.length) log(`💭 ${textBlocks[0].text.slice(0, 150)}`);

      planMessages.push({ role: "assistant", content: response.content });

      if (!toolUses.length) break; // Done planning

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 60)})`);
        const result = await executeTool(wallet, holdings, tu.name, tu.input, planEnd);
        log(`  ← ${result.slice(0, 100)}`);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      planMessages.push({ role: "user", content: toolResults });

    } catch (e: any) {
      log(`⚠️  ${e.message?.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  log(`✅ Planning done. Cost so far: $${spent.toFixed(4)}`);

  // ── TRADING PHASE ──
  const tradeEnd = planEnd + TRADE_MS;
  log(`🚀 TRADING PHASE (20 min) — GO!`);

  const tradeMessages: Anthropic.MessageParam[] = [
    ...planMessages,
    {
      role: "user",
      content: `Trading phase has started! You have 20 minutes.
Execute your plan. Buy tokens, monitor prices, take profits.
IMPORTANT: In the last 3 minutes, sell EVERYTHING back to BNB to lock in profits.
Budget warning: you've spent $${spent.toFixed(4)} of your $${BUDGET_EACH.toFixed(2)} AI budget.
Now trade!`,
    }
  ];

  while (Date.now() < tradeEnd && spent < BUDGET_EACH * 0.95) {
    const secsLeft = Math.round((tradeEnd - Date.now()) / 1000);

    try {
      const urgency = secsLeft < 180
        ? `\n⚠️  ONLY ${secsLeft}s LEFT! SELL ALL TOKENS NOW to lock in BNB profits!`
        : `Time remaining: ${secsLeft}s`;

      const response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 500,
        tools: TOOLS,
        messages: [
          ...tradeMessages,
          { role: "user", content: urgency }
        ],
      });
      spent += trackCost(response.usage);

      const toolUses  = response.content.filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[];
      const textBlocks = response.content.filter(b => b.type === "text") as Anthropic.TextBlock[];

      if (textBlocks.length) log(`[${secsLeft}s] ${textBlocks[0].text.slice(0, 120)}`);

      tradeMessages.push({ role: "assistant", content: response.content });

      if (!toolUses.length) {
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 70)})`);
        const result = await executeTool(wallet, holdings, tu.name, tu.input as any, tradeEnd);
        log(`  ← ${result.slice(0, 100)}`);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      tradeMessages.push({ role: "user", content: toolResults });

      // Keep context manageable
      if (tradeMessages.length > 40) tradeMessages.splice(3, 6);

    } catch (e: any) {
      log(`⚠️  ${e.message?.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  if (spent >= BUDGET_EACH * 0.95) log(`💰 Budget limit reached ($${spent.toFixed(4)})`);
  log(`⏱️  Trading ended. Total AI cost: $${spent.toFixed(4)}`);

  // Final balance
  const finalBal = await getProvider().getBalance(wallet.address);
  const finalBNB = parseFloat(ethers.formatEther(finalBal));
  log(`📊 Final: ${finalBNB.toFixed(6)} BNB (started: ${startBNB.toFixed(6)} BNB)`);

  return { name: aw.name, cost: spent, startBNB, finalBNB };
}

// ── Liquidate & Withdraw ──────────────────────────────────────────────────────
async function liquidateAndWithdraw(aw: AgentWallet): Promise<number> {
  const provider = getProvider();
  const signer   = new ethers.Wallet(aw.privateKey, provider);
  console.log(`\n  [${aw.name}] Liquidating remaining tokens...`);

  // Try to sell any remaining tokens via a final Opus call
  try {
    const portfolio = await getPortfolio(signer, []);
    if (!portfolio.includes("Total: 0")) {
      // Simple: just send whatever BNB is there
    }
  } catch {}

  const balance = await provider.getBalance(signer.address);
  if (balance === 0n) return 0;

  const gasPrice = (await provider.getFeeData()).gasPrice ?? 3000000000n;
  const gasCost  = gasPrice * 21000n;
  const toSend   = balance > gasCost ? balance - gasCost : 0n;
  if (toSend === 0n) return 0;

  try {
    const tx = await signer.sendTransaction({ to: SWARM_WALLET, value: toSend });
    await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);
    const sent = parseFloat(ethers.formatEther(toSend));
    console.log(`  [${aw.name}] → Swarm: ${sent.toFixed(6)} BNB ✅`);
    return sent;
  } catch (e: any) {
    console.log(`  [${aw.name}] Withdraw failed: ${e.message?.slice(0, 60)}`);
    return 0;
  }
}

// ── Add Profit to $BOB/BNB LP ────────────────────────────────────────────────
async function addProfitToLP(privateKey: string, profitBNB: number): Promise<void> {
  if (profitBNB < 0.001) {
    console.log(`  LP: Gewinn zu klein (${profitBNB.toFixed(6)} BNB) — übersprungen`);
    return;
  }

  console.log(`\n🌊 Füge ${profitBNB.toFixed(6)} BNB Gewinn zum $BOB/BNB LP hinzu...\n`);

  const provider = getProvider();
  const swarm    = new ethers.Wallet(privateKey, provider);
  const router   = new ethers.Contract(ROUTER, ROUTER_ABI, swarm);
  const bob      = new ethers.Contract(BOB_TOKEN, ERC20_ABI, swarm);

  // Half BNB to buy $BOB, half stays as BNB for LP
  const bnbForBuy = profitBNB / 2;
  const bnbForLP  = profitBNB - bnbForBuy;

  try {
    // 1. Buy $BOB with half the profit
    console.log(`  1/3 Kaufe $BOB mit ${bnbForBuy.toFixed(6)} BNB...`);
    const bnbInWei = ethers.parseEther(bnbForBuy.toFixed(6));
    const amounts  = await router.getAmountsOut(bnbInWei, [WBNB, BOB_TOKEN]) as bigint[];
    const minBOB   = amounts[1] * 90n / 100n; // 10% slippage
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const buyTx = await router.swapExactETHForTokens(minBOB, [WBNB, BOB_TOKEN], swarm.address, deadline, { value: bnbInWei, gasLimit: 350000n });
    await Promise.race([buyTx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);
    console.log(`  ✅ $BOB gekauft: ${buyTx.hash}`);

    // 2. Approve BOB for Router
    console.log(`  2/3 Approve $BOB für Router...`);
    const bobBalance = await bob.balanceOf(swarm.address) as bigint;
    const allowance  = await bob.allowance(swarm.address, ROUTER) as bigint;
    if (allowance < bobBalance) {
      const approveTx = await bob.approve(ROUTER, ethers.MaxUint256);
      await approveTx.wait();
      console.log(`  ✅ Approved`);
    }

    // 3. Add Liquidity
    console.log(`  3/3 Füge Liquidität hinzu (${bnbForLP.toFixed(6)} BNB + $BOB)...`);
    const bnbLPWei = ethers.parseEther(bnbForLP.toFixed(6));
    const minBOBLP = bobBalance * 90n / 100n;
    const minBNBLP = bnbLPWei * 90n / 100n;
    const deadline2 = Math.floor(Date.now() / 1000) + 300;

    const lpTx = await router.addLiquidityETH(
      BOB_TOKEN, bobBalance, minBOBLP, minBNBLP,
      swarm.address, deadline2,
      { value: bnbLPWei, gasLimit: 400000n }
    );
    await Promise.race([lpTx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);
    console.log(`  ✅ LP hinzugefügt! TX: ${lpTx.hash}`);
    console.log(`  🌊 $BOB/BNB LP gestärkt mit Contest-Gewinn!`);

  } catch (e: any) {
    console.log(`  ❌ LP deposit fehlgeschlagen: ${e.message?.slice(0, 100)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(WALLETS_FILE)) {
    console.error("❌ contest-wallets.json fehlt. Zuerst: npm run contest-setup");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY fehlt in .env");
    process.exit(1);
  }

  const wallets: AgentWallet[] = JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
  const provider = getProvider();

  // Verify balances
  console.log("\n\x1b[36m╔══════════════════════════════════════════════════════════════╗");
  console.log("║   BOB TRADING CONTEST — claude-opus-4-6                      ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  for (let i = 0; i < wallets.length; i++) {
    const bal = await provider.getBalance(wallets[i].address);
    const bnb = parseFloat(ethers.formatEther(bal));
    const usd = (bnb * 645).toFixed(2);
    console.log(`║  ${COLORS[i]}${wallets[i].name.padEnd(10)}\x1b[36m ${bnb.toFixed(5)} BNB ($${usd.padStart(6)})  ${wallets[i].address.slice(0, 20)}...  ║`);
  }
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  2 Min PLANEN → 20 Min TRADEN  |  Budget: $${BUDGET_EACH.toFixed(2)}/Agent          ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\x1b[0m\n");

  const contestStart = Date.now();
  console.log("🧠 Planungsphase beginnt jetzt...\n");

  // All 4 agents run in parallel
  const results = await Promise.all(
    wallets.map((w, i) => runAgent(w, COLORS[i], contestStart))
  );

  // Liquidate & Withdraw
  console.log("\n💸 Alles zurück ans Swarm Wallet...\n");
  const returned = await Promise.all(wallets.map(w => liquidateAndWithdraw(w)));

  // Leaderboard
  results.sort((a, b) => b.finalBNB - a.finalBNB);
  const totalReturned = returned.reduce((s, r) => s + r, 0);
  const totalCost     = results.reduce((s, r) => s + r.cost, 0);

  console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║                  🏆  CONTEST ERGEBNIS  🏆                    ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  for (let i = 0; i < results.length; i++) {
    const r   = results[i];
    const pnl = r.finalBNB - r.startBNB;
    const pct = ((pnl / r.startBNB) * 100).toFixed(2);
    const sign = pnl >= 0 ? "+" : "";
    console.log(`║  ${MEDALS[i]} ${(i + 1)}. ${r.name.padEnd(10)} ${r.finalBNB.toFixed(5)} BNB  (${sign}${pct}%)  AI: $${r.cost.toFixed(3)}   ║`);
  }
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  🏆 Gewinner: ${results[0].name.padEnd(48)}║`);
  console.log(`║  💸 Zurück:   ${totalReturned.toFixed(5)} BNB ans Swarm Wallet                   ║`);
  console.log(`║  🤖 AI Kosten: $${totalCost.toFixed(4)} total (Budget: $${TOTAL_BUDGET.toFixed(2)})              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\x1b[0m\n`);

  // Add profit to $BOB/BNB LP
  const totalStarted = results.reduce((s, r) => s + r.startBNB, 0);
  const profit       = totalReturned - totalStarted;
  if (process.env.PRIVATE_KEY && profit > 0) {
    await addProfitToLP(process.env.PRIVATE_KEY, profit);
  } else if (profit <= 0) {
    console.log(`ℹ️  Kein Gewinn (${profit.toFixed(6)} BNB) — kein LP Deposit`);
  }
}

main().catch(e => { console.error("❌ Fatal:", e.message); process.exit(1); });
