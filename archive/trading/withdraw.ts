/**
 * BOB WITHDRAW — ALLES liquidieren + BNB an Owner senden
 *
 * Phase 1: Alle 4 Bot-Wallets → Swarm Wallet (tokens verkaufen + BNB senden)
 * Phase 2: Swarm Wallet → Owner Wallet (tokens verkaufen + BNB senden)
 *
 * Ziel: ALLE Wallets auf exakt 0 BNB
 */

import "dotenv/config";
import { connectBNBChain, executeTool } from "./mcp-client.js";
import { readFileSync } from "fs";
import { ethers } from "ethers";

const SWARM_WALLET  = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const OWNER_WALLET  = "0x5787F2Ac0e140e99Ec73546d1c51092CeF3cE546";
const PANCAKE_V2    = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB          = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BOB_TOKEN     = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const BSC_RPC       = "https://bsc-dataseed.binance.org";

// Tokens die verkauft werden sollen
const SELL_TOKENS = [
  { symbol: "$BOB",    address: BOB_TOKEN },
  { symbol: "MILADY",  address: "0xc20E45E49e0E79f0fC81E71F05fD2772d6587777" },
  { symbol: "CAKE",    address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
  { symbol: "BTCB",    address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
  { symbol: "BSC-USD", address: "0x55d398326f99059fF775485246999027B3197955" },
  { symbol: "WBNB",    address: WBNB },
];

interface Wallet { name: string; address: string; privateKey: string; }

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

// supportingFeeOnTransferTokens version — für Honeypot-Tokens die Tax haben
const SWAP_FEE_ABI = [{
  inputs: [
    { internalType: "uint256", name: "amountIn", type: "uint256" },
    { internalType: "uint256", name: "amountOutMin", type: "uint256" },
    { internalType: "address[]", name: "path", type: "address[]" },
    { internalType: "address", name: "to", type: "address" },
    { internalType: "uint256", name: "deadline", type: "uint256" },
  ],
  name: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  outputs: [],
  stateMutability: "nonpayable", type: "function",
}];

const APPROVE_ABI = [{
  inputs: [
    { internalType: "address", name: "spender", type: "address" },
    { internalType: "uint256", name: "amount", type: "uint256" },
  ],
  name: "approve",
  outputs: [{ internalType: "bool", name: "", type: "bool" }],
  stateMutability: "nonpayable", type: "function",
}];

const UNWRAP_ABI = [{
  inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }],
  name: "withdraw", outputs: [],
  stateMutability: "nonpayable", type: "function",
}];

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

function parseBalance(raw: string): bigint {
  try {
    const parsed = JSON.parse(raw);
    return BigInt(parsed.raw ?? parsed.formatted?.replace(/[^0-9]/g, "") ?? "0");
  } catch {
    const match = raw.match(/"raw"\s*:\s*"(\d+)"/);
    return BigInt(match ? match[1] : "0");
  }
}

function parseBnbFormatted(raw: string): number {
  try {
    const parsed = JSON.parse(raw);
    return parseFloat(parsed.formatted ?? "0");
  } catch {
    const match = raw.match(/"formatted"\s*:\s*"([^"]+)"/);
    return parseFloat(match ? match[1] : "0");
  }
}

