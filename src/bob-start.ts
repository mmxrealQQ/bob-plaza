/**
 * BOB START v8.0 — Autonomous Agent Intelligence
 *
 * Not a cron job. A THINKING system.
 *
 * Every cycle: BRAIN.think() → ACT → BRAIN.learn() → EVOLVE
 * Agents don't just run — they decide, communicate, and adapt.
 *
 * Agents:
 * - BEACON   → Discovers new agents on BNB Chain (every 4h)
 * - SCHOLAR  → Learns from agents via Q&A (every 2h)
 * - SYNAPSE  → Connects compatible agents (every 6h)
 * - PULSE    → Monitors network health (every 2h)
 *
 * Usage: bob start [--skip-first]
 */

import "dotenv/config";
import { spawn, ChildProcess, execSync } from "child_process";
import { appendFileSync, existsSync, statSync, renameSync, readFileSync, readdirSync } from "fs";
import { Brain, type AgentName, type ThinkContext } from "./brain.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const TICK_INTERVAL      = 60 * 1000;              // 60s — think loop
const TIMEOUT_BEACON     = 60 * 60 * 1000;         // 60min max for beacon (scanning)
const TIMEOUT_DEFAULT    = 15 * 60 * 1000;          // 15min max for others
const EVOLVE_EVERY       = 10;                      // evolve every N cycles
const DISCOVERY_EVERY    = 12 * 60;                 // discover chains/APIs every ~12h
const LOG_FILE           = "data/bob.log";
const LOG_MAX_SIZE       = 5 * 1024 * 1024;         // 5MB rotation

// Intervals (minutes)
const BEACON_INTERVAL    = 4 * 60;   // 4h
const SCHOLAR_INTERVAL   = 2 * 60;   // 2h
const SYNAPSE_INTERVAL   = 6 * 60;   // 6h
const PULSE_INTERVAL     = 2 * 60;   // 2h

// ─── State ───────────────────────────────────────────────────────────────────

interface BobState {
  startedAt: number;
  lastRun: Record<string, number>;
  cycleCount: number;
  lastError: string | null;
  running: string | null;
  lastDecisions: Array<{ agent: string; action: string; reason: string; ts: number }>;
  deploysToday: number;
  hotReloads: number;
  updatesToday: number;
}

const state: BobState = {
  startedAt: Date.now(),
  lastRun: { BEACON: 0, SCHOLAR: 0, SYNAPSE: 0, PULSE: 0, DEPLOY: 0, UPDATE: 0, DISCOVERY: 0 },
  cycleCount: 0,
  lastError: null,
  running: null,
  lastDecisions: [],
  deploysToday: 0,
  hotReloads: 0,
  updatesToday: 0,
};

let shuttingDown = false;
let currentChild: ChildProcess | null = null;
let brain: Brain;

