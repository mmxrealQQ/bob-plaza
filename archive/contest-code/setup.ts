/**
 * CONTEST SETUP — Funded 4 Agent Wallets
 * npm run contest-setup
 */

import "dotenv/config";
import { ethers } from "ethers";
import { writeFileSync, existsSync, readFileSync } from "fs";

const BSC_RPCS = [
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
];
const WALLETS_FILE  = "contest-wallets.json";
const BNB_PER_AGENT = 0.019; // ~$12 at $645/BNB
const AGENT_NAMES   = ["SCOUT", "DATABASE", "PUSHER", "ORACLE"];

function getProvider() {
  return new ethers.JsonRpcProvider(BSC_RPCS[Math.floor(Math.random() * BSC_RPCS.length)]);
}

async function sendBNB(from: ethers.Wallet, to: string, amount: number): Promise<string> {
  const provider = getProvider();
  const signer = from.connect(provider);
  const value = ethers.parseEther(amount.toFixed(6));
  const tx = await signer.sendTransaction({ to, value, gasLimit: 21000n });
  console.log(`  TX: ${tx.hash}`);
  // Wait max 30s for confirmation
  const receipt = await Promise.race([
    tx.wait(),
    new Promise<null>(r => setTimeout(() => r(null), 30000))
  ]);
  if (!receipt) console.log(`  (timeout — tx likely confirmed anyway)`);
  return tx.hash;
}

async function getBalance(address: string): Promise<number> {
  for (const rpc of BSC_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      const bal = await p.getBalance(address);
      return parseFloat(ethers.formatEther(bal));
    } catch {}
  }
  return 0;
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY fehlt in .env");
    process.exit(1);
  }

  console.log("\n\x1b[36m╔══════════════════════════════════════════════╗");
  console.log("║   BOB TRADING CONTEST — SETUP               ║");
  console.log("╚══════════════════════════════════════════════╝\x1b[0m\n");

  const swarmKey = process.env.PRIVATE_KEY;
  const swarm    = new ethers.Wallet(swarmKey);
  const swarmBal = await getBalance(swarm.address);

  console.log(`Swarm Wallet: ${swarm.address}`);
  console.log(`BNB Balance:  ${swarmBal.toFixed(6)} BNB (~$${(swarmBal * 645).toFixed(0)})`);
  console.log(`Plan:         4 × ${BNB_PER_AGENT} BNB = ${(BNB_PER_AGENT * 4).toFixed(3)} BNB\n`);

  // Wallets generieren oder laden
  let wallets: { name: string; address: string; privateKey: string }[] = [];

  if (existsSync(WALLETS_FILE)) {
    wallets = JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
    console.log("📂 Bestehende Wallets geladen:");
  } else {
    console.log("🔑 Generiere 4 neue Wallets...");
    for (const name of AGENT_NAMES) {
      const w = ethers.Wallet.createRandom();
      wallets.push({ name, address: w.address, privateKey: w.privateKey });
      console.log(`  ${name}: ${w.address}`);
    }
    writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
    console.log(`✅ Gespeichert in ${WALLETS_FILE}\n`);
  }

  for (const w of wallets) {
    const bal = await getBalance(w.address);
    console.log(`  ${w.name.padEnd(10)} ${w.address}  ${bal.toFixed(4)} BNB`);
  }

  // Funding
  console.log(`\n💸 Funding — je ${BNB_PER_AGENT} BNB pro Agent...\n`);
  const swarmWallet = new ethers.Wallet(swarmKey);

  for (const w of wallets) {
    const current = await getBalance(w.address);
    if (current >= BNB_PER_AGENT * 0.8) {
      console.log(`  ${w.name}: bereits ${current.toFixed(4)} BNB — skip`);
      continue;
    }
    const needed = BNB_PER_AGENT - current;
    console.log(`  ${w.name}: sende ${needed.toFixed(4)} BNB...`);
    try {
      await sendBNB(swarmWallet, w.address, needed);
      console.log(`  ${w.name}: ✅`);
    } catch (e: any) {
      console.error(`  ${w.name}: ❌ ${e.message?.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  // Final check
  console.log("\n📊 Finale Balances:\n");
  for (const w of wallets) {
    const bal = await getBalance(w.address);
    const usd = (bal * 645).toFixed(2);
    console.log(`  ${w.name.padEnd(10)} ${bal.toFixed(5)} BNB  ($${usd})  ${w.address}`);
  }

  const swarmAfter = await getBalance(swarm.address);
  console.log(`\n  SWARM      ${swarmAfter.toFixed(5)} BNB  (reserve)\n`);
  console.log("✅ Setup fertig. Start mit: npm run contest\n");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