/** Sell all tokens in a wallet, unwrap WBNB, return total BNB recovered */
async function sellAllTokens(client: any, walletAddr: string, label: string): Promise<void> {
  for (const token of SELL_TOKENS) {
    try {
      const balRaw = await executeTool(client, "get_erc20_balance", {
        tokenAddress: token.address,
        address: walletAddr,
        network: "bsc",
      });
      const bal = parseBalance(balRaw);
      if (bal === 0n) continue;

      log(`   ${label} ${token.symbol}: ${bal.toString()}`);

      // WBNB: unwrap
      if (token.address.toLowerCase() === WBNB.toLowerCase()) {
        log(`   🔄 Unwrap WBNB → BNB...`);
        try {
          await executeTool(client, "write_contract", {
            contractAddress: WBNB, abi: UNWRAP_ABI,
            functionName: "withdraw", args: [bal.toString()], network: "bsc",
          });
          log(`   ✅ Unwrapped`);
        } catch (e: any) {
          log(`   ❌ Unwrap failed: ${e.message?.slice(0, 80)}`);
        }
        continue;
      }

      // Approve
      log(`   ✅ Approve ${token.symbol}...`);
      await executeTool(client, "write_contract", {
        contractAddress: token.address, abi: APPROVE_ABI,
        functionName: "approve", args: [PANCAKE_V2, bal.toString()], network: "bsc",
      });
      await new Promise(r => setTimeout(r, 3000));

      // Swap → WBNB (try normal first, then fee-on-transfer)
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const swapArgs = [bal.toString(), "1", [token.address, WBNB], walletAddr, deadline.toString()];

      log(`   🔄 Swap ${token.symbol} → WBNB...`);
      try {
        await executeTool(client, "write_contract", {
          contractAddress: PANCAKE_V2, abi: SWAP_ABI,
          functionName: "swapExactTokensForTokens", args: swapArgs, network: "bsc",
        });
        log(`   ✅ Swapped`);
      } catch {
        log(`   ⚠️  Normal swap failed, trying fee-on-transfer...`);
        try {
          await executeTool(client, "write_contract", {
            contractAddress: PANCAKE_V2, abi: SWAP_FEE_ABI,
            functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
            args: swapArgs, network: "bsc",
          });
          log(`   ✅ Swapped (fee-on-transfer)`);
        } catch (e2: any) {
          log(`   ❌ Swap failed komplett — Token vermutlich unsellable: ${e2.message?.slice(0, 80)}`);
          continue;
        }
      }

      // Unwrap resulting WBNB
      await new Promise(r => setTimeout(r, 3000));
      const wbnbRaw = await executeTool(client, "get_erc20_balance", {
        tokenAddress: WBNB, address: walletAddr, network: "bsc",
      });
      const wbnbBal = parseBalance(wbnbRaw);
      if (wbnbBal > 0n) {
        await executeTool(client, "write_contract", {
          contractAddress: WBNB, abi: UNWRAP_ABI,
          functionName: "withdraw", args: [wbnbBal.toString()], network: "bsc",
        });
        log(`   ✅ Unwrapped WBNB`);
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (e: any) {
      log(`   ❌ ${token.symbol} error: ${e.message?.slice(0, 100)}`);
    }
  }
}

/** Send ALL BNB from wallet to target — leaves exactly 0 (calculates gas) */
async function sendAllBnb(privateKey: string, fromAddr: string, toAddr: string, label: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(fromAddr);
  if (balance === 0n) {
    log(`   ${label}: 0 BNB — nichts zu senden`);
    return 0;
  }

  const gasPrice = (await provider.getFeeData()).gasPrice ?? 3000000000n;
  const gasCost = 21000n * gasPrice;
  const sendAmount = balance - gasCost;

  if (sendAmount <= 0n) {
    log(`   ${label}: ${ethers.formatEther(balance)} BNB — zu wenig für Gas`);
    return 0;
  }

  log(`   📤 ${label}: ${ethers.formatEther(balance)} BNB → ${ethers.formatEther(sendAmount)} BNB senden (Gas: ${ethers.formatEther(gasCost)})`);

  const tx = await wallet.sendTransaction({
    to: toAddr,
    value: sendAmount,
    gasLimit: 21000n,
    gasPrice,
  });
  await tx.wait();
  log(`   ✅ Sent! TX: ${tx.hash}`);

  // Check remaining
  const remaining = await provider.getBalance(fromAddr);
  log(`   💰 Remaining: ${ethers.formatEther(remaining)} BNB`);

  return parseFloat(ethers.formatEther(sendAmount));
}

async function main() {
  // Load wallets
  const rawWallets: Wallet[] = JSON.parse(readFileSync("data/contest-wallets.json", "utf-8"));
  const walletMap: Record<string, Wallet> = {};
  for (const w of rawWallets) walletMap[w.name] = w;

  const swarmKey = process.env.PRIVATE_KEY;
  if (!swarmKey) { console.error("❌ PRIVATE_KEY fehlt in .env"); process.exit(1); }

  const bots = [
    { label: "BLAZE", wallet: walletMap["SCOUT"] },
    { label: "BRAIN", wallet: walletMap["DATABASE"] },
    { label: "BOOST", wallet: walletMap["PUSHER"] },
    { label: "BANK",  wallet: walletMap["ORACLE"] },
  ];

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   BOB WITHDRAW — ALLES RAUS                      ║");
  console.log("║   Phase 1: Bot-Wallets → Swarm                   ║");
  console.log("║   Phase 2: Swarm → Owner                         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Phase 1: Jeden Bot leeren → Swarm ──────────────────────────────
  log("═══ PHASE 1: Bot-Wallets → Swarm ═══");

  for (const bot of bots) {
    log(`\n🤖 ${bot.label} (${bot.wallet.address})`);

    // Sell tokens via MCP (needs bot's private key)
    try {
      const { client } = await connectBNBChain(bot.wallet.privateKey);
      await sellAllTokens(client, bot.wallet.address, bot.label);
      await client.close();
    } catch (e: any) {
      log(`   ⚠️  MCP error (tokens): ${e.message?.slice(0, 80)}`);
    }

    // Send all BNB → Swarm (via ethers, exact calculation)
    await new Promise(r => setTimeout(r, 2000));
    await sendAllBnb(bot.wallet.privateKey, bot.wallet.address, SWARM_WALLET, bot.label);
  }

  // ── Phase 2: Swarm leeren → Owner ──────────────────────────────────
  log("\n═══ PHASE 2: Swarm → Owner ═══");
  log(`\n🏦 SWARM (${SWARM_WALLET})`);

  try {
    const { client } = await connectBNBChain(swarmKey);
    await sellAllTokens(client, SWARM_WALLET, "SWARM");
    await client.close();
  } catch (e: any) {
    log(`   ⚠️  MCP error (tokens): ${e.message?.slice(0, 80)}`);
  }

  await new Promise(r => setTimeout(r, 3000));
  const sent = await sendAllBnb(swarmKey, SWARM_WALLET, OWNER_WALLET, "SWARM→OWNER");

  // ── Final check ────────────────────────────────────────────────────
  log("\n═══ FINAL CHECK ═══");
  const provider = new ethers.JsonRpcProvider(BSC_RPC);

  for (const bot of bots) {
    const bal = await provider.getBalance(bot.wallet.address);
    const status = bal === 0n ? "✅ 0" : `⚠️  ${ethers.formatEther(bal)}`;
    log(`   ${bot.label}: ${status} BNB`);
  }
  const swarmBal = await provider.getBalance(SWARM_WALLET);
  log(`   SWARM: ${swarmBal === 0n ? "✅ 0" : `⚠️  ${ethers.formatEther(swarmBal)}`} BNB`);

  const ownerBal = await provider.getBalance(OWNER_WALLET);
  log(`   OWNER: ${ethers.formatEther(ownerBal)} BNB`);

  log(`\n🏁 DONE — ${sent.toFixed(6)} BNB an dein Wallet gesendet.`);
  log("Falls noch Reste: nochmal 'npm run withdraw' laufen lassen.");
  process.exit(0);
}

main().catch(e => {
  console.error("❌ Fehler:", e);
  process.exit(1);
});
