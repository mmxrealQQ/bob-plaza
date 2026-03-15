/**
 * BOB RESCUE — Alle Bot-Wallets scannen, stuck Tokens verkaufen, BNB retten
 *
 * Was es tut:
 * 1. Journal + bekannte Tokens + RPC Transfer-Logs → ALLE Token-Adressen finden
 * 2. Jeder Token mit Balance > 0 → Approve + Sell via PancakeSwap (V2 direct + USDT hop)
 * 3. WBNB → BNB unwrappen
 * 4. Finales BNB-Guthaben anzeigen
 *
 * npm run rescue
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { connectBNBChain, executeTool } from "./mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ── Konstanten ──────────────────────────────────────────────────────────────────
const WBNB   = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const USDT   = "0x55d398326f99059fF775485246999027B3197955";
const SMART_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
const JOURNAL = "data/bob-journal.json";

const SKIP_TOKENS = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB (unwrap separat)
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8", // ETH
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", // CAKE
  "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e", // $BOB — NICHT verkaufen!
  // Bekannte Scamcoins (Airdrop-Spam, nicht sellbar, spart Gas+Zeit)
  "0xb8b65b02bc7587f4f7635774742361db803e6066", // OpenClaw/Skills — Scam Airdrop
  "0x306d239d42381042d3a0705285923be7d2b1045c", // zesty.bet — Scam Airdrop
  "0x4a3e46ffa087be7c90a9082357da774d638bfbcb", // 龙虾 — Scam Airdrop
  "0x02578bac89cb36057ee0b427c4469a680ecbdc40", // Unitas/UP空投 — Scam Airdrop
  "0xe4dd809ea09ab0894109d059d7491eaa49d5b02e", // BC.GAME — Scam Airdrop
  "0x2165e95ca6b755a30cf898a3de093329f16a1b3b", // 皮皮虾 — Scam Airdrop
  "0x05cca08f1b0fa640c2ff8a8a812ffea291fe7f1d", // 龙虾人生 — Scam Airdrop
  "0xfafc333334a8d712a948b611540d0ee5e9635044", // LP之王 — Scam Airdrop
  "0x3d93e4838109d8dfb5c7d8cd5053fd888aee0d09", // 赛博龙虾 — Scam Airdrop
  "0x99a9d13fa0f80cbda958270ea5b0ff5368c7b901", // 共享龙虾 — Scam Airdrop
  "0x3b88c6c5ed2cb655483144f34070cedec8a16683", // Moltbook — Scam Airdrop
]);

const BOT_NAMES: Record<string, string> = {
  SCOUT: "BLAZE", DATABASE: "BRAIN", PUSHER: "BOOST", ORACLE: "BANK",
};

// ── Bekannte Tokens die in den Wallets stecken (von BscScan + DexScreener verifiziert) ──
const KNOWN_TOKENS: { addr: string; sym: string }[] = [
  // === Von User BscScan Screenshots (alle Wallets) ===
  { addr: "0xca3A5c193daB5d2720D77db5BD78B2fB3537ba05", sym: "FLAPAI" },
  { addr: "0xc20E45E49e0E79f0fC81E71F05fD2772d6587777", sym: "MILADY" },
  { addr: "0xE1ab61f7b093435204dF32F5b3A405de55445Ea8", sym: "ICE" },
  { addr: "0xb150e91Cb40909F47d45115eE9E90667D807464B", sym: "CREATOR" },
  { addr: "0x5d3A12c42E5372B2CC3264AB3cdcF660a1555238", sym: "ARIA.AI" },
  { addr: "0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA", sym: "Bitway" },
  { addr: "0x5EB80C73C39F37E40d026184e24f4bCc917CfFff", sym: "哥斯拉" },
  { addr: "0xd9191C26045b88c6Fe66489Eb48fB396A4827777", sym: "骐骥" },
  { addr: "0xB8b65b02bC7587F4F7635774742361Db803E6066", sym: "OpenClaw" },
  { addr: "0x306D239D42381042D3a0705285923be7d2b1045C", sym: "zesty.bet" },
  { addr: "0x4A3e46FFa087Be7C90a9082357dA774d638BFBcB", sym: "龙虾" },
  { addr: "0x02578BaC89Cb36057Ee0B427C4469A680ecBDC40", sym: "Unitas" },
  { addr: "0xe4dD809eA09aB0894109D059D7491Eaa49d5b02e", sym: "BC.GAME" },
  { addr: "0x2165e95Ca6B755A30cF898A3dE093329F16A1b3b", sym: "皮皮虾" },
  { addr: "0x05cca08F1B0Fa640c2Ff8A8A812fFeA291fe7F1d", sym: "龙虾人生" },
  { addr: "0xFAfC333334A8D712A948B611540D0eE5E9635044", sym: "LP之王" },
  { addr: "0x3d93e4838109d8dfB5C7D8Cd5053FD888AEe0D09", sym: "赛博龙虾" },
  { addr: "0x99A9D13fa0f80CBda958270Ea5B0fF5368C7b901", sym: "共享龙虾" },
  { addr: "0x3b88c6C5ED2Cb655483144F34070cEDeC8a16683", sym: "Moltbook" },
  { addr: "0x6e43A3539DA705cB82FBa63E1f217AF6871F5555", sym: "🐎马上暴富" },
  // === Journal Tokens (non-4444 = haben PancakeSwap Pools) ===
  { addr: "0x37535ac1d53bcfe384bef25bec398ae6d6b07777", sym: "MEME7777" },
  { addr: "0xd23e3bd4f51dc68c08923f2a6714796aa408c6e6", sym: "TOKEN" },
  { addr: "0x984b0026287ceeafa08a1c29f3b4725e1abf0224", sym: "TOKEN2" },
  { addr: "0x7db3d87cba72ee1fb195a913f04b8437ad158958", sym: "TOKEN3" },
  { addr: "0x52f531a0a8f1751b256680ce3f6a656796306caa", sym: "TOKEN4" },
];

// ── ABIs ────────────────────────────────────────────────────────────────────────
const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
const SELL_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForETHSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
const SELL_TOKENS_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
const WITHDRAW_ABI = [{ inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" }];

// ── Helpers ─────────────────────────────────────────────────────────────────────
function log(msg: string) { console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getBnb(mcp: Client, address: string): Promise<number> {
  try {
    const raw = await executeTool(mcp, "get_native_balance", { address, network: "bsc" });
    return parseFloat(JSON.parse(raw).formatted ?? "0");
  } catch { return 0; }
}

async function getTokenBalance(mcp: Client, wallet: string, token: string): Promise<{ raw: bigint; formatted: string; symbol: string }> {
  try {
    const raw = await executeTool(mcp, "get_erc20_balance", { tokenAddress: token, address: wallet, network: "bsc" });
    const bd = JSON.parse(raw);
    return { raw: BigInt(bd.raw ?? bd.balance ?? "0"), formatted: bd.formatted ?? "0", symbol: bd.symbol ?? "?" };
  } catch { return { raw: 0n, formatted: "0", symbol: "?" }; }
}

// ── Token-Adressen sammeln: Journal + KNOWN_TOKENS + RPC Logs ───────────────────
function collectTokenAddresses(): string[] {
  const tokens = new Set<string>();

  // 1. Journal: alle BUY Adressen
  try {
    if (existsSync(JOURNAL)) {
      const journal = JSON.parse(readFileSync(JOURNAL, "utf-8"));
      for (const e of journal) {
        if (e.address && e.address.length === 42) tokens.add(e.address.toLowerCase());
      }
    }
  } catch {}

  // 2. Bekannte Tokens (von BscScan Screenshots + DexScreener verifiziert)
  for (const t of KNOWN_TOKENS) {
    tokens.add(t.addr.toLowerCase());
  }

  // 3. four.meme Tokens aus Journal (enden auf 4444)
  // Diese sind schon über Journal abgedeckt

  return Array.from(tokens);
}

// ── RPC: Transfer-Events der letzten Blöcke scannen ─────────────────────────────
async function scanRpcTransferLogs(walletAddress: string): Promise<string[]> {
  const tokens = new Set<string>();
  try {
    // ERC-20 Transfer Topic = keccak256("Transfer(address,address,uint256)")
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    // Wallet als Empfänger (padded to 32 bytes)
    const paddedAddr = "0x000000000000000000000000" + walletAddress.slice(2).toLowerCase();

    // Letzte ~50k Blöcke scannen (ca. 2 Tage)
    const blockRes = await fetch("https://bsc-dataseed1.binance.org/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    const blockData = await blockRes.json() as any;
    const currentBlock = parseInt(blockData.result, 16);
    const fromBlock = "0x" + Math.max(currentBlock - 50000, 0).toString(16);

    // Incoming transfers (wallet = Empfänger = topic2)
    const logRes = await fetch("https://bsc-dataseed1.binance.org/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "eth_getLogs", id: 2,
        params: [{ fromBlock, toBlock: "latest", topics: [transferTopic, null, paddedAddr] }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const logData = await logRes.json() as any;
    if (Array.isArray(logData.result)) {
      for (const entry of logData.result) {
        const addr = (entry.address ?? "").toLowerCase();
        if (addr && addr.length === 42) tokens.add(addr);
      }
    }
  } catch (e) {
    log(`  ⚠️ RPC scan: ${String(e).slice(0, 60)}`);
  }
  return Array.from(tokens);
}

// ── Sell Token → BNB (4 Routen, prüft BNB-Diff nach jedem Versuch) ──────────
async function sellToken(mcp: Client, wallet: string, tokenAddr: string, tokenRaw: string, symbol: string): Promise<number> {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const maxApprove = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

  // Approve für BEIDE Router
  try {
    await executeTool(mcp, "write_contract", {
      contractAddress: tokenAddr, abi: APPROVE_ABI,
      functionName: "approve", args: [ROUTER, maxApprove], network: "bsc",
    });
    await sleep(2000);
    await executeTool(mcp, "write_contract", {
      contractAddress: tokenAddr, abi: APPROVE_ABI,
      functionName: "approve", args: [SMART_ROUTER, maxApprove], network: "bsc",
    });
  } catch {}
  await sleep(3000);

  const preBnb = await getBnb(mcp, wallet);

  // Helper: WBNB unwrappen falls vorhanden
  async function tryUnwrapWbnb() {
    try {
      const wbal = await getTokenBalance(mcp, wallet, WBNB);
      if (wbal.raw > 0n) {
        await executeTool(mcp, "write_contract", {
          contractAddress: WBNB, abi: WITHDRAW_ABI,
          functionName: "withdraw", args: [wbal.raw.toString()], network: "bsc",
        });
        await sleep(2000);
      }
    } catch {}
  }

  // Helper: Prüfe ob Token tatsächlich weniger geworden ist (= Swap hat funktioniert)
  async function tokenWasSold(): Promise<boolean> {
    const newBal = await getTokenBalance(mcp, wallet, tokenAddr);
    return newBal.raw === 0n || newBal.raw.toString() !== tokenRaw;
  }

  // ── Route 1: V2 [TOKEN → WBNB] → ETH ──
  log(`     Route 1: TOKEN → WBNB (V2 direct)...`);
  try {
    const res = await executeTool(mcp, "write_contract", {
      contractAddress: ROUTER, abi: SELL_ABI,
      functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
      args: [tokenRaw, "1", [tokenAddr, WBNB], wallet, String(deadline)],
      network: "bsc",
    });
    if (!String(res).toLowerCase().includes("error") && await tokenWasSold()) {
      await tryUnwrapWbnb();
      await sleep(2000);
      const diff = (await getBnb(mcp, wallet)) - preBnb;
      if (diff > 0.00001) return diff;
      log(`     ⚠️ Route 1: Swap OK aber 0 BNB — probiere weiter`);
    }
  } catch {}

  // ── Route 2: V2 [TOKEN → USDT → WBNB] → ETH ──
  log(`     Route 2: TOKEN → USDT → WBNB (V2 hop)...`);
  await sleep(2000);
  try {
    const res = await executeTool(mcp, "write_contract", {
      contractAddress: ROUTER, abi: SELL_ABI,
      functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
      args: [tokenRaw, "1", [tokenAddr, USDT, WBNB], wallet, String(deadline)],
      network: "bsc",
    });
    if (!String(res).toLowerCase().includes("error") && await tokenWasSold()) {
      await tryUnwrapWbnb();
      await sleep(2000);
      const diff = (await getBnb(mcp, wallet)) - preBnb;
      if (diff > 0.00001) return diff;
      log(`     ⚠️ Route 2: Swap OK aber 0 BNB — probiere weiter`);
    }
  } catch {}

  // Tokens auffrischen (falls vorherige Route partial verkauft hat)
  const curBal = await getTokenBalance(mcp, wallet, tokenAddr);
  if (curBal.raw === 0n) {
    await tryUnwrapWbnb();
    await sleep(2000);
    return (await getBnb(mcp, wallet)) - preBnb;
  }
  const curRaw = curBal.raw.toString();

  // ── Route 3: V2 Token-to-Token [TOKEN → WBNB] + unwrap ──
  log(`     Route 3: TOKEN → WBNB (token swap)...`);
  await sleep(2000);
  try {
    const res = await executeTool(mcp, "write_contract", {
      contractAddress: ROUTER, abi: SELL_TOKENS_ABI,
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [curRaw, "1", [tokenAddr, WBNB], wallet, String(deadline)],
      network: "bsc",
    });
    if (!String(res).toLowerCase().includes("error") && await tokenWasSold()) {
      await tryUnwrapWbnb();
      await sleep(2000);
      const diff = (await getBnb(mcp, wallet)) - preBnb;
      if (diff > 0.00001) return diff;
      log(`     ⚠️ Route 3: Swap OK aber 0 BNB — probiere weiter`);
    }
  } catch {}

  // ── Route 4: V2 Token-to-Token [TOKEN → USDT → WBNB] + unwrap ──
  log(`     Route 4: TOKEN → USDT → WBNB (token hop)...`);
  await sleep(2000);
  try {
    const curBal2 = await getTokenBalance(mcp, wallet, tokenAddr);
    if (curBal2.raw === 0n) {
      await tryUnwrapWbnb();
      await sleep(2000);
      return (await getBnb(mcp, wallet)) - preBnb;
    }
    const res = await executeTool(mcp, "write_contract", {
      contractAddress: ROUTER, abi: SELL_TOKENS_ABI,
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [curBal2.raw.toString(), "1", [tokenAddr, USDT, WBNB], wallet, String(deadline)],
      network: "bsc",
    });
    if (!String(res).toLowerCase().includes("error") && await tokenWasSold()) {
      await tryUnwrapWbnb();
      await sleep(2000);
      const diff = (await getBnb(mcp, wallet)) - preBnb;
      if (diff > 0.00001) return diff;
    }
  } catch {}

  // Letzte Chance: WBNB das vielleicht noch rumliegt
  await tryUnwrapWbnb();
  await sleep(2000);
  const finalDiff = (await getBnb(mcp, wallet)) - preBnb;
  return finalDiff > 0.00001 ? finalDiff : finalDiff; // Auch negative Diffs zurückgeben (Gas-Verlust)
}

// ── WBNB → BNB unwrappen ───────────────────────────────────────────────────────
async function unwrapWBNB(mcp: Client, wallet: string): Promise<number> {
  const bal = await getTokenBalance(mcp, wallet, WBNB);
  if (bal.raw === 0n) return 0;
  log(`  🔄 WBNB: ${bal.formatted} → unwrap...`);
  try {
    await executeTool(mcp, "write_contract", {
      contractAddress: WBNB, abi: WITHDRAW_ABI,
      functionName: "withdraw", args: [bal.raw.toString()], network: "bsc",
    });
    await sleep(3000);
    log(`  ✅ WBNB unwrapped`);
    return parseFloat(bal.formatted);
  } catch (e) {
    log(`  ❌ WBNB unwrap failed: ${String(e).slice(0, 60)}`);
    return 0;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`
\x1b[33m╔══════════════════════════════════════════════════════════════════╗
║  \x1b[1m🚨 BOB RESCUE v2 — Stuck Tokens retten, BNB zurückholen\x1b[0m\x1b[33m       ║
║  Journal + bekannte Tokens + RPC Transfer-Logs                  ║
║  4 Sell-Routen: V2→WBNB, V2→USDT→WBNB, TokenSwap, TokenHop    ║
╚══════════════════════════════════════════════════════════════════╝\x1b[0m
`);

  interface Wallet { name: string; address: string; privateKey: string; }
  const wallets: Wallet[] = JSON.parse(readFileSync("data/contest-wallets.json", "utf-8"));

  // Token-Adressen aus Journal + bekannte Tokens sammeln
  const baseTokens = collectTokenAddresses();
  log(`📋 ${baseTokens.length} Token-Adressen aus Journal + bekannte Tokens`);

  const summary: { bot: string; wallet: string; tokensFound: number; tokensSold: number; bnbRecovered: number; finalBnb: number }[] = [];

  for (const w of wallets) {
    const botName = BOT_NAMES[w.name] ?? w.name;
    const line = "═".repeat(60);
    console.log(`\n\x1b[36m${line}\x1b[0m`);
    log(`🤖 ${botName} (${w.name}) — ${w.address}`);
    console.log(`\x1b[36m${line}\x1b[0m`);

    let mcp;
    try {
      mcp = await connectBNBChain(w.privateKey);
    } catch (e) {
      log(`❌ MCP Connect failed: ${String(e).slice(0, 60)}`);
      continue;
    }

    const startBnb = await getBnb(mcp.client, w.address);
    log(`💰 BNB vorher: ${startBnb.toFixed(6)} BNB`);

    // 1. RPC Transfer-Logs scannen (letzte ~2 Tage on-chain)
    log(`🔍 Scanne RPC Transfer-Logs...`);
    const rpcTokens = await scanRpcTransferLogs(w.address);
    log(`📡 ${rpcTokens.length} Tokens via RPC gefunden`);

    // Merge: Journal + KNOWN + RPC = alle Tokens
    const allTokens = new Set<string>();
    for (const t of baseTokens) allTokens.add(t);
    for (const t of rpcTokens) allTokens.add(t);
    log(`📊 ${allTokens.size} unique Token-Adressen total`);

    let tokensFound = 0;
    let tokensSold = 0;
    let bnbRecovered = 0;

    // 2. Jeden Token prüfen + verkaufen
    for (const tokenAddr of Array.from(allTokens)) {
      if (SKIP_TOKENS.has(tokenAddr)) continue;

      const bal = await getTokenBalance(mcp.client, w.address, tokenAddr);
      if (bal.raw === 0n) continue;

      tokensFound++;
      const knownName = KNOWN_TOKENS.find(t => t.addr.toLowerCase() === tokenAddr)?.sym;
      const displayName = bal.symbol !== "?" ? bal.symbol : knownName ?? tokenAddr.slice(0, 10);
      log(`  🪙 ${displayName} | ${bal.formatted} | ${tokenAddr}`);

      // Gas-Check
      const curBnb = await getBnb(mcp.client, w.address);
      if (curBnb < 0.0005) {
        log(`  ⛔ Zu wenig BNB für Gas (${curBnb.toFixed(6)}) — stoppe`);
        break;
      }

      try {
        const received = await sellToken(mcp.client, w.address, tokenAddr, bal.raw.toString(), displayName);
        if (received > 0.00001) {
          log(`  \x1b[32m✅ +${received.toFixed(6)} BNB\x1b[0m`);
          bnbRecovered += received;
          tokensSold++;
        } else if (received < -0.0001) {
          log(`  ⚠️ Gas verloren: ${received.toFixed(6)} BNB (Token wertlos)`);
        } else {
          log(`  ❌ Nicht sellbar — alle 4 Routen gescheitert`);
        }
      } catch (e) {
        log(`  ❌ Sell error: ${String(e).slice(0, 60)}`);
      }

      await sleep(1000);
    }

    // 3. WBNB unwrappen
    const unwrapped = await unwrapWBNB(mcp.client, w.address);
    if (unwrapped > 0) bnbRecovered += unwrapped;

    // 4. Finale Balance
    const finalBnb = await getBnb(mcp.client, w.address);
    const diff = finalBnb - startBnb;
    const diffColor = diff >= 0 ? "\x1b[32m+" : "\x1b[31m";
    log(`\n📊 ERGEBNIS ${botName}:`);
    log(`   Tokens gefunden: ${tokensFound} | verkauft: ${tokensSold}`);
    log(`   BNB: ${startBnb.toFixed(6)} → ${finalBnb.toFixed(6)} (${diffColor}${diff.toFixed(6)}\x1b[0m)`);

    summary.push({ bot: botName, wallet: w.address, tokensFound, tokensSold, bnbRecovered, finalBnb });

    try { await (mcp.client as any)?.close?.(); } catch {}
  }

  // ── ZUSAMMENFASSUNG ──
  console.log(`\n\x1b[33m${"═".repeat(64)}\x1b[0m`);
  console.log(`\x1b[1m  🏁 RESCUE COMPLETE\x1b[0m\n`);

  let totalBnb = 0;
  let totalRecovered = 0;
  let totalSold = 0;
  let totalFound = 0;
  for (const s of summary) {
    const bnbColor = s.finalBnb >= 0.01 ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${s.bot.padEnd(8)} | ${bnbColor}${s.finalBnb.toFixed(6)} BNB\x1b[0m | ${s.tokensFound} found | ${s.tokensSold} sold | +${s.bnbRecovered.toFixed(6)}`);
    totalBnb += s.finalBnb;
    totalRecovered += s.bnbRecovered;
    totalSold += s.tokensSold;
    totalFound += s.tokensFound;
  }
  console.log(`  ${"─".repeat(60)}`);
  console.log(`  TOTAL    | \x1b[1m${totalBnb.toFixed(6)} BNB\x1b[0m | ${totalFound} found | ${totalSold} sold | +${totalRecovered.toFixed(6)}`);
  console.log(`\n\x1b[33m${"═".repeat(64)}\x1b[0m\n`);

  process.exit(0);
}

main().catch(e => {
  console.error("❌ Fehler:", e);
  process.exit(1);
});
