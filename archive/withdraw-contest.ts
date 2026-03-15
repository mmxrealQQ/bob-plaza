/**
 * WITHDRAW CONTEST — Alle 4 Agent-Wallets liquidieren
 * Verkauft alle Token → BNB, schickt alles ans SWARM_WALLET
 *
 * Wallets: SCOUT, DATABASE, PUSHER, ORACLE (aus contest-wallets.json)
 * Ziel: 0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f (Swarm Wallet)
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const PANCAKE      = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB         = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const GAS_RESERVE  = 0.0002; // minimaler Gas-Reserve für den Transfer-TX (~21000 gas)

// Token-Adressen die verkauft werden
const SELL_TOKENS = [
  { symbol: "FOM",     address: "0x3e17ee3b1895dd1a7cf993a89769c5e029584444" },
  { symbol: "Lobster", address: "0xeccbb861c0dda7efd964010085488b69317e4444" },
  { symbol: "$BOB",    address: "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e" },
  { symbol: "WBNB",    address: WBNB },
];

// PancakeSwap ABIs
const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
const SWAP_FOT_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForETHSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
const UNWRAP_ABI = [{ inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" }];

interface ContestWallet { name: string; address: string; privateKey: string; }

function log(prefix: string, msg: string) {
  console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${prefix} | ${msg}`);
}

async function wait(ms: number) { await new Promise(r => setTimeout(r, ms)); }

async function getRawBalance(client: Awaited<ReturnType<typeof connectBNBChain>>["client"], tokenAddress: string, walletAddress: string): Promise<bigint> {
  try {
    const raw = await executeTool(client, "get_erc20_balance", { tokenAddress, address: walletAddress, network: "bsc" });
    const p = JSON.parse(raw);
    return BigInt(p.raw ?? p.balance ?? "0");
  } catch { return 0n; }
}

async function getFormattedBnb(client: Awaited<ReturnType<typeof connectBNBChain>>["client"], walletAddress: string): Promise<number> {
  try {
    const raw = await executeTool(client, "get_native_balance", { address: walletAddress, network: "bsc" });
    const p = JSON.parse(raw);
    return parseFloat(p.formatted ?? "0");
  } catch { return 0; }
}

async function drainWallet(wallet: ContestWallet): Promise<{ startBnb: number; endBnb: number; sent: number }> {
  const prefix = wallet.name;
  log(prefix, `▶ Starte drain von ${wallet.address}`);

  let client: Awaited<ReturnType<typeof connectBNBChain>>["client"];
  try {
    const conn = await connectBNBChain(wallet.privateKey);
    client = conn.client;
  } catch (e) {
    log(prefix, `❌ MCP connect failed: ${e}`);
    return { startBnb: 0, endBnb: 0, sent: 0 };
  }

  const startBnb = await getFormattedBnb(client, wallet.address);
  log(prefix, `💰 Start BNB: ${startBnb.toFixed(6)}`);

  // ── Sell all tokens ──────────────────────────────────────────────────────────
  for (const token of SELL_TOKENS) {
    const bal = await getRawBalance(client, token.address, wallet.address);
    if (bal === 0n) {
      log(prefix, `   ${token.symbol}: 0 — skip`);
      continue;
    }
    log(prefix, `   ${token.symbol}: ${bal} raw`);

    // WBNB: unwrap first, fallback → transfer ERC-20 directly to swarm wallet
    if (token.address.toLowerCase() === WBNB.toLowerCase()) {
      try {
        const res = await executeTool(client, "write_contract", {
          contractAddress: WBNB, abi: UNWRAP_ABI,
          functionName: "withdraw", args: [bal.toString()], network: "bsc",
        });
        log(prefix, `   ✅ WBNB unwrapped | ${String(res).slice(0, 60)}`);
        await wait(4000);
      } catch (e) {
        log(prefix, `   ⚠ WBNB unwrap failed (${e}) — transferring WBNB direkt ans Swarm Wallet...`);
        try {
          const res2 = await executeTool(client, "transfer_erc20", {
            tokenAddress: WBNB, toAddress: SWARM_WALLET, amount: bal.toString(), network: "bsc",
          });
          log(prefix, `   ✅ WBNB transferiert | ${String(res2).slice(0, 60)}`);
          await wait(4000);
        } catch (e2) { log(prefix, `   ❌ WBNB transfer auch fehlgeschlagen: ${e2}`); }
      }
      continue;
    }

    // Approve
    try {
      await executeTool(client, "write_contract", {
        contractAddress: token.address, abi: APPROVE_ABI,
        functionName: "approve", args: [PANCAKE, bal.toString()], network: "bsc",
      });
      await wait(3000);
    } catch (e) { log(prefix, `   ⚠ Approve failed for ${token.symbol}: ${e}`); continue; }

    // Swap → BNB (supports fee-on-transfer tokens)
    const deadline = Math.floor(Date.now() / 1000) + 300;
    try {
      const res = await executeTool(client, "write_contract", {
        contractAddress: PANCAKE, abi: SWAP_FOT_ABI,
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [bal.toString(), "1", [token.address, WBNB], wallet.address, String(deadline)],
        network: "bsc",
      });
      log(prefix, `   ✅ ${token.symbol} sold → BNB | ${String(res).slice(0, 60)}`);
      await wait(4000);
    } catch (e) { log(prefix, `   ⚠ Sell ${token.symbol} failed: ${e}`); }
  }

  // ── Send BNB to SWARM_WALLET ─────────────────────────────────────────────────
  await wait(4000);
  const finalBnb = await getFormattedBnb(client, wallet.address);
  log(prefix, `💰 Final BNB: ${finalBnb.toFixed(6)}`);

  const sendAmount = finalBnb - GAS_RESERVE;
  if (sendAmount <= 0.0001) {
    log(prefix, `⚠ Zu wenig BNB nach Gas-Reserve (${finalBnb.toFixed(6)}) — skip transfer`);
    try { await (client as any).close?.(); } catch { /* */ }
    return { startBnb, endBnb: finalBnb, sent: 0 };
  }

  log(prefix, `📤 Sende ${sendAmount.toFixed(6)} BNB → SWARM_WALLET...`);
  try {
    const res = await executeTool(client, "transfer_native_token", {
      toAddress: SWARM_WALLET, amount: sendAmount.toFixed(8), network: "bsc",
    });
    log(prefix, `✅ Gesendet | ${String(res).slice(0, 80)}`);
  } catch (e) { log(prefix, `❌ Transfer failed: ${e}`); }

  try { await (client as any).close?.(); } catch { /* */ }
  return { startBnb, endBnb: finalBnb, sent: sendAmount };
}

