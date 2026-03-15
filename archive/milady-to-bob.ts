/**
 * MILADY → $BOB Conversion
 * Nutzt swapExactTokensForTokensSupportingFeeOnTransferTokens (für Meme-Token mit Transfer-Fee)
 * Path: MILADY → WBNB → $BOB
 * Danach: $BOB an OWNER_WALLET senden
 */

import "dotenv/config";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const BOB_WALLET   = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const OWNER_WALLET = "0x5787F2Ac0e140e99Ec73546d1c51092CeF3cE546";
const PANCAKE      = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB         = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const MILADY_ADDR  = "0xc20E45E49e0E79f0fC81E71F05fD2772d6587777";
const BOB_TOKEN    = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";

const APPROVE_ABI = [{
  inputs: [
    { internalType: "address", name: "spender", type: "address" },
    { internalType: "uint256", name: "amount", type: "uint256" },
  ],
  name: "approve",
  outputs: [{ internalType: "bool", name: "", type: "bool" }],
  stateMutability: "nonpayable", type: "function",
}];

// Fee-on-transfer kompatibel — für Meme-Token
const SWAP_FOT_ABI = [{
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

const TRANSFER_ABI = [{
  inputs: [
    { internalType: "address", name: "recipient", type: "address" },
    { internalType: "uint256", name: "amount", type: "uint256" },
  ],
  name: "transfer",
  outputs: [{ internalType: "bool", name: "", type: "bool" }],
  stateMutability: "nonpayable", type: "function",
}];

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

async function parseRaw(raw: string): Promise<string> {
  try {
    return JSON.parse(raw).raw ?? "0";
  } catch {
    return raw.match(/"raw"\s*:\s*"(\d+)"/)?.[1] ?? "0";
  }
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error("❌ PRIVATE_KEY fehlt in .env"); process.exit(1); }

  log("🔌 Verbinde mit BNB Chain MCP...");
  const { client } = await connectBNBChain(privateKey);
  log("✓ Verbunden");

  // ── 1. MILADY Balance ─────────────────────────────────────────────────────────
  log("\n🔍 Prüfe MILADY Balance...");
  const miladyRaw = await executeTool(client, "get_erc20_balance", {
    tokenAddress: MILADY_ADDR,
    address: BOB_WALLET,
    network: "bsc",
  });
  const miladyBal = BigInt(await parseRaw(miladyRaw));

  if (miladyBal === 0n) {
    log("❌ Keine MILADY in BOB's Wallet.");
    await client.close();
    return;
  }
  log(`   ↳ MILADY: ${miladyBal.toString()} wei`);

  // ── 2. BNB für Gas checken ────────────────────────────────────────────────────
  const bnbRaw = await executeTool(client, "get_native_balance", { address: BOB_WALLET, network: "bsc" });
  log(`   ↳ BNB für Gas: ${JSON.parse(bnbRaw).formatted} BNB`);

  // ── 3. Approve ────────────────────────────────────────────────────────────────
  log("\n✅ Approve MILADY für PancakeSwap...");
  const approveResult = await executeTool(client, "write_contract", {
    contractAddress: MILADY_ADDR,
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [PANCAKE, miladyBal.toString()],
    network: "bsc",
  });
  log(`   ↳ ${approveResult.slice(0, 80)}`);

  await new Promise(r => setTimeout(r, 4000));

  // ── 4. Swap MILADY → WBNB → $BOB (FeeOnTransfer) ─────────────────────────────
  const deadline = Math.floor(Date.now() / 1000) + 300;
  log("\n🔄 Swap MILADY → WBNB → $BOB (FeeOnTransfer)...");
  const swapResult = await executeTool(client, "write_contract", {
    contractAddress: PANCAKE,
    abi: SWAP_FOT_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [
      miladyBal.toString(),
      "1",
      [MILADY_ADDR, WBNB, BOB_TOKEN],
      BOB_WALLET,
      deadline.toString(),
    ],
    network: "bsc",
  });
  log(`   ↳ ${swapResult.slice(0, 150)}`);

  if (swapResult.includes("Error") || swapResult.includes("revert")) {
    log("❌ Swap fehlgeschlagen. MILADY bleibt in BOB's Wallet.");
    await client.close();
    return;
  }

  await new Promise(r => setTimeout(r, 5000));

  // ── 5. $BOB Balance lesen ─────────────────────────────────────────────────────
  log("\n🔍 $BOB Balance nach Swap...");
  const bobRaw = await executeTool(client, "get_erc20_balance", {
    tokenAddress: BOB_TOKEN,
    address: BOB_WALLET,
    network: "bsc",
  });
  const bobBal = BigInt(await parseRaw(bobRaw));
  log(`   ↳ $BOB: ${bobBal.toString()} wei`);

  if (bobBal === 0n) {
    log("⚠️  $BOB Balance ist 0 — Swap hat nichts gebracht.");
    await client.close();
    return;
  }

  // ── 6. $BOB an OWNER_WALLET senden ───────────────────────────────────────────
  log(`\n📤 Sende ${bobBal.toString()} $BOB an ${OWNER_WALLET}...`);
  const transferResult = await executeTool(client, "write_contract", {
    contractAddress: BOB_TOKEN,
    abi: TRANSFER_ABI,
    functionName: "transfer",
    args: [OWNER_WALLET, bobBal.toString()],
    network: "bsc",
  });
  log(`✅ Transfer: ${transferResult}`);

  log("\n🏁 DONE — MILADY → $BOB → deine Wallet.");
  await client.close();
  process.exit(0);
}

main().catch(e => {
  console.error("❌ Fehler:", e);
  process.exit(1);
});
