/**
 * Build Registry Snapshot
 *
 * Reads data/agent-registry.json (SCOUT output) + data/external-agents.json
 * and generates api/registry-data.ts for the Vercel deployment.
 *
 * BSC agents: keyed by token ID (1–50.000)
 * External agents: keyed by chain:tokenId (e.g. "base:2355") — real on-chain IDs
 *
 * Usage: npm run build-snapshot
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const BSC_INPUT = "data/agent-registry.json";
const EXT_INPUT = "data/external-agents.json";
const OUTPUT = "api/registry-data.ts";

if (!existsSync(BSC_INPUT)) {
  console.error(`❌ ${BSC_INPUT} not found. Run 'npm run scout' first.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(BSC_INPUT, "utf-8"));

// Strip tokenURI from BSC snapshot + tag with network/source
const agents: Record<string, any> = {};
for (const [id, agent] of Object.entries(data.agents) as [string, any][]) {
  const { tokenURI, ...rest } = agent;
  agents[id] = {
    ...rest,
    network: rest.network || "bsc",
    source: rest.source || "erc8004",
  };
}

let extCount = 0;

// Merge external agents (if file exists and has data)
if (existsSync(EXT_INPUT)) {
  try {
    const extData = JSON.parse(readFileSync(EXT_INPUT, "utf-8"));
    const extAgentCount = Object.keys(extData.agents || {}).length;
    if (extAgentCount > 0) {
      for (const [id, agent] of Object.entries(extData.agents) as [string, any][]) {
        agents[id] = {
          ...agent,
          network: agent.network || "open-a2a",
          source: agent.source || "curated",
        };
        extCount++;
      }
      console.log(`📡 Merged ${extCount} external agents from ${EXT_INPUT}`);
    } else {
      console.log(`⚠️  ${EXT_INPUT} has 0 agents — skipping merge (scan may have failed)`);
    }
  } catch (e: any) {
    console.log(`⚠️  Could not load ${EXT_INPUT}: ${e.message}`);
  }
}

// Compute stats from merged agents
const allAgents = Object.values(agents) as any[];
const bscAgents = allAgents.filter(a => a.network === "bsc");
const extAgents = allAgents.filter(a => a.network === "open-a2a");

const snapshot = {
  lastScan: data.lastScan,
  totalScanned: data.totalScanned,
  maxAgentId: data.maxAgentId,
  agents,
  stats: {
    total: bscAgents.length,
    active: bscAgents.filter((a: any) => a.status === "active").length,
    legit: bscAgents.filter((a: any) => a.status === "legit").length,
    inactive: bscAgents.filter((a: any) => a.status === "inactive").length,
    spam: bscAgents.filter((a: any) => a.status === "spam").length,
    dead: bscAgents.filter((a: any) => a.status === "dead").length,
    withA2A: bscAgents.filter((a: any) => a.a2aEndpoint).length,
    withAgentCard: bscAgents.filter((a: any) => a.hasAgentCard).length,
    a2aReachable: bscAgents.filter((a: any) => a.a2aReachable).length,
    a2aResponds: bscAgents.filter((a: any) => a.a2aResponds).length,
    // External stats
    externalTotal: extAgents.length,
    externalReachable: extAgents.filter((a: any) => a.a2aReachable).length,
    externalResponds: extAgents.filter((a: any) => a.a2aResponds).length,
    externalWithCard: extAgents.filter((a: any) => a.hasAgentCard).length,
  },
};

// Read the current file to preserve the types and helper functions
const current = readFileSync(OUTPUT, "utf-8");
const marker = "// ─── Snapshot (auto-generated, do not edit manually)";
const markerEnd = "// ─── Lookup helpers";

const before = current.split(marker)[0];
const after = current.split(markerEnd).slice(1).join(markerEnd);

const agentEntries = Object.entries(snapshot.agents)
  .map(([id, a]) => `    "${id}": ${JSON.stringify(a)}`)
  .join(",\n");

const newContent = `${before}${marker} ─────────────────────────

export const REGISTRY: RegistrySnapshot = {
  lastScan: ${snapshot.lastScan},
  totalScanned: ${snapshot.totalScanned},
  maxAgentId: ${snapshot.maxAgentId},
  agents: {
${agentEntries},
  },
  stats: ${JSON.stringify(snapshot.stats, null, 4).replace(/\n/g, "\n  ")},
};

${markerEnd}${after}`;

writeFileSync(OUTPUT, newContent);
console.log(`✅ Updated ${OUTPUT} with ${bscAgents.length} BSC + ${extAgents.length} external agents`);