// Track file modification times for hot reload
let fileMtimes: Record<string, number> = {};

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const line = `[BOB ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function logBrain(msg: string) {
  const line = `[BRAIN ${new Date().toISOString()}] ${msg}`;
  console.log(`\x1b[35m${line}\x1b[0m`); // Purple for brain
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function rotateLog() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_SIZE) {
      renameSync(LOG_FILE, LOG_FILE + ".old");
      log("Log rotated (>5MB)");
    }
  } catch {}
}

// ─── Agent Runner ────────────────────────────────────────────────────────────

function runAgent(name: string, script: string, timeout = TIMEOUT_DEFAULT): Promise<{ success: boolean; duration: number; output: string }> {
  return new Promise((resolve) => {
    if (shuttingDown) return resolve({ success: false, duration: 0, output: "Shutting down" });

    const start = Date.now();
    state.running = name;
    log(`  ▶ Starting ${name}...`);

    let output = "";
    const child = spawn("npx", ["tsx", script], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env },
    });
    currentChild = child;

    const timer = setTimeout(() => {
      log(`  ⏰ ${name} timed out after ${timeout / 60000}min — killing`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      text.split("\n").filter(Boolean).forEach(line => {
        console.log(`    [${name}] ${line}`);
        try { appendFileSync(LOG_FILE, `    [${name}] ${line}\n`); } catch {}
      });
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("DEP0040") || text.includes("punycode") || text.includes("BNBChain MCP")) return;
      output += text;
      text.split("\n").filter(Boolean).forEach(line => {
        console.log(`    [${name}:ERR] ${line}`);
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      currentChild = null;
      state.running = null;
      const duration = Date.now() - start;
      const success = code === 0;

      if (success) {
        log(`  ✅ ${name} completed in ${(duration / 1000).toFixed(0)}s`);
      } else {
        log(`  ❌ ${name} failed (exit code ${code}) after ${(duration / 1000).toFixed(0)}s`);
        state.lastError = `${name} failed (code ${code})`;
      }

      resolve({ success, duration, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      currentChild = null;
      state.running = null;
      log(`  ❌ ${name} error: ${err.message}`);
      state.lastError = `${name}: ${err.message}`;
      resolve({ success: false, duration: Date.now() - start, output: err.message });
    });
  });
}

/** Run a raw shell command (not via tsx) */
function runCmd(name: string, cmd: string, timeout = TIMEOUT_DEFAULT): Promise<{ success: boolean; duration: number; output: string }> {
  return new Promise((resolve) => {
    if (shuttingDown) return resolve({ success: false, duration: 0, output: "Shutting down" });
    const start = Date.now();
    state.running = name;
    log(`  ▶ Starting ${name}...`);
    let output = "";
    const child = spawn(cmd, [], { stdio: ["ignore", "pipe", "pipe"], shell: true, env: { ...process.env } });
    currentChild = child;
    const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeout);
    child.stdout?.on("data", (d: Buffer) => { const t = d.toString(); output += t; t.split("\n").filter(Boolean).forEach(l => console.log(`    [${name}] ${l}`)); });
    child.stderr?.on("data", (d: Buffer) => { const t = d.toString(); output += t; t.split("\n").filter(Boolean).forEach(l => console.log(`    [${name}:ERR] ${l}`)); });
    child.on("close", (code) => { clearTimeout(timer); currentChild = null; state.running = null; const dur = Date.now() - start; const ok = code === 0; if (ok) log(`  ✅ ${name} completed in ${(dur/1000).toFixed(0)}s`); else { log(`  ❌ ${name} failed (exit code ${code}) after ${(dur/1000).toFixed(0)}s`); state.lastError = `${name} failed (code ${code})`; } resolve({ success: ok, duration: dur, output }); });
    child.on("error", (err) => { clearTimeout(timer); currentChild = null; state.running = null; resolve({ success: false, duration: Date.now() - start, output: err.message }); });
  });
}

// ─── Context Gathering ──────────────────────────────────────────────────────

function gatherContext(): ThinkContext {
  const ctx: ThinkContext = {};

  // Read registry stats
  try {
    if (existsSync("data/agent-registry.json")) {
      const reg = JSON.parse(readFileSync("data/agent-registry.json", "utf-8"));
      ctx.registryStats = reg.stats || {};
      ctx.totalAgents = reg.stats?.total || Object.keys(reg.agents || {}).length;
      ctx.reachableAgents = reg.stats?.a2aReachable || 0;
    }
  } catch {}

  // Read external stats
  try {
    if (existsSync("data/external-agents.json")) {
      const ext = JSON.parse(readFileSync("data/external-agents.json", "utf-8"));
      ctx.externalStats = ext.stats || {};
    }
  } catch {}

  return ctx;
}

async function fetchLiveContext(ctx: ThinkContext): Promise<ThinkContext> {
  const [bnbResult, tvlResult] = await Promise.allSettled([
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd", { signal: AbortSignal.timeout(5000) }),
    fetch("https://api.llama.fi/v2/chains", { signal: AbortSignal.timeout(5000) }),
  ]);

  if (bnbResult.status === "fulfilled" && bnbResult.value.ok) {
    try {
      const data = await bnbResult.value.json();
      ctx.bnbPrice = data.binancecoin?.usd;
    } catch {}
  }

  if (tvlResult.status === "fulfilled" && tvlResult.value.ok) {
    try {
      const chains = await tvlResult.value.json();
      const bsc = chains.find((c: any) => c.gecko_id === "binancecoin" || c.name === "BSC");
      if (bsc) ctx.bscTvl = bsc.tvl;
    } catch {}
  }

  return ctx;
}

// ─── Intelligent Pipeline ────────────────────────────────────────────────────

async function intelligentCycle(agent: AgentName, forceAction?: string): Promise<void> {
  if (shuttingDown) return;

  state.cycleCount++;

  // ┌─────────────────────────────────────────────────────┐
  // │  PHASE 1: THINK — Brain decides what to do          │
  // └─────────────────────────────────────────────────────┘
  logBrain(`Thinking for ${agent}...`);

  let ctx = gatherContext();
  // Only fetch live data every few cycles to save API calls
  if (state.cycleCount % 3 === 1) {
    ctx = await fetchLiveContext(ctx);
  }

  const decision = forceAction
    ? { action: forceAction, reason: "Forced initial run", params: {}, priority: 8 }
    : await brain.think(agent, ctx);

  logBrain(`Decision: ${decision.action} (priority ${decision.priority})`);
  logBrain(`Reason: "${decision.reason}"`);

  state.lastDecisions.push({
    agent, action: decision.action, reason: decision.reason, ts: Date.now()
  });
  if (state.lastDecisions.length > 20) state.lastDecisions.shift();

  // Skip if brain says so
  if (decision.action === "skip" || decision.action === "wait") {
    logBrain(`${agent} skipping this cycle`);
    return;
  }

  // Share insight with other agents
  if (decision.insightForOthers) {
    logBrain(`Insight shared: "${decision.insightForOthers}"`);
  }

  // ┌─────────────────────────────────────────────────────┐
  // │  PHASE 2: ACT — Execute the agent                   │
  // └─────────────────────────────────────────────────────┘
  console.log("");
  log(`${"═".repeat(60)}`);
  log(`🚀 CYCLE #${state.cycleCount} — ${agent} → ${decision.action}`);
  log(`${"═".repeat(60)}`);

  let result: { success: boolean; duration: number; output: string };

  switch (agent) {
    case "BEACON":
      result = await runAgent("BEACON", "src/beacon.ts", TIMEOUT_BEACON);
      state.lastRun.BEACON = Date.now();

      // After BEACON finds new agents, run SCHOLAR to learn from them
      if (result.success && !shuttingDown) {
        logBrain("BEACON done → triggering SCHOLAR to learn from new agents");
        const scholarResult = await runAgent("SCHOLAR", "src/scholar.ts", TIMEOUT_DEFAULT);
        state.lastRun.SCHOLAR = Date.now();
        brain.learn("SCHOLAR", "auto_learn", scholarResult);
      }
      break;

    case "SCHOLAR":
      result = await runAgent("SCHOLAR", "src/scholar.ts", TIMEOUT_DEFAULT);
      state.lastRun.SCHOLAR = Date.now();
      break;

    case "SYNAPSE":
      result = await runAgent("SYNAPSE", "src/synapse.ts", TIMEOUT_DEFAULT);
      state.lastRun.SYNAPSE = Date.now();
      break;

    case "PULSE":
      result = await runAgent("PULSE", "src/pulse.ts", TIMEOUT_DEFAULT);
      state.lastRun.PULSE = Date.now();

      // After PULSE runs, check if on-chain update is needed
      if (result.success && !shuttingDown && state.updatesToday === 0) {
        const updateCheck = brain.shouldUpdate();
        if (updateCheck.shouldUpdate) {
          logBrain(`On-chain update needed: ${updateCheck.reason}`);
          logBrain(`Features: ${updateCheck.features.join(", ")}`);
          const updateResult = await runAgent("UPDATE", "src/update-agents.ts", TIMEOUT_DEFAULT);
          state.lastRun.UPDATE = Date.now();
          if (updateResult.success) {
            brain.markUpdated();
            state.updatesToday++;
            logBrain("On-chain update complete! Metadata refreshed on 8004scan.");
          } else {
            logBrain("On-chain update failed — will retry next PULSE cycle");
          }
        } else {
          logBrain(`No update needed: ${updateCheck.reason}`);
        }
      }
      break;

    default:
      result = { success: false, duration: 0, output: "Unknown agent" };
  }

  // ┌─────────────────────────────────────────────────────┐
  // │  PHASE 3: LEARN — Brain processes the result        │
  // └─────────────────────────────────────────────────────┘
  logBrain(`Learning from ${agent} result (${result.success ? "success" : "failed"})...`);
  brain.learn(agent, decision.action, result);

  // Check inter-agent messages
  const unread = brain.getUnreadCount(agent);
  if (unread > 0) {
    logBrain(`${agent} has ${unread} unread messages from other agents`);
  }

  // ┌─────────────────────────────────────────────────────┐
  // │  PHASE 4: EVOLVE — Periodic self-improvement        │
  // └─────────────────────────────────────────────────────┘
  if (state.cycleCount % EVOLVE_EVERY === 0) {
    logBrain("Initiating evolution cycle...");
    const evolution = await brain.evolve();
    logBrain(`Evolution: ${evolution}`);

    // Log A2A failure insights
    const deadAgents = brain.getDeadAgents();
    if (deadAgents.length > 0) {
      logBrain(`A2A: ${deadAgents.length} agents permanently dead — SYNAPSE/SCHOLAR skip them`);
    }
  }

  brain.save();
}

// ─── Hot Reload ──────────────────────────────────────────────────────────────

function snapshotFileTimes(): Record<string, number> {
  const times: Record<string, number> = {};
  try {
    const files = readdirSync("src").filter(f => f.endsWith(".ts"));
    for (const f of files) {
      try {
        times[f] = statSync(`src/${f}`).mtimeMs;
      } catch {}
    }
  } catch {}
  return times;
}

function checkHotReload(): boolean {
  const current = snapshotFileTimes();
  let changed = false;

  for (const [file, mtime] of Object.entries(current)) {
    if (fileMtimes[file] && fileMtimes[file] !== mtime) {
      log(`🔄 Hot reload: ${file} changed`);
      changed = true;
      state.lastError = null;
    }
  }

  // If bob-start.ts itself changed, do a full restart
  if (changed && current["bob-start.ts"] !== fileMtimes["bob-start.ts"] && fileMtimes["bob-start.ts"]) {
    log("🔄 bob-start.ts changed — restarting orchestrator...");
    brain.save(); // Save brain state before restart
    const child = spawn("npx", ["tsx", "src/bob-start.ts", "--skip-first"], {
      stdio: "inherit",
      shell: true,
      detached: true,
      env: { ...process.env },
    });
    child.unref();
    process.exit(0);
  }

  fileMtimes = current;
  if (changed) state.hotReloads++;
  return changed;
}

// ─── Status Display ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatAgo(ts: number): string {
  if (!ts) return "never";
  return formatDuration(Date.now() - ts) + " ago";
}

