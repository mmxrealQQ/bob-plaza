/**
 * RESCUE WBNB — WBNB in SCOUT Wallet → $BOB → Swarm Wallet
 * Lädt erst Gas von PRIVATE_KEY nach falls SCOUT zu wenig BNB hat
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const PANCAKE      = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB         = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BOB_TOKEN    = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const SCOUT_ADDR   = "0x93B4150114fd96377fEaB30Fd4597405b9f0CE33";

const APPROVE_ABI  = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
const SWAP_ABI     = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
const TRANSFER_ABI = [{ inputs: [{ internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "transfer", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];

function log(msg: string) { console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`); }
function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function parseBalance(raw: string): { formatted: string; wei: bigint } {
  try {
    const p = JSON.parse(raw);
    // Log full response so we can see actual field names
    log(`  Raw response fields: ${Object.keys(p).join(", ")}`);
    const wei = BigInt(p.raw ?? p.balance ?? "0");
    return { formatted: p.formatted ?? "?", wei };
  } catch (e) {
    log(`  Parse error: ${e} | raw: ${raw.slice(0, 100)}`);
    return { formatted: "0", wei: 0n };
  }
}

async function main() {
  const wallets: { name: string; address: string; privateKey: string }[] =
    JSON.parse(readFileSync("contest-wallets.json", "utf-8"));
  const scout = wallets.find(w => w.name.toUpperCase() === "SCOUT");
  if (!scout) { console.error("SCOUT nicht gefunden"); process.exit(1); }

  // ── Schritt 1: Gas nachladen wenn SCOUT zu wenig BNB hat ─────────────────────
  if (process.env.PRIVATE_KEY) {
    log("Prüfe SCOUT BNB für Gas...");
    const mainConn = await connectBNBChain(process.env.PRIVATE_KEY);
    const bnbRaw = await executeTool(mainConn.client, "get_native_balance", { address: SCOUT_ADDR, network: "bsc" });
    const bnb = parseFloat(JSON.parse(bnbRaw).formatted ?? "0");
    log(`SCOUT BNB: ${bnb.toFixed(8)}`);
    if (bnb < 0.001) {
      log("Zu wenig Gas — sende 0.002 BNB aus Hauptwallet...");
      const res = await executeTool(mainConn.client, "transfer_native_token", {
        toAddress: SCOUT_ADDR, amount: "0.002", network: "bsc",
      });
      log(`✅ Gas gesendet: ${String(res).slice(0, 80)}`);
      await wait(5000);
    }
    try { await (mainConn.client as any).close?.(); } catch { /**/ }
  }

  // ── Schritt 2: Mit SCOUT Wallet verbinden ────────────────────────────────────
  const { client } = await connectBNBChain(scout.privateKey);
  log("✓ SCOUT MCP connected");

  // ── Schritt 3: WBNB via transfer_erc20 MCP Tool (nicht write_contract) ────────
  log(`transfer_erc20: 0.003 WBNB → Swarm Wallet...`);
  try {
    const txRes = await executeTool(client, "transfer_erc20", {
      tokenAddress: WBNB, toAddress: SWARM_WALLET, amount: "0.003", network: "bsc",
    });
    log(`✅ WBNB transferiert: ${String(txRes).slice(0, 100)}`);
  } catch (e) {
    log(`⚠ transfer_erc20 fehlgeschlagen: ${e}`);
    // Fallback: WBNB unwrappen via withdraw()
    log(`Fallback: WBNB unwrappen (withdraw 3000000000000000 wei)...`);
    try {
      const unwrapRes = await executeTool(client, "write_contract", {
        contractAddress: WBNB, abi: [{ inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" }],
        functionName: "withdraw", args: ["3000000000000000"], network: "bsc",
      });
      log(`✅ Unwrapped: ${String(unwrapRes).slice(0, 100)}`);
    } catch (e2) { log(`❌ Auch unwrap fehlgeschlagen: ${e2}`); }
  }
  await wait(4000);

  // ── Schritt 4: Restliches BNB senden ─────────────────────────────────────────
  const bnbRaw = await executeTool(client, "get_native_balance", { address: SCOUT_ADDR, network: "bsc" });
  const bnbLeft = parseFloat(JSON.parse(bnbRaw).formatted ?? "0");
  log(`BNB übrig: ${bnbLeft.toFixed(8)}`);
  const sendBnb = bnbLeft - 0.00015;
  if (sendBnb > 0.0001) {
    const bnbRes = await executeTool(client, "transfer_native_token", {
      toAddress: SWARM_WALLET, amount: sendBnb.toFixed(8), network: "bsc",
    });
    log(`✅ BNB gesendet: ${String(bnbRes).slice(0, 80)}`);
  }

  log("\n🏁 Fertig.");
  try { await (client as any).close?.(); } catch { /**/ }
}

main().catch(e => { console.error("❌", e); process.exit(1); });