async function main() {
  let wallets: ContestWallet[];
  try {
    wallets = JSON.parse(readFileSync("contest-wallets.json", "utf-8"));
  } catch (e) {
    console.error("❌ contest-wallets.json nicht gefunden:", e);
    process.exit(1);
  }

  console.log(`
╔══════════════════════════════════════════════════════╗
║   BOB SWARM — CONTEST WITHDRAW                       ║
║   Liquidiert alle 4 Agent-Wallets → Swarm Wallet     ║
╚══════════════════════════════════════════════════════╝
`);

  const results: { name: string; startBnb: number; sent: number }[] = [];

  for (const wallet of wallets) {
    const { startBnb, sent } = await drainWallet(wallet);
    results.push({ name: wallet.name, startBnb, sent });
    await wait(5000); // zwischen Wallets warten
  }

  // ── Bilanz ────────────────────────────────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════════════╗
║   BILANZ                                             ║
╠══════════════════════════════════════════════════════╣`);
  let totalSent = 0;
  for (const r of results) {
    console.log(`║  ${r.name.padEnd(10)} Start: ${r.startBnb.toFixed(4)} BNB  Gesendet: ${r.sent.toFixed(4)} BNB`);
    totalSent += r.sent;
  }
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  TOTAL GESENDET: ${totalSent.toFixed(6)} BNB → Swarm Wallet`);
  console.log(`║  Swarm Wallet: ${SWARM_WALLET}`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
}

main().catch(e => { console.error("❌ Fehler:", e); process.exit(1); });
