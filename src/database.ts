/**
 * BOB DATABASE — Data & Classification Agent
 *
 * Analyzes the registry data, generates classification reports,
 * tracks trust score history, and produces structured intelligence.
 *
 * Usage: npm run database
 *        ./bob database
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_FILE = "data/agent-registry.json";
const HISTORY_FILE = "data/registry-history.json";
const REPORT_FILE = "data/database-report.json";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  active: boolean;
  version: string;
  a2aEndpoint: string;
  hasAgentCard: boolean;
  a2aReachable: boolean;
  a2aResponds: boolean;
  category: string;
  score: number;
  services: string[];
  scannedAt: number;
  status: "active" | "inactive" | "spam" | "legit" | "dead" | "unknown";
}

interface HistoryEntry {
  timestamp: number;
  date: string;
  maxAgentId: number;
  total: number;
  active: number;
  legit: number;
  inactive: number;
  dead: number;
  withA2A: number;
  a2aReachable: number;
  a2aResponds: number;
  topCategories: Record<string, number>;
  topOwners: { address: string; count: number; agents: number[] }[];
}

interface DatabaseReport {
  generatedAt: string;
  summary: {
    totalAgents: number;
    maxAgentId: number;
    lastScan: string;
    aliveRate: string;
    a2aAdoptionRate: string;
    legitRate: string;
  };
  categories: { name: string; count: number; percentage: string }[];
  statusBreakdown: Record<string, number>;
  serviceAdoption: {
    service: string;
    count: number;
    percentage: string;
  }[];
  topAgents: {
    id: number;
    name: string;
    score: number;
    status: string;
    category: string;
    services: string[];
    hasA2A: boolean;
  }[];
  ownerAnalysis: {
    uniqueOwners: number;
    topOwners: { address: string; agentCount: number; topAgent: string }[];
    singleAgentOwners: number;
    multiAgentOwners: number;
  };
  networkHealth: {
    a2aEndpoints: number;
    a2aReachable: number;
    a2aResponds: number;
    reachabilityRate: string;
    responseRate: string;
  };
  trends: {
    registrationRate: string;
    growthDirection: string;
    previousTotal: number | null;
    currentTotal: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[DATABASE ${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

function pct(part: number, total: number): string {
  if (total === 0) return "0%";
  return (part / total * 100).toFixed(1) + "%";
}

// ─── Analysis Functions ──────────────────────────────────────────────────────

function analyzeCategories(agents: AgentRecord[]): { name: string; count: number; percentage: string }[] {
  const cats: Record<string, number> = {};
  for (const a of agents) {
    if (a.status === "dead") continue;
    const cat = a.category || "unknown";
    cats[cat] = (cats[cat] || 0) + 1;
  }
  const alive = agents.filter(a => a.status !== "dead").length;
  return Object.entries(cats)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => ({ name, count, percentage: pct(count, alive) }));
}

function analyzeOwners(agents: AgentRecord[]): {
  uniqueOwners: number;
  topOwners: { address: string; agentCount: number; topAgent: string }[];
  singleAgentOwners: number;
  multiAgentOwners: number;
} {
  const ownerMap: Record<string, AgentRecord[]> = {};
  for (const a of agents) {
    if (a.status === "dead") continue;
    if (!ownerMap[a.owner]) ownerMap[a.owner] = [];
    ownerMap[a.owner].push(a);
  }

  const owners = Object.entries(ownerMap);
  const topOwners = owners
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 10)
    .map(([address, ags]) => ({
      address,
      agentCount: ags.length,
      topAgent: ags.sort((a, b) => b.score - a.score)[0]?.name ?? "unknown",
    }));

  return {
    uniqueOwners: owners.length,
    topOwners,
    singleAgentOwners: owners.filter(([, a]) => a.length === 1).length,
    multiAgentOwners: owners.filter(([, a]) => a.length > 1).length,
  };
}

function analyzeServices(agents: AgentRecord[]): { service: string; count: number; percentage: string }[] {
  const serviceCounts: Record<string, number> = {};
  const alive = agents.filter(a => a.status !== "dead");

  for (const a of alive) {
    for (const s of a.services) {
      serviceCounts[s] = (serviceCounts[s] || 0) + 1;
    }
  }

  return Object.entries(serviceCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([service, count]) => ({
      service,
      count,
      percentage: pct(count, alive.length),
    }));
}

// ─── History Tracking ────────────────────────────────────────────────────────

function updateHistory(registry: any, agents: AgentRecord[]): HistoryEntry[] {
  let history: HistoryEntry[] = [];
  if (existsSync(HISTORY_FILE)) {
    history = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  }

  const cats: Record<string, number> = {};
  const ownerMap: Record<string, number[]> = {};
  for (const a of agents) {
    if (a.status !== "dead") {
      cats[a.category || "unknown"] = (cats[a.category || "unknown"] || 0) + 1;
      if (!ownerMap[a.owner]) ownerMap[a.owner] = [];
      ownerMap[a.owner].push(a.id);
    }
  }

  const topOwners = Object.entries(ownerMap)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 5)
    .map(([address, ids]) => ({ address, count: ids.length, agents: ids.slice(0, 5) }));

  const entry: HistoryEntry = {
    timestamp: Date.now(),
    date: new Date().toISOString().split("T")[0],
    maxAgentId: registry.maxAgentId,
    total: agents.length,
    active: agents.filter(a => a.status === "active").length,
    legit: agents.filter(a => a.status === "legit").length,
    inactive: agents.filter(a => a.status === "inactive").length,
    dead: agents.filter(a => a.status === "dead").length,
    withA2A: agents.filter(a => a.a2aEndpoint).length,
    a2aReachable: agents.filter(a => a.a2aReachable).length,
    a2aResponds: agents.filter(a => a.a2aResponds).length,
    topCategories: cats,
    topOwners,
  };

  // Only add if date changed or first entry
  const lastDate = history.length > 0 ? history[history.length - 1].date : "";
  if (entry.date !== lastDate) {
    history.push(entry);
  } else {
    history[history.length - 1] = entry; // Update today's entry
  }

  // Keep max 90 days
  if (history.length > 90) {
    history = history.slice(-90);
  }

  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  return history;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   BOB DATABASE — Data & Classification                ║");
  console.log("║   Registry analysis + history tracking                ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  if (!existsSync(DATA_FILE)) {
    console.error(`❌ ${DATA_FILE} not found. Run 'npm run scout' first.`);
    process.exit(1);
  }

  if (!existsSync("data")) mkdirSync("data", { recursive: true });

  const registry = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const agents = Object.values(registry.agents) as AgentRecord[];

  log(`Analyzing ${agents.length} agents (max ID: ${registry.maxAgentId})...\n`);

  // ── Status Breakdown ──────────────────────────────────────────────
  const statusBreakdown: Record<string, number> = {};
  for (const a of agents) {
    statusBreakdown[a.status] = (statusBreakdown[a.status] || 0) + 1;
  }

  console.log("  STATUS BREAKDOWN");
  console.log("  ─────────────────────────────────────");
  for (const [status, count] of Object.entries(statusBreakdown).sort(([, a], [, b]) => b - a)) {
    const bar = "█".repeat(Math.min(30, Math.floor(count / agents.length * 30)));
    console.log(`  ${status.padEnd(12)} ${String(count).padStart(6)}  ${pct(count, agents.length).padStart(6)}  ${bar}`);
  }

  // ── Category Analysis ─────────────────────────────────────────────
  const categories = analyzeCategories(agents);
  console.log("\n  CATEGORIES (non-dead agents)");
  console.log("  ─────────────────────────────────────");
  for (const cat of categories.slice(0, 10)) {
    console.log(`  ${cat.name.padEnd(20)} ${String(cat.count).padStart(5)}  ${cat.percentage.padStart(6)}`);
  }

  // ── Service Adoption ──────────────────────────────────────────────
  const serviceAdoption = analyzeServices(agents);
  console.log("\n  SERVICE ADOPTION");
  console.log("  ─────────────────────────────────────");
  for (const svc of serviceAdoption) {
    console.log(`  ${svc.service.padEnd(20)} ${String(svc.count).padStart(5)}  ${svc.percentage.padStart(6)}`);
  }

  // ── Network Health ────────────────────────────────────────────────
  const withA2A = agents.filter(a => a.a2aEndpoint).length;
  const a2aReachable = agents.filter(a => a.a2aReachable).length;
  const a2aResponds = agents.filter(a => a.a2aResponds).length;

  console.log("\n  NETWORK HEALTH (A2A)");
  console.log("  ─────────────────────────────────────");
  console.log(`  Endpoints declared:  ${withA2A}`);
  console.log(`  Actually reachable:  ${a2aReachable} (${pct(a2aReachable, withA2A)})`);
  console.log(`  Actually responds:   ${a2aResponds} (${pct(a2aResponds, withA2A)})`);

  // ── Owner Analysis ────────────────────────────────────────────────
  const ownerAnalysis = analyzeOwners(agents);
  console.log("\n  OWNER ANALYSIS");
  console.log("  ─────────────────────────────────────");
  console.log(`  Unique owners:       ${ownerAnalysis.uniqueOwners}`);
  console.log(`  Single-agent owners: ${ownerAnalysis.singleAgentOwners}`);
  console.log(`  Multi-agent owners:  ${ownerAnalysis.multiAgentOwners}`);
  console.log("\n  Top owners:");
  for (const o of ownerAnalysis.topOwners.slice(0, 5)) {
    console.log(`    ${o.address.slice(0, 10)}...${o.address.slice(-4)}  ${String(o.agentCount).padStart(4)} agents  (top: ${o.topAgent})`);
  }

  // ── Top Agents ────────────────────────────────────────────────────
  const topAgents = agents
    .filter(a => a.status !== "dead")
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  console.log("\n  TOP 20 AGENTS BY SCORE");
  console.log("  ─────────────────────────────────────────────────────────────");
  console.log("  ID      Name                           Score  Status    A2A");
  console.log("  ─────────────────────────────────────────────────────────────");
  for (const a of topAgents) {
    const a2a = a.a2aResponds ? "✅" : a.a2aReachable ? "🟡" : "❌";
    console.log(`  #${String(a.id).padEnd(6)} ${a.name.slice(0, 30).padEnd(30)} ${String(a.score).padStart(5)}  ${a.status.padEnd(8)}  ${a2a}`);
  }

  // ── Update History ────────────────────────────────────────────────
  log("\nUpdating history...");
  const history = updateHistory(registry, agents);
  log(`History: ${history.length} entries (${history[0]?.date ?? "n/a"} → ${history[history.length - 1]?.date ?? "n/a"})`);

  // ── Trends ────────────────────────────────────────────────────────
  if (history.length >= 2) {
    const prev = history[history.length - 2];
    const curr = history[history.length - 1];
    const newAgents = curr.maxAgentId - prev.maxAgentId;
    const newLegit = curr.legit - prev.legit;

    console.log("\n  TRENDS (vs previous)");
    console.log("  ─────────────────────────────────────");
    console.log(`  New registrations:   +${newAgents}`);
    console.log(`  New legit agents:    ${newLegit >= 0 ? "+" : ""}${newLegit}`);
    console.log(`  A2A reachable:       ${prev.a2aReachable} → ${curr.a2aReachable}`);
  }

  // ── Generate Report ───────────────────────────────────────────────
  const report: DatabaseReport = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalAgents: agents.length,
      maxAgentId: registry.maxAgentId,
      lastScan: new Date(registry.lastScan).toISOString(),
      aliveRate: pct(agents.length - (statusBreakdown["dead"] || 0), agents.length),
      a2aAdoptionRate: pct(withA2A, agents.length),
      legitRate: pct(agents.filter(a => a.status === "legit").length, agents.length),
    },
    categories,
    statusBreakdown,
    serviceAdoption,
    topAgents: topAgents.map(a => ({
      id: a.id,
      name: a.name,
      score: a.score,
      status: a.status,
      category: a.category,
      services: a.services,
      hasA2A: !!a.a2aEndpoint,
    })),
    ownerAnalysis,
    networkHealth: {
      a2aEndpoints: withA2A,
      a2aReachable,
      a2aResponds,
      reachabilityRate: pct(a2aReachable, withA2A),
      responseRate: pct(a2aResponds, withA2A),
    },
    trends: {
      registrationRate: history.length >= 2
        ? `${history[history.length - 1].maxAgentId - history[history.length - 2].maxAgentId} new/day`
        : "first run",
      growthDirection: history.length >= 2
        ? (history[history.length - 1].maxAgentId > history[history.length - 2].maxAgentId ? "growing" : "stable")
        : "unknown",
      previousTotal: history.length >= 2 ? history[history.length - 2].total : null,
      currentTotal: agents.length,
    },
  };

  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  log(`Report saved to ${REPORT_FILE}`);

  // ── Summary ───────────────────────────────────────────────────────
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║   DATABASE SUMMARY                                    ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║   Agents analyzed: ${String(agents.length).padEnd(35)}║`);
  console.log(`║   Alive:           ${String(agents.length - (statusBreakdown["dead"] || 0)).padEnd(35)}║`);
  console.log(`║   Legit (A2A OK):  ${String(agents.filter(a => a.status === "legit").length).padEnd(35)}║`);
  console.log(`║   Categories:      ${String(categories.length).padEnd(35)}║`);
  console.log(`║   Unique owners:   ${String(ownerAnalysis.uniqueOwners).padEnd(35)}║`);
  console.log(`║   History entries: ${String(history.length).padEnd(35)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  process.exit(0);
}

main();
