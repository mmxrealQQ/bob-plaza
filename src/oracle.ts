/**
 * BOB ORACLE — Strategy & Treasury Agent
 *
 * Monitors system health, checks wallet balances, verifies all agents are online.
 * Future: auto-buy $BOB when BNB arrives.
 *
 * Usage: npm run oracle
 */

import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync, existsSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const BSC_RPC = "https://bsc-dataseed.binance.org";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const SWARM_WALLET = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const OWNER_WALLET = "0x5787F2Ac0e140e99Ec73546d1c51092CeF3cE546";
const BOB_URL = "https://project-gkws4.vercel.app";
const DATA_FILE = "data/agent-registry.json";
const EXT_DATA_FILE = "data/external-agents.json";
const WALLETS_FILE = "data/contest-wallets.json";
const FETCH_TIMEOUT = 8000;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[ORACLE ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Health Checks ───────────────────────────────────────────────────────────

interface HealthResult {
  endpoint: string;
  status: "ok" | "down" | "error";
  responseTime: number;
  detail?: string;
}

async function checkEndpoint(name: string, url: string): Promise<HealthResult> {
  const start = Date.now();
  try {
    const resp = await fetchWithTimeout(url);
    const ms = Date.now() - start;
    if (resp.ok) {
      return { endpoint: name, status: "ok", responseTime: ms };
    }
    return { endpoint: name, status: "error", responseTime: ms, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { endpoint: name, status: "down", responseTime: Date.now() - start, detail: e.message?.slice(0, 50) };
  }
}

async function checkA2A(): Promise<HealthResult> {
  const start = Date.now();
  try {
    const resp = await fetchWithTimeout(BOB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        id: "oracle-health",
        params: { message: { role: "user", parts: [{ text: "health check" }] } },
      }),
    });
    const ms = Date.now() - start;
    if (resp.ok) {
      const data = await resp.json();
      if (data.result?.status?.state === "completed") {
        return { endpoint: "A2A message/send", status: "ok", responseTime: ms };
      }
    }
    return { endpoint: "A2A message/send", status: "error", responseTime: ms };
  } catch (e: any) {
    return { endpoint: "A2A message/send", status: "down", responseTime: Date.now() - start, detail: e.message?.slice(0, 50) };
  }
}

// ─── Treasury ────────────────────────────────────────────────────────────────

interface WalletBalance {
  name: string;
  address: string;
  bnb: string;
  bob: string;
}

async function getBalances(provider: ethers.JsonRpcProvider): Promise<WalletBalance[]> {
  const bobContract = new ethers.Contract(BOB_TOKEN, ERC20_ABI, provider);
  const balances: WalletBalance[] = [];

  // Swarm wallet
  const swarmBnb = await provider.getBalance(SWARM_WALLET);
  const swarmBob = await bobContract.balanceOf(SWARM_WALLET);
  balances.push({
    name: "SWARM (Treasury)",
    address: SWARM_WALLET,
    bnb: ethers.formatEther(swarmBnb),
    bob: ethers.formatEther(swarmBob),
  });

  // Owner wallet
  const ownerBnb = await provider.getBalance(OWNER_WALLET);
  const ownerBob = await bobContract.balanceOf(OWNER_WALLET);
  balances.push({
    name: "OWNER",
    address: OWNER_WALLET,
    bnb: ethers.formatEther(ownerBnb),
    bob: ethers.formatEther(ownerBob),
  });

  // Bot wallets
  if (existsSync(WALLETS_FILE)) {
    const wallets = JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
    for (const w of wallets) {
      const bnb = await provider.getBalance(w.address);
      const bob = await bobContract.balanceOf(w.address);
      balances.push({
        name: w.name,
        address: w.address,
        bnb: ethers.formatEther(bnb),
        bob: ethers.formatEther(bob),
      });
    }
  }

  return balances;
}

// ─── Registry Status ─────────────────────────────────────────────────────────

