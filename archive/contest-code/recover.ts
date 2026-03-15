/**
 * CONTEST RECOVERY — Verkauft alle übrigen Tokens aus Agent-Wallets
 * npm run contest-recover
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, existsSync } from "fs";

const BSC_RPCS     = ["https://bsc-dataseed1.binance.org/", "https://bsc-dataseed2.binance.org/"];
const WBNB         = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER       = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const WALLETS_FILE = "contest-wallets.json";

// Known tokens from the contest
const KNOWN_TOKENS = [
  "0x9458D80Dc98143cB4dAfd1555b0feD364B3935c2", // 小龙虾
  "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", // PEPE
];

const ROUTER_ABI = [
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

function getProvider() {
  return new ethers.JsonRpcProvider(BSC_RPCS[Math.floor(Math.random() * BSC_RPCS.length)]);
}

async function sellAll(agentName: string, privateKey: string): Promise<number> {
  const provider = getProvider();
  const wallet   = new ethers.Wallet(privateKey, provider);
  let totalRecovered = 0;

  console.log(`\n[${agentName}] ${wallet.address}`);

  for (const tokenAddr of KNOWN_TOKENS) {
    try {
      const token    = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
      const balance  = await token.balanceOf(wallet.address) as bigint;
      if (balance === 0n) continue;

      const symbol   = await token.symbol() as string;
      const decimals = Number(await token.decimals());
      const human    = parseFloat(ethers.formatUnits(balance, decimals));
      console.log(`  Found ${human.toFixed(2)} ${symbol}`);

      // Approve
      const allowance = await token.allowance(wallet.address, ROUTER) as bigint;
      if (allowance < balance) {
        const appTx = await token.approve(ROUTER, ethers.MaxUint256);
        await appTx.wait();
      }

      // Check quote
      const router  = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
      let amounts: bigint[];
      try {
        amounts = await router.getAmountsOut(balance, [tokenAddr, WBNB]) as bigint[];
      } catch {
        console.log(`  ${symbol}: no liquidity route — skip`);
        continue;
      }

      const minOut  = amounts[1] * 80n / 100n; // 20% slippage for safety
      const deadline = Math.floor(Date.now() / 1000) + 300;

      const tx = await router.swapExactTokensForETH(
        balance, minOut, [tokenAddr, WBNB], wallet.address, deadline, { gasLimit: 350000n }
      );
      await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);

      const received = parseFloat(ethers.formatEther(amounts[1]));
      totalRecovered += received;
      console.log(`  ✅ Sold ${symbol} → ~${received.toFixed(6)} BNB | TX: ${tx.hash}`);

    } catch (e: any) {
      console.log(`  ⚠️  ${tokenAddr.slice(0, 10)}...: ${e.message?.slice(0, 80)}`);
    }
  }

  // Now send all BNB to swarm
  await new Promise(r => setTimeout(r, 3000));
  const bnb      = await provider.getBalance(wallet.address);
  const feeData  = await provider.getFeeData();
  const gasCost  = (feeData.gasPrice ?? 3000000000n) * 21000n;
  const toSend   = bnb > gasCost ? bnb - gasCost : 0n;

  if (toSend > 0n) {
    const sent = parseFloat(ethers.formatEther(toSend));
    const tx   = await wallet.sendTransaction({ to: SWARM_WALLET, value: toSend });
    await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 30000))]);
    console.log(`  💸 → Swarm: ${sent.toFixed(6)} BNB ✅`);
    return sent;
  }
  return 0;
}

const GAS_BUDGET = ethers.parseEther("0.003"); // 0.003 BNB gas per wallet

async function fundForGas(swarmKey: string, wallets: { name: string; address: string }[]): Promise<void> {
  const provider = getProvider();
  const swarm    = new ethers.Wallet(swarmKey, provider);
  console.log(`\n💸 Sende Gas-BNB an Agent-Wallets...\n`);

  for (const w of wallets) {
    const bal = await provider.getBalance(w.address);
    if (bal >= GAS_BUDGET) {
      console.log(`  ${w.name}: already has ${ethers.formatEther(bal)} BNB`);
      continue;
    }
    const needed = GAS_BUDGET - bal;
    try {
      const tx = await swarm.sendTransaction({ to: w.address, value: needed, gasLimit: 21000n });
      await Promise.race([tx.wait(), new Promise<null>(r => setTimeout(() => r(null), 20000))]);
      console.log(`  ${w.name}: ✅ sent ${ethers.formatEther(needed)} BNB gas`);
    } catch (e: any) {
      console.log(`  ${w.name}: ❌ ${e.message?.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function main() {
  if (!existsSync(WALLETS_FILE)) {
    console.error("❌ contest-wallets.json nicht gefunden");
    process.exit(1);
  }
  if (!process.env.PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY fehlt in .env");
    process.exit(1);
  }

  const wallets = JSON.parse(readFileSync(WALLETS_FILE, "utf-8")) as { name: string; address: string; privateKey: string }[];

  console.log("\n\x1b[35m╔══════════════════════════════════════════╗");
  console.log("║   CONTEST RECOVERY — Token Liquidation  ║");
  console.log("╚══════════════════════════════════════════╝\x1b[0m");

  // Step 1: Fund wallets with gas money
  await fundForGas(process.env.PRIVATE_KEY, wallets);
  await new Promise(r => setTimeout(r, 3000));

  // Step 2: Sell all tokens + return BNB
  const totals = await Promise.all(wallets.map(w => sellAll(w.name, w.privateKey)));
  const total  = totals.reduce((s, n) => s + n, 0);

  const provider = getProvider();
  const swarmBal = await provider.getBalance(SWARM_WALLET);
  const swarmBNB = parseFloat(ethers.formatEther(swarmBal));

  console.log(`\n✅ Recovery komplett`);
  console.log(`💸 Zurückgeholt: ${total.toFixed(6)} BNB`);
  console.log(`🏦 Swarm Wallet jetzt: ${swarmBNB.toFixed(6)} BNB\n`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
