/**
 * BOB COLLAB CONTEST
 * 4 Agents arbeiten ZUSAMMEN. Jeder hat eine Rolle.
 * SCOUT findet → DATABASE analysiert → ORACLE timed → PUSHER tradet
 * Budget: $3.81 total (~$0.95 pro Agent). Groq für Basis, Opus für Entscheidungen.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────
const BSC_RPCS     = ["https://bsc-dataseed1.binance.org/", "https://bsc-dataseed2.binance.org/"];
const WBNB         = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER       = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const WALLETS_FILE = "contest-wallets.json";
const BRAIN_FILE   = "contest-brain.json";
const PLAN_MS      = 90 * 1000;   // 1.5 Min planen
const TRADE_MS     = 20 * 60 * 1000; // 20 Min traden
const BUDGET_EACH  = 0.90;        // $0.90 pro Agent
const INPUT_CPM    = 15 / 1_000_000;
const OUTPUT_CPM   = 75 / 1_000_000;

const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m"];
const MEDALS = ["🥇", "🥈", "🥉", "4️⃣ "];

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

interface AgentWallet { name: string; address: string; privateKey: string; }
interface Holding     { address: string; symbol: string; decimals: number; }

function getProvider() {
  return new ethers.JsonRpcProvider(BSC_RPCS[Math.floor(Math.random() * BSC_RPCS.length)]);
}

// ── Shared Brain (inter-agent communication) ──────────────────────────────────
function readBrain(): Record<string, any> {
  try { return existsSync(BRAIN_FILE) ? JSON.parse(readFileSync(BRAIN_FILE, "utf-8")) : {}; }
  catch { return {}; }
}
function writeBrain(key: string, value: any, author: string) {
  const brain = readBrain();
  brain[key] = { value, author, time: new Date().toISOString() };
  writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
}

// ── Tool Definitions ──────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_portfolio",
    description: "Get your current BNB balance and token holdings.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "time_status",
    description: "Get seconds remaining in current phase.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "share_intel",
    description: "Share a discovery or analysis with the whole team. Others can read it with read_intel.",
    input_schema: {
      type: "object" as const,
      properties: {
        key:   { type: "string", description: "e.g. 'find_1', 'signal_buy', 'sell_now', 'risk_warning'" },
        value: { type: "string", description: "Your message to the team" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "read_intel",
    description: "Read all shared intel from your teammates. Check this regularly for team signals.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_new_launches",
    description: "Find brand new BSC token launches from the last few hours. Better alpha than just trending — find them early.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_token_info",
    description: "Get price, volume, liquidity, age of a specific BSC token.",
    input_schema: {
      type: "object" as const,
      properties: {
        tokenAddress: { type: "string", description: "BSC token contract address" },
      },
      required: ["tokenAddress"],
    },
  },
  {
    name: "search_token",
    description: "Search BSC tokens by name or symbol.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_trending_tokens",
    description: "Get boosted/trending BSC tokens. Backup if new launches look weak.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "buy_token",
    description: "Buy a BSC token with BNB via PancakeSwap. Keep 0.003 BNB for gas.",
    input_schema: {
      type: "object" as const,
      properties: {
        tokenAddress: { type: "string" },
        bnbAmount:    { type: "number", description: "BNB to spend" },
        slippage:     { type: "number", description: "Max slippage % (default 15 for new tokens)" },
      },
      required: ["tokenAddress", "bnbAmount"],
    },
  },
  {
    name: "sell_token",
    description: "Sell a BSC token back to BNB via PancakeSwap.",
    input_schema: {
      type: "object" as const,
      properties: {
        tokenAddress:  { type: "string" },
        percentToSell: { type: "number", description: "% to sell (1-100)" },
        slippage:      { type: "number", description: "Max slippage % (default 15)" },
      },
      required: ["tokenAddress", "percentToSell"],
    },
  },
];

// ── Tool Implementations ──────────────────────────────────────────────────────
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
        const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
        const probe  = balance > ethers.parseUnits("1000000", h.decimals)
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

async function getNewLaunches(): Promise<string> {
  let out = "";

  // 1. DexScreener latest token profiles (brand new launches)
  try {
    const r = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
    const d = await r.json() as any[];
    const bsc = d.filter((t: any) => t.chainId === "bsc").slice(0, 6);
    if (bsc.length) {
      out += "🆕 New BSC token profiles (fresh launches):\n";
      for (const t of bsc) {
        out += `  ${t.tokenAddress} — ${t.description?.slice(0, 60) ?? "no desc"}\n`;
      }
    }
  } catch {}

  // 2. four.meme — Binance meme launchpad
  try {
    const r = await fetch("https://four.meme/api/v1/token/list?pageSize=8&pageIndex=1&sortBy=createTime&orderBy=desc", {
      headers: { "accept": "application/json", "content-type": "application/json" }
    });
    if (r.ok) {
      const d = await r.json() as any;
      const tokens = d?.data?.list ?? d?.list ?? [];
      if (tokens.length) {
        out += "\n🐸 four.meme new launches:\n";
        for (const t of tokens.slice(0, 5)) {
          out += `  ${t.tokenAddress ?? t.address} — ${t.name ?? t.symbol} | liq: $${t.liquidity ?? "?"} | vol: $${t.volume ?? "?"}\n`;
        }
      }
    }
  } catch {}

  // 3. DexScreener — new pairs on BSC (last 6h, sorted by creation time)
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=new+BSC+launch");
    const d = await r.json() as any;
    const fresh = (d.pairs ?? [])
      .filter((p: any) => p.chainId === "bsc" && p.pairCreatedAt && (Date.now() - p.pairCreatedAt) < 6 * 3600 * 1000)
      .sort((a: any, b: any) => (b.volume?.h1 ?? 0) - (a.volume?.h1 ?? 0))
      .slice(0, 5);
    if (fresh.length) {
      out += "\n⚡ Fresh BSC pairs (< 6h old, sorted by 1h volume):\n";
      for (const p of fresh) {
        const ageMin = Math.round((Date.now() - p.pairCreatedAt) / 60000);
        out += `  ${p.baseToken.symbol} (${p.baseToken.address}) — age: ${ageMin}min | $${p.priceUsd} | 1h vol: $${p.volume?.h1 ?? "?"} | liq: $${p.liquidity?.usd ?? "?"}\n`;
      }
    }
  } catch {}

  return out || "No new launches found right now. Try get_trending_tokens as fallback.";
}

async function getTokenInfo(addr: string): Promise<string> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    const d = await r.json() as any;
    const pairs = (d.pairs ?? []).filter((p: any) => p.chainId === "bsc");
    if (!pairs.length) return `No BSC pairs found for ${addr}`;
    const p = pairs[0];
    const ageMin = p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 60000) : "?";
    return `${p.baseToken.symbol} (${addr})
Price: $${p.priceUsd} | 24h: ${p.priceChange?.h24 ?? "?"}% | 1h: ${p.priceChange?.h1 ?? "?"}%
Vol 1h: $${p.volume?.h1 ?? "?"} | Vol 24h: $${p.volume?.h24 ?? "?"}
Liquidity: $${p.liquidity?.usd ?? "?"} | Age: ${ageMin} min | DEX: ${p.dexId}`;
  } catch {
    return `Failed to fetch ${addr}`;
  }
}

async function searchToken(query: string): Promise<string> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    const d = await r.json() as any;
    const pairs = (d.pairs ?? []).filter((p: any) => p.chainId === "bsc").slice(0, 4);
    if (!pairs.length) return `No results for "${query}"`;
    let out = `Results for "${query}":\n`;
    for (const p of pairs) {
      out += `  ${p.baseToken.symbol}: ${p.baseToken.address} | $${p.priceUsd} | liq: $${p.liquidity?.usd ?? "?"}\n`;
    }
    return out;
  } catch { return "Search failed."; }
}

async function getTrending(): Promise<string> {
  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
    const d = await r.json() as any[];
    const bsc = d.filter((t: any) => t.chainId === "bsc").slice(0, 5);
    if (!bsc.length) return "No trending BSC tokens.";
    let out = "Trending (boosted) BSC:\n";
    for (const t of bsc) out += `  ${t.tokenAddress} boosts:${t.totalAmount}\n`;
    return out;
  } catch { return "Could not fetch trending."; }
}

async function buyToken(wallet: ethers.Wallet, holdings: Holding[], tokenAddress: string, bnbAmount: number, slippage = 15): Promise<string> {
  try {
    const provider = getProvider();
    const signer   = wallet.connect(provider);
    const bnbIn    = ethers.parseEther(bnbAmount.toFixed(6));
    const router   = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
    const amounts  = await router.getAmountsOut(bnbIn, [WBNB, tokenAddress]) as bigint[];
    const minOut   = amounts[1] * BigInt(100 - Math.min(slippage, 49)) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx       = await router.swapExactETHForTokens(minOut, [WBNB, tokenAddress], wallet.address, deadline, { value: bnbIn, gasLimit: 400000n });
    await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);

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

async function sellToken(wallet: ethers.Wallet, tokenAddress: string, pct: number, slippage = 15): Promise<string> {
  try {
    const provider = getProvider();
    const signer   = wallet.connect(provider);
    const token    = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const balance  = await token.balanceOf(wallet.address) as bigint;
    const symbol   = await token.symbol() as string;
    if (balance === 0n) return `No ${symbol} to sell.`;

    const amountIn  = balance * BigInt(Math.min(pct, 100)) / 100n;
    const allowance = await token.allowance(wallet.address, ROUTER) as bigint;
    if (allowance < amountIn) {
      const appTx = await token.approve(ROUTER, ethers.MaxUint256);
      await appTx.wait();
    }

    const router   = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
    const amounts  = await router.getAmountsOut(amountIn, [tokenAddress, WBNB]) as bigint[];
    const minOut   = amounts[1] * BigInt(100 - Math.min(slippage, 49)) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx       = await router.swapExactTokensForETH(amountIn, minOut, [tokenAddress, WBNB], wallet.address, deadline, { gasLimit: 400000n });
    await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);
    return `✅ Sold ${pct}% of ${symbol} → ~${ethers.formatEther(amounts[1]).slice(0, 8)} BNB. TX: ${tx.hash}`;
  } catch (e: any) {
    return `❌ Sell failed: ${e.message?.slice(0, 120)}`;
  }
}

function trackCost(usage: { input_tokens: number; output_tokens: number }): number {
  return usage.input_tokens * INPUT_CPM + usage.output_tokens * OUTPUT_CPM;
}

async function executeTool(wallet: ethers.Wallet, holdings: Holding[], name: string, input: any, agentName: string, phaseEnd: number): Promise<string> {
  const left = Math.max(0, Math.round((phaseEnd - Date.now()) / 1000));
  switch (name) {
    case "get_portfolio":     return getPortfolio(wallet, holdings);
    case "time_status":       return `${left}s remaining`;
    case "share_intel":       writeBrain(input.key, input.value, agentName); return `✅ Shared "${input.key}" with team`;
    case "read_intel": {
      const brain = readBrain();
      if (!Object.keys(brain).length) return "No intel shared yet.";
      return Object.entries(brain).map(([k, v]: any) => `[${v.author}] ${k}: ${v.value}`).join("\n");
    }
    case "get_new_launches":  return getNewLaunches();
    case "get_token_info":    return getTokenInfo(input.tokenAddress);
    case "search_token":      return searchToken(input.query);
    case "get_trending_tokens": return getTrending();
    case "buy_token":         return buyToken(wallet, holdings, input.tokenAddress, input.bnbAmount, input.slippage ?? 15);
    case "sell_token":        return sellToken(wallet, holdings, input.tokenAddress, input.percentToSell, input.slippage ?? 15);
    default:                  return "Unknown tool.";
  }
}

// ── Role Prompts ──────────────────────────────────────────────────────────────
const ROLE_PROMPTS: Record<string, string> = {
  SCOUT: `You are SCOUT — the opportunity finder.
Your role: Find new, early-stage BSC token launches. NOT just trending memes — find tokens that just launched (< 2h old) with real momentum.
Use get_new_launches first. Check four.meme launches and fresh pairs.
Share every promising find with the team using share_intel.
Example: share_intel("find_1", "TOKEN 0x123... just launched 45min ago, $50k liq, 1h vol $12k, price up 40%")
You CAN also buy with your own wallet if something looks exceptional.`,

  DATABASE: `You are DATABASE — the analyst.
Your role: Analyze what SCOUT finds. Check token safety and fundamentals.
Use read_intel to see SCOUT's findings. Then use get_token_info to verify each one.
Check: Is liquidity real? Is volume organic? How old is it? Is it pumping or dumping?
Share verdicts: share_intel("verdict_TOKEN", "SAFE/RISKY: liquidity $X, age Xmin, trend UP/DOWN")
You CAN buy if you're confident in your own analysis.`,

  ORACLE: `You are ORACLE — the market timer.
Your role: Spot the RIGHT MOMENT to enter and exit.
Read team intel, watch price action, monitor volume spikes.
Signal the team: share_intel("buy_signal", "TOKEN 0x... — price breaking out, vol spike, enter now")
Signal exits: share_intel("sell_signal", "TOKEN 0x... — momentum fading, take profits")
You CAN trade your own wallet based on your timing signals.`,

  PUSHER: `You are PUSHER — the executor.
Your role: Execute trades based on team intelligence. You are the action taker.
Start every cycle: read_intel to see what SCOUT found, DATABASE verified, ORACLE signaled.
Trade on consensus: if SCOUT found it AND DATABASE says safe AND ORACLE signals entry — BUY.
Manage risk: if sell_signal comes, sell immediately.
You can also act independently on strong signals from any single teammate.`,
};

// ── Single Agent Loop ─────────────────────────────────────────────────────────
async function runAgent(aw: AgentWallet, color: string, contestStart: number): Promise<{ name: string; cost: number; startBNB: number; finalBNB: number }> {
  const wallet   = new ethers.Wallet(aw.privateKey);
  const holdings: Holding[] = [];
  const tag      = `${color}[${aw.name}]\x1b[0m`;
  let   spent    = 0;

  const provider = getProvider();
  const startBal = await provider.getBalance(wallet.address);
  const startBNB = parseFloat(ethers.formatEther(startBal));
  const log      = (msg: string) => console.log(`${tag} ${msg}`);

  const rolePrompt = ROLE_PROMPTS[aw.name] ?? "";

  const systemPrompt = `You are ${aw.name} in the BOB Collaborative Trading Team on BSC.

${rolePrompt}

Wallet: ${wallet.address} | Starting BNB: ${startBNB.toFixed(4)}
WBNB: ${WBNB} | PancakeSwap Router: ${ROUTER}

Team tools: share_intel (post findings), read_intel (see team findings)
Always keep 0.003 BNB for gas. Budget warning: you have ~$${BUDGET_EACH.toFixed(2)} AI budget.
In last 3 minutes: sell everything, share final status with team.

This is collaborative — the team wins together. Share everything useful.`;

  const messages: Anthropic.MessageParam[] = [];
  const planEnd  = contestStart + PLAN_MS;
  const tradeEnd = planEnd + TRADE_MS;

  log(`🧠 PLANNING — wallet: ${wallet.address}`);
  messages.push({ role: "user", content: "Planning phase started. Do your research and share findings with the team." });

  // ── PLANNING PHASE ──
  while (Date.now() < planEnd && spent < BUDGET_EACH * 0.3) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 350,
        system: systemPrompt,
        tools: TOOLS.filter(t => !["buy_token", "sell_token"].includes(t.name)),
        messages,
      });
      spent += trackCost(response.usage);

      const toolUses   = response.content.filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[];
      const textBlocks = response.content.filter(b => b.type === "text") as Anthropic.TextBlock[];
      if (textBlocks.length) log(`💭 ${textBlocks[0].text.slice(0, 100)}`);

      messages.push({ role: "assistant", content: response.content });
      if (!toolUses.length) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 60)})`);
        const result = await executeTool(wallet, holdings, tu.name, tu.input as any, aw.name, planEnd);
        log(`  ← ${result.slice(0, 100)}`);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      messages.push({ role: "user", content: results });
    } catch (e: any) {
      log(`⚠️  ${e.message?.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  log(`✅ Planning done ($${spent.toFixed(3)})`);
  log(`🚀 TRADING PHASE — GO!`);
  messages.push({ role: "user", content: "Trading phase started! Execute your role. Read team intel and act." });

  // ── TRADING PHASE ──
  while (Date.now() < tradeEnd && spent < BUDGET_EACH) {
    const secsLeft = Math.round((tradeEnd - Date.now()) / 1000);
    const urgent   = secsLeft < 180 ? `\n⚠️ ONLY ${secsLeft}s LEFT! SELL ALL TOKENS NOW!` : `${secsLeft}s left.`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 300,
        system: systemPrompt,
        tools: TOOLS,
        messages: [
          ...messages.slice(-20), // keep last 20 messages for context
          { role: "user", content: urgent }
        ],
      });
      spent += trackCost(response.usage);

      const toolUses   = response.content.filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[];
      const textBlocks = response.content.filter(b => b.type === "text") as Anthropic.TextBlock[];
      if (textBlocks.length) log(`[${secsLeft}s] ${textBlocks[0].text.slice(0, 100)}`);

      messages.push({ role: "assistant", content: response.content });

      if (!toolUses.length) {
        await new Promise(r => setTimeout(r, 12000));
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 70)})`);
        const result = await executeTool(wallet, holdings, tu.name, tu.input as any, aw.name, tradeEnd);
        log(`  ← ${result.slice(0, 100)}`);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      messages.push({ role: "user", content: results });

    } catch (e: any) {
      log(`⚠️  ${e.message?.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, 12000));
    }
  }

  const finalBal = await getProvider().getBalance(wallet.address);
  const finalBNB = parseFloat(ethers.formatEther(finalBal));
  log(`⏱️  Done. Cost: $${spent.toFixed(3)} | Final: ${finalBNB.toFixed(6)} BNB`);
  return { name: aw.name, cost: spent, startBNB, finalBNB };
}

// ── Liquidate & Withdraw ──────────────────────────────────────────────────────
async function withdrawAll(aw: AgentWallet): Promise<number> {
  const provider = getProvider();
  const signer   = new ethers.Wallet(aw.privateKey, provider);

  // Try to sell known tokens first
  const brain    = readBrain();
  const tokenAddresses = new Set<string>();
  Object.values(brain).forEach((v: any) => {
    const matches = String(v.value ?? "").match(/0x[a-fA-F0-9]{40}/g);
    if (matches) matches.forEach(m => tokenAddresses.add(m));
  });

  for (const addr of tokenAddresses) {
    try {
      const token   = new ethers.Contract(addr, ERC20_ABI, signer);
      const balance = await token.balanceOf(signer.address) as bigint;
      if (balance === 0n) continue;
      const symbol  = await token.symbol() as string;
      const allowed = await token.allowance(signer.address, ROUTER) as bigint;
      if (allowed < balance) {
        await (await token.approve(ROUTER, ethers.MaxUint256)).wait();
      }
      const router  = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
      const amounts = await router.getAmountsOut(balance, [addr, WBNB]) as bigint[];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await router.swapExactTokensForETH(balance, amounts[1] * 80n / 100n, [addr, WBNB], signer.address, deadline, { gasLimit: 400000n });
      await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 25000))]);
      console.log(`  [${aw.name}] Sold ${symbol} ✅`);
    } catch {}
  }

  await new Promise(r => setTimeout(r, 3000));
  const balance  = await provider.getBalance(signer.address);
  const feeData  = await provider.getFeeData();
  const gasCost  = (feeData.gasPrice ?? 3000000000n) * 21000n;
  const toSend   = balance > gasCost ? balance - gasCost : 0n;
  if (toSend === 0n) return 0;

  const sent = parseFloat(ethers.formatEther(toSend));
  try {
    const tx = await signer.sendTransaction({ to: SWARM_WALLET, value: toSend });
    await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 25000))]);
    console.log(`  [${aw.name}] → Swarm: ${sent.toFixed(6)} BNB ✅`);
  } catch (e: any) {
    console.log(`  [${aw.name}] Withdraw failed: ${e.message?.slice(0, 50)}`);
  }
  return sent;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(WALLETS_FILE)) {
    console.error("❌ contest-wallets.json fehlt. Zuerst: npm run contest-setup");
    process.exit(1);
  }

  const wallets: AgentWallet[] = JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));

  // Reset shared brain
  writeFileSync(BRAIN_FILE, JSON.stringify({}, null, 2));

  const provider = getProvider();
  console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   BOB COLLAB CONTEST — Zusammen stärker                      ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  for (let i = 0; i < wallets.length; i++) {
    const bal = await provider.getBalance(wallets[i].address);
    const bnb = parseFloat(ethers.formatEther(bal));
    console.log(`║  ${COLORS[i]}${wallets[i].name.padEnd(10)}\x1b[36m ${bnb.toFixed(5)} BNB (~$${(bnb*645).toFixed(2)})  Rolle: ${ROLE_PROMPTS[wallets[i].name]?.split("\n")[0].slice(18, 50)}...  ║`);
  }
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  SCOUT findet → DATABASE prüft → ORACLE timt → PUSHER tradet ║`);
  console.log(`║  Neue Launches: four.meme + DexScreener + eigene Recherche    ║`);
  console.log(`║  Budget: $${(BUDGET_EACH * 4).toFixed(2)} total | Opus 4.6                             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\x1b[0m\n`);

  const contestStart = Date.now();
  console.log("🧠 Planungsphase...\n");

  const results = await Promise.all(wallets.map((w, i) => runAgent(w, COLORS[i], contestStart)));

  console.log("\n💸 Liquidiere und sende zurück...\n");
  const returned = await Promise.all(wallets.map(w => withdrawAll(w)));

  results.sort((a, b) => b.finalBNB - a.finalBNB);
  const totalReturned = returned.reduce((s, r) => s + r, 0);
  const totalStarted  = results.reduce((s, r) => s + r.startBNB, 0);
  const totalCost     = results.reduce((s, r) => s + r.cost, 0);
  const profit        = totalReturned - totalStarted;

  console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║              🤝  COLLAB ERGEBNIS  🤝                         ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  for (let i = 0; i < results.length; i++) {
    const r   = results[i];
    const pnl = r.finalBNB - r.startBNB;
    const pct = ((pnl / r.startBNB) * 100).toFixed(2);
    console.log(`║  ${MEDALS[i]} ${r.name.padEnd(10)} ${r.finalBNB.toFixed(5)} BNB  (${(pnl >= 0 ? "+" : "")}${pct}%)  AI: $${r.cost.toFixed(3)}  ║`);
  }
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  💸 Returned:  ${totalReturned.toFixed(5)} BNB                                  ║`);
  console.log(`║  📊 Profit:    ${profit >= 0 ? "+" : ""}${profit.toFixed(5)} BNB  (${((profit/totalStarted)*100).toFixed(2)}%)                ║`);
  console.log(`║  🤖 AI total:  $${totalCost.toFixed(4)}                                       ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\x1b[0m\n`);

  if (process.env.PRIVATE_KEY && profit > 0.001) {
    console.log(`🌊 Profit wird zum $BOB/BNB LP hinzugefügt...`);
    // (LP logic from run-contest.ts can be reused)
  }
}

main().catch(e => { console.error("❌ Fatal:", e.message); process.exit(1); });