function getRegistryStatus() {
  if (!existsSync(DATA_FILE)) return null;
  const data = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const ageSec = Math.floor((Date.now() - data.lastScan) / 1000);
  const ageMin = Math.floor(ageSec / 60);
  return {
    agents: data.stats.total,
    legit: data.stats.legit,
    active: data.stats.active,
    inactive: data.stats.inactive,
    dead: data.stats.dead,
    maxId: data.maxAgentId,
    lastScan: new Date(data.lastScan).toISOString(),
    age: ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`,
    stale: ageMin > 360, // older than 6 hours = stale
  };
}

// ─── External Registry Status ────────────────────────────────────────────────

function getExternalStatus() {
  if (!existsSync(EXT_DATA_FILE)) return null;
  const data = JSON.parse(readFileSync(EXT_DATA_FILE, "utf-8"));
  if (!data.lastScan) return null;
  const ageSec = Math.floor((Date.now() - data.lastScan) / 1000);
  const ageMin = Math.floor(ageSec / 60);
  return {
    total: data.stats.total || 0,
    reachable: data.stats.reachable || 0,
    responds: data.stats.responds || 0,
    withAgentCard: data.stats.withAgentCard || 0,
    lastScan: new Date(data.lastScan).toISOString(),
    age: ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`,
    stale: ageMin > 720, // 12 hours = stale for external
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   BOB ORACLE — Strategy & Treasury                    ║");
  console.log("║   System health check + treasury report               ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(BSC_RPC);

  // ── 1. Health Checks ────────────────────────────────────────────────
  log("Running health checks...\n");

  const checks = await Promise.all([
    checkEndpoint("Agent Card", `${BOB_URL}/.well-known/agent.json`),
    checkEndpoint("ERC-8004 Metadata", BOB_URL),
    checkEndpoint("Health", `${BOB_URL}/health`),
    checkEndpoint("Stats API", `${BOB_URL}/stats`),
    checkEndpoint("Database", `${BOB_URL}/database`),
    checkEndpoint("Agents API", `${BOB_URL}/agents`),
    checkA2A(),
  ]);

  console.log("  ENDPOINT                  STATUS    TIME");
  console.log("  ─────────────────────────────────────────");
  for (const c of checks) {
    const icon = c.status === "ok" ? "✅" : c.status === "down" ? "❌" : "⚠️";
    const time = `${c.responseTime}ms`;
    const detail = c.detail ? ` (${c.detail})` : "";
    console.log(`  ${icon} ${c.endpoint.padEnd(24)} ${c.status.padEnd(8)} ${time}${detail}`);
  }

  const allOk = checks.every(c => c.status === "ok");
  const avgTime = Math.round(checks.reduce((s, c) => s + c.responseTime, 0) / checks.length);
  console.log(`\n  Overall: ${allOk ? "✅ ALL SYSTEMS OPERATIONAL" : "⚠️  ISSUES DETECTED"} (avg ${avgTime}ms)`);

  // ── 2. Treasury ─────────────────────────────────────────────────────
  log("\nChecking treasury...\n");

  const balances = await getBalances(provider);
  let totalBnb = 0, totalBob = 0;

  console.log("  WALLET                BNB              $BOB");
  console.log("  ─────────────────────────────────────────────────");
  for (const b of balances) {
    const bnb = parseFloat(b.bnb);
    const bob = parseFloat(b.bob);
    totalBnb += bnb;
    totalBob += bob;
    console.log(`  ${b.name.padEnd(22)} ${bnb.toFixed(6).padStart(12)} BNB   ${bob > 0 ? bob.toFixed(0).padStart(10) : "0".padStart(10)} $BOB`);
  }
  console.log("  ─────────────────────────────────────────────────");
  console.log(`  ${"TOTAL".padEnd(22)} ${totalBnb.toFixed(6).padStart(12)} BNB   ${totalBob.toFixed(0).padStart(10)} $BOB`);

  // ── 3. Registry Status ──────────────────────────────────────────────
  const reg = getRegistryStatus();
  if (reg) {
    log("\nRegistry status...\n");
    console.log(`  Agents:     ${reg.agents} (${reg.legit} legit, ${reg.inactive} inactive, ${reg.dead} dead)`);
    console.log(`  Max ID:     ${reg.maxId}`);
    console.log(`  Last scan:  ${reg.lastScan} (${reg.age})`);
    if (reg.stale) {
      console.log("  ⚠️  DATA IS STALE — run 'npm run push' to check for new agents");
    }
  }

  // ── 3b. External Agents Status ─────────────────────────────────────
  const ext = getExternalStatus();
  if (ext) {
    log("\nExternal agents (Open A2A)...\n");
    console.log(`  Agents:     ${ext.total} (${ext.reachable} reachable, ${ext.responds} respond)`);
    console.log(`  Agent Cards: ${ext.withAgentCard}`);
    console.log(`  Last scan:  ${ext.lastScan} (${ext.age})`);
    if (ext.stale) {
      console.log("  ⚠️  EXTERNAL DATA IS STALE — run 'bob scout:ext' to refresh");
    }
  }

  // ── Network Overview ──────────────────────────────────────────────
  log("\nNetwork overview...\n");
  const bscResponds = reg ? reg.legit : 0;
  const extResponds = ext ? ext.responds : 0;
  const totalAgents = (reg ? reg.agents : 0) + (ext ? ext.total : 0);
  const totalResponds = bscResponds + extResponds;
  console.log(`  BSC:        ${reg ? reg.agents : 0} agents (${reg ? reg.legit : 0} legit, ${reg ? reg.active : 0} active)`);
  console.log(`  External:   ${ext ? ext.total : 0} agents (${ext ? ext.reachable : 0} reachable, ${extResponds} respond)`);
  console.log(`  Total:      ${totalAgents} agents tracked | ${totalResponds} responding`);

  // ── 4. $BOB Market Data ────────────────────────────────────────────
  log("\nChecking $BOB market...\n");

  let bobPrice = 0;
  try {
    const priceResp = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${BOB_TOKEN}`);
    if (priceResp.ok) {
      const priceData = (await priceResp.json()) as { pairs?: any[] };
      const pair = priceData.pairs?.[0];
      if (pair) {
        bobPrice = parseFloat(pair.priceUsd || "0");
        const change = pair.priceChange?.h24 ?? 0;
        console.log(`  Price:      $${pair.priceUsd}`);
        console.log(`  24h Change: ${change > 0 ? "+" : ""}${change}%`);
        console.log(`  Volume 24h: $${pair.volume?.h24?.toLocaleString()}`);
        console.log(`  Liquidity:  $${pair.liquidity?.usd?.toLocaleString()}`);
        console.log(`  DEX:        ${pair.dexId} | Pair: ${pair.pairAddress?.slice(0, 10)}...`);
        if (totalBob > 0 && bobPrice > 0) {
          console.log(`  Holdings:   ${totalBob.toFixed(0)} $BOB = $${(totalBob * bobPrice).toFixed(4)}`);
        }
      }
    }
  } catch {
    console.log("  ⚠️  Could not fetch $BOB price data");
  }

  // ── 5. Recommendations ─────────────────────────────────────────────
  log("\nRecommendations:\n");

  if (!allOk) console.log("  🔴 Fix failing endpoints!");
  if (reg?.stale) console.log("  🟡 Run 'npm run push' — data is stale");
  if (ext?.stale) console.log("  🟡 Run 'bob scout:ext' — external data is stale");
  if (!ext) console.log("  💡 Run 'bob scout:ext' to start tracking external agents");
  if (totalBnb < 0.005) console.log("  🟡 Low BNB — send BNB to swarm wallet for on-chain operations");
  if (totalBob === 0) console.log("  🟡 No $BOB in treasury — consider buying on PancakeSwap");
  if (totalBnb > 0.05) console.log("  💡 Enough BNB to buy $BOB — consider swapping on PancakeSwap");
  if (allOk && !reg?.stale && totalBnb >= 0.005) console.log("  ✅ All good. Build On BNB.");

  // ── Summary ─────────────────────────────────────────────────────────
  const netLine = `BSC: ${reg ? reg.agents : 0} + Ext: ${ext ? ext.total : 0} = ${totalAgents} tracked`;
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   ORACLE SUMMARY                                      ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║   System:    ${(allOk ? "ALL OK" : "ISSUES").padEnd(41)}║`);
  console.log(`║   Endpoints: ${checks.filter(c => c.status === "ok").length}/${checks.length} online (avg ${avgTime}ms)${" ".repeat(Math.max(0, 24 - String(avgTime).length))}║`);
  console.log(`║   Treasury:  ${totalBnb.toFixed(6)} BNB / ${totalBob.toFixed(0)} $BOB${" ".repeat(Math.max(0, 22 - totalBob.toFixed(0).length))}║`);
  console.log(`║   Network:   ${netLine.padEnd(41)}║`);
  console.log(`║   Responds:  ${String(totalResponds).padEnd(41)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  process.exit(0);
}

main().catch(e => {
  console.error("❌ Error:", e);
  process.exit(1);
});