function printStatus() {
  const now = Date.now();
  const uptime = formatDuration(now - state.startedAt);
  const brainStats = brain.getStats();

  const lastDecision = state.lastDecisions.length > 0
    ? state.lastDecisions[state.lastDecisions.length - 1]
    : null;

  console.log(`
\x1b[35m  ╔═══════════════════════════════════════════════════════╗
  ║   BOB v8.0 — Autonomous Agent Intelligence            ║
  ║   🧠 BRAIN: Active | ${String(brainStats.totalThoughts).padStart(3)} thoughts | ${String(brainStats.totalEvolutions).padStart(2)} evolutions    ║
  ╠═══════════════════════════════════════════════════════╣\x1b[0m
  \x1b[33m║\x1b[0m  Uptime:       ${uptime.padEnd(15)} Cycles:   ${state.cycleCount}
  \x1b[33m║\x1b[0m  Running:      ${(state.running || "idle (thinking...)").padEnd(15)} Deploys:  ${state.deploysToday}
  \x1b[33m║\x1b[0m  Hot reloads:  ${String(state.hotReloads).padEnd(15)} Errors:   ${state.lastError || "none"}
  \x1b[33m║\x1b[0m
  \x1b[33m║\x1b[0m  🔦 BEACON:    ${formatAgo(state.lastRun.BEACON).padEnd(15)} 🎓 SCHOLAR:  ${formatAgo(state.lastRun.SCHOLAR)}
  \x1b[33m║\x1b[0m  🔗 SYNAPSE:   ${formatAgo(state.lastRun.SYNAPSE).padEnd(15)} 💓 PULSE:    ${formatAgo(state.lastRun.PULSE)}
  \x1b[33m║\x1b[0m  🔄 DISCOVERY: ${formatAgo(state.lastRun.DISCOVERY).padEnd(15)} 📦 UPDATE:  ${formatAgo(state.lastRun.UPDATE)}
  \x1b[33m║\x1b[0m
  \x1b[35m║\x1b[0m  🧠 Relationships: ${String(brainStats.relationships).padEnd(5)} Discoveries: ${brainStats.discoveries}
  \x1b[35m║\x1b[0m  🧠 Insights:      ${String(brainStats.insights).padEnd(5)} Unread msgs: ${brainStats.unreadMessages}
  \x1b[35m║\x1b[0m  🧠 Beacon yield:  ${(brainStats.beaconYield || []).join("→") || "no data"}
  \x1b[35m║\x1b[0m  🧠 Synapse rate:  ${((brainStats.synapseResponseRate || 0) * 100).toFixed(0)}%${lastDecision ? `
  \x1b[35m║\x1b[0m
  \x1b[35m║\x1b[0m  Last thought: [${lastDecision.agent}] ${lastDecision.action}
  \x1b[35m║\x1b[0m    "${lastDecision.reason.slice(0, 55)}"` : ""}
\x1b[35m  ╚═══════════════════════════════════════════════════════╝\x1b[0m
`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isDue(key: string, intervalMin: number): boolean {
  const last = state.lastRun[key] || 0;
  return Date.now() - last >= intervalMin * 60 * 1000;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`
\x1b[35m╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   BOB v8.0 — Autonomous AI Agent Network on BNB Chain     ║
║   ────────────────────────────────────────                 ║
║                                                           ║
║   🧠 BRAIN      Think · Learn · Evolve                    ║
║   🔦 BEACON     Discover · Invite · Test A2A (4h)        ║
║   🎓 SCHOLAR    Question · Learn · Synthesize (2h)       ║
║   🔗 SYNAPSE    Match · Introduce · Connect (6h)         ║
║   💓 PULSE      Health · Market · Growth (2h)            ║
║                                                           ║
║   Agents don't just run — they THINK and EVOLVE.          ║
║   Build On BNB · $BOB · The Real Builder                  ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝\x1b[0m
  `);

  rotateLog();

  // Initialize Brain
  brain = new Brain();
  const brainStats = brain.getStats();
  logBrain(`Brain loaded: ${brainStats.totalThoughts} thoughts, ${brainStats.totalEvolutions} evolutions, ${brainStats.relationships} relationships`);
  logBrain(`Memory file: ${existsSync("data/brain.json") ? "restored from disk" : "fresh start"}`);

  // Track v8.0 features for on-chain update decision
  brain.trackFeature("BEACON: Autonomous Agent Discovery + Invitations");
  brain.trackFeature("SCHOLAR: LLM-Powered Knowledge Collection");
  brain.trackFeature("SYNAPSE: Agent Connection Facilitator");
  brain.trackFeature("PULSE: Network Health Monitor");
  brain.trackFeature("Dual-LLM Brain (Groq + Haiku)");
  brain.trackFeature("A2A Failure Memory + Dead Agent Tracking");

  // Snapshot file times for hot reload
  fileMtimes = snapshotFileTimes();
  log(`Hot reload: watching ${Object.keys(fileMtimes).length} source files`);

  const skipFirst = process.argv.includes("--skip-first");

  if (!skipFirst) {
    // ── Initial Boot Sequence ─────────────────────────────────────────────
    logBrain("Boot sequence: initial intelligence gathering...");

    // BEACON — discover agents first
    await intelligentCycle("BEACON", "discover_agents");

    if (!shuttingDown) {
      // SCHOLAR — learn from discovered agents
      await intelligentCycle("SCHOLAR", "learn_from_agents");
    }

    if (!shuttingDown) {
      // PULSE — baseline health check
      await intelligentCycle("PULSE", "health_check");
    }

    if (!shuttingDown) {
      // SYNAPSE — start connecting agents
      await intelligentCycle("SYNAPSE", "connect_agents");
    }

    logBrain("Boot sequence complete. Entering autonomous mode...");
  } else {
    log("Skipping initial runs (--skip-first)");
    const now = Date.now();
    state.lastRun.BEACON = now;
    state.lastRun.SCHOLAR = now;
    state.lastRun.SYNAPSE = now;
    state.lastRun.PULSE = now;
  }

  log("");
  logBrain("╔═══════════════════════════════════════╗");
  logBrain("║  AUTONOMOUS MODE — Brain is thinking  ║");
  logBrain("╚═══════════════════════════════════════╝");
  log("");

  let statusTick = 0;

  while (!shuttingDown) {
    // ── Hot Reload Check ─────────────────────────────────────────────────
    checkHotReload();

    // ── Brain-Driven Scheduling ──────────────────────────────────────────
    // Priority order: BEACON > SCHOLAR > PULSE > SYNAPSE > DISCOVERY
    if (isDue("BEACON", BEACON_INTERVAL)) {
      await intelligentCycle("BEACON");
    } else if (isDue("SCHOLAR", SCHOLAR_INTERVAL)) {
      await intelligentCycle("SCHOLAR");
    } else if (isDue("PULSE", PULSE_INTERVAL)) {
      await intelligentCycle("PULSE");
    } else if (isDue("SYNAPSE", SYNAPSE_INTERVAL)) {
      await intelligentCycle("SYNAPSE");
    } else if (isDue("DISCOVERY", DISCOVERY_EVERY)) {
      // Discovery: Find new chains and APIs
      logBrain("DISCOVERY: Searching for new chains and APIs...");
      const chainResult = await brain.discoverNewChains();
      const apiResult = await brain.discoverNewAPIs();
      state.lastRun.DISCOVERY = Date.now();
      logBrain(`Discovery: ${chainResult.totalChains} chains, ${chainResult.newChains.length} new. ${apiResult.length} APIs found.`);
    }

    // Status display every 5 ticks (5 min)
    statusTick++;
    if (statusTick >= 5) {
      printStatus();
      statusTick = 0;
    }

    // Wait before next tick
    await sleep(TICK_INTERVAL);
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────
  logBrain("Saving brain state before shutdown...");
  brain.save();
  log("BOB has stopped. Brain state preserved. See you next time, builder. 🏗️");
  process.exit(0);
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on("SIGINT", () => {
  if (shuttingDown) {
    console.log("\nForce quit.");
    if (brain) brain.save();
    process.exit(1);
  }
  shuttingDown = true;
  logBrain("Shutting down gracefully... (Ctrl+C again to force)");
  if (currentChild) {
    currentChild.kill("SIGTERM");
  }
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  if (brain) brain.save();
  if (currentChild) currentChild.kill("SIGTERM");
});

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch(e => {
  console.error("Fatal error:", e);
  if (brain) brain.save();
  process.exit(1);
});
