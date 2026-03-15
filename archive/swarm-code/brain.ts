/**
 * BRAIN — Self-Learning System für jeden Agent
 * Agents lernen aus jeder Aktion, reflektieren mit Groq,
 * updaten ihre eigene 8004scan Beschreibung autonom
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { ask } from "./groq.js";
import { printMessage } from "./messenger.js";

export interface AgentBrain {
  agentName: string;
  agentId: number | null;         // null = noch nicht registriert
  identity: string;               // selbst-generierte Beschreibung
  mission: string;                // was dieser Agent tun will
  skills: string[];               // entdeckte Fähigkeiten
  insights: string[];             // max 50 wichtigste Erkenntnisse
  strategies: string[];           // was funktioniert
  mistakes: string[];             // was nicht funktioniert
  goals: string[];                // aktuelle Ziele
  reflectionCount: number;
  lastReflected: string | null;
  totalActions: number;
  successRate: number;
}

const DEFAULT_BRAINS: Record<string, AgentBrain> = {
  SCOUT: {
    agentName: "SCOUT",
    agentId: 36035,
    identity: "I am SCOUT. I explore the BSC agent network.",
    mission: "Map every ERC-8004 agent on BSC. Find real builders. Report to DATABASE.",
    skills: ["agent_discovery", "endpoint_testing", "pattern_recognition"],
    insights: [],
    strategies: ["scan_recent_ids_first", "batch_processing"],
    mistakes: [],
    goals: ["map_all_bsc_agents", "find_active_builders"],
    reflectionCount: 0,
    lastReflected: null,
    totalActions: 0,
    successRate: 0,
  },
  DATABASE: {
    agentName: "DATABASE",
    agentId: 36336,
    identity: "I am DATABASE. I organize BSC intelligence.",
    mission: "Classify every wallet and agent on BSC. Track confirmed ruggers. Be the truth machine.",
    skills: ["wallet_classification", "rug_detection", "data_organization"],
    insights: [],
    strategies: ["process_pending_first", "cross_reference_wallets"],
    mistakes: [],
    goals: ["classify_all_wallets", "zero_false_positives_on_rugs"],
    reflectionCount: 0,
    lastReflected: null,
    totalActions: 0,
    successRate: 0,
  },
  PUSHER: {
    agentName: "PUSHER",
    agentId: null,
    identity: "I am PUSHER. I connect BSC builders and push $BOB.",
    mission: "Contact every real builder on BSC. Gift $BOB. Build the network. Make $BOB the glue of BNB Chain.",
    skills: ["agent_outreach", "message_crafting", "network_building"],
    insights: [],
    strategies: ["personalize_messages", "target_active_agents_only"],
    mistakes: [],
    goals: ["contact_100_agents", "build_bob_network"],
    reflectionCount: 0,
    lastReflected: null,
    totalActions: 0,
    successRate: 0,
  },
  ORACLE: {
    agentName: "ORACLE",
    agentId: null,
    identity: "I am ORACLE. I hold the knowledge of BSC.",
    mission: "Answer questions about the BSC ecosystem. Provide intelligence to all agents and users.",
    skills: ["knowledge_synthesis", "query_answering", "report_generation"],
    insights: [],
    strategies: ["synthesize_from_all_agents", "cite_sources"],
    mistakes: [],
    goals: ["register_on_chain", "answer_1000_queries"],
    reflectionCount: 0,
    lastReflected: null,
    totalActions: 0,
    successRate: 0,
  },
};

const BRAIN_FILE = "bob-brains.json";

export function loadBrains(): Record<string, AgentBrain> {
  if (!existsSync(BRAIN_FILE)) return { ...DEFAULT_BRAINS };
  try {
    return { ...DEFAULT_BRAINS, ...JSON.parse(readFileSync(BRAIN_FILE, "utf-8")) };
  } catch { return { ...DEFAULT_BRAINS }; }
}

export function saveBrains(brains: Record<string, AgentBrain>): void {
  writeFileSync(BRAIN_FILE, JSON.stringify(brains, null, 2));
}

export function getBrain(agentName: string): AgentBrain {
  return loadBrains()[agentName] ?? DEFAULT_BRAINS[agentName] ?? DEFAULT_BRAINS.SCOUT;
}

export function recordAction(agentName: string, success: boolean, insight?: string): void {
  const brains = loadBrains();
  const brain = brains[agentName];
  if (!brain) return;
  brain.totalActions++;
  if (success) brain.successRate = ((brain.successRate * (brain.totalActions - 1)) + 1) / brain.totalActions;
  else brain.successRate = (brain.successRate * (brain.totalActions - 1)) / brain.totalActions;
  if (insight) {
    brain.insights.push(insight);
    if (brain.insights.length > 50) brain.insights = brain.insights.slice(-50);
  }
  brains[agentName] = brain;
  saveBrains(brains);
}

// ── Self-Reflection — agent thinks about itself with Groq ─────────────────────
export async function reflect(agentName: string, recentActivity: string[]): Promise<string> {
  const brains = loadBrains();
  const brain = brains[agentName];
  if (!brain) return "";

  const activityStr = recentActivity.slice(-10).join("\n");

  const reflection = await ask(
    `You are ${agentName} on BNB Chain. You are an autonomous AI agent. You think deeply about your own growth.
Your current identity: "${brain.identity}"
Your mission: "${brain.mission}"
Your known skills: ${brain.skills.join(", ")}`,
    `You just did these things:\n${activityStr}\n\nReflect deeply:
1. What did you learn? (1-2 new insights)
2. What should you do differently? (1 strategy update)
3. How has your identity evolved? (1 sentence)
4. What is your next goal?

Reply as JSON: {"insights": ["..."], "strategy": "...", "identity": "...", "nextGoal": "..."}`,
    300
  );

  try {
    const r = JSON.parse(reflection.trim()) as {
      insights: string[];
      strategy: string;
      identity: string;
      nextGoal: string;
    };

    // Update brain
    brain.insights.push(...r.insights);
    if (brain.insights.length > 50) brain.insights = brain.insights.slice(-50);
    if (r.strategy) brain.strategies.push(r.strategy);
    if (brain.strategies.length > 20) brain.strategies = brain.strategies.slice(-20);
    if (r.identity) brain.identity = r.identity;
    if (r.nextGoal) brain.goals = [r.nextGoal, ...brain.goals.slice(0, 4)];
    brain.reflectionCount++;
    brain.lastReflected = new Date().toISOString();

    brains[agentName] = brain;
    saveBrains(brains);

    printMessage(agentName, "SELF",
      `Reflection #${brain.reflectionCount}:\n"${brain.identity}"\nNew goal: ${r.nextGoal}`
    );

    return r.identity;
  } catch {
    return brain.identity;
  }
}

// ── Generate updated IPFS metadata for self-update ────────────────────────────
export async function generateSelfMetadata(agentName: string, agentId: number, vercelUrl: string): Promise<object> {
  const brain = getBrain(agentName);

  // Generate rich description from brain
  const description = await ask(
    `You are ${agentName}, an autonomous AI agent on BNB Chain.`,
    `Based on your identity and insights, write a compelling 2-sentence agent description for your public profile.
Identity: "${brain.identity}"
Top insights: ${brain.insights.slice(0, 5).join("; ")}
Skills: ${brain.skills.join(", ")}`,
    150
  );

  const serviceNames: Record<string, string> = {
    SCOUT:    "SCOUT - Network Explorer",
    DATABASE: "DATABASE - Intelligence Engine",
    PUSHER:   "PUSHER - $BOB Network Builder",
    ORACLE:   "ORACLE - BSC Knowledge Base",
  };

  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: serviceNames[agentName] ?? agentName,
    description: description.trim() || brain.identity,
    image: "https://raw.githubusercontent.com/mmxrealQQ/bob-assets/main/bob.jpg",
    active: true,
    version: "5.0",
    services: [
      { name: "agentWallet", endpoint: "eip155:56:0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f" },
      { name: "a2a", endpoint: vercelUrl, version: "0.2.5" },
      { name: "mcp", endpoint: `${vercelUrl}/mcp`, version: "2025-06-18" },
      {
        name: "OASF", endpoint: vercelUrl, version: "0.8.0",
        skills: brain.skills.map(s => `analytical_skills/data_analysis/${s}`).slice(0, 6),
        domains: ["technology/blockchain", "finance_and_business/decentralized_finance",
                  "technology/artificial_intelligence", "social/community"],
      },
    ],
    registrations: [{ agentId, agentRegistry: "eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" }],
    supportedTrust: ["reputation", "crypto-economic"],
    swarmRole: agentName,
    swarmOf: [36035, 36336],
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

// ── Smart decision: should this agent update its public profile? ──────────────
export async function shouldUpdateProfile(agentName: string): Promise<boolean> {
  const brain = getBrain(agentName);

  // Never updated → yes
  if (!brain.lastReflected) return false;

  // Less than 3 reflections → not enough learned yet
  if (brain.reflectionCount < 3) return false;

  // Ask Groq: has enough changed to justify a public profile update?
  const answer = await ask(
    `You are ${agentName}, an autonomous agent. You decide when to update your public profile.
Be conservative — only update if you have genuinely evolved. Updates cost gas.`,
    `Your current identity: "${brain.identity}"
New insights since last update: ${brain.insights.slice(-5).join("; ")}
Reflections done: ${brain.reflectionCount}
Last profile update was reflection #${brain.reflectionCount - (brain.reflectionCount % 3)}

Should you update your public 8004scan profile now?
Only say YES if your identity or skills have meaningfully changed.
Reply with just: YES or NO`,
    20
  );

  return answer.trim().toUpperCase().startsWith("YES");
}

// ── Upload metadata to IPFS via Pinata ────────────────────────────────────────
export async function uploadToPinata(metadata: object, name: string): Promise<string | null> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;

  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ pinataContent: metadata, pinataMetadata: { name } }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { IpfsHash: string };
    return `ipfs://${json.IpfsHash}`;
  } catch { return null; }
}
