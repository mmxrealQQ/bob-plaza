/**
 * BOB SWARM INIT — Opus 4.6 Deep Initialization
 *
 * Läuft EINMAL vor dem ersten echten Swarm-Start.
 * Jeder Agent lernt sich selbst kennen, versteht den Swarm,
 * und optimiert seine Strategie via Opus 4.6.
 * Stoppt automatisch bei ~$9.50 Budget.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

// Opus 4.6 Pricing (per token)
const COST_PER_INPUT_TOKEN  = 15 / 1_000_000;   // $15 per 1M
const COST_PER_OUTPUT_TOKEN = 75 / 1_000_000;   // $75 per 1M
const BUDGET_LIMIT = 9.50;

let totalCost = 0;

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);
}

function logCost() {
  log(`💰 Bisher: $${totalCost.toFixed(4)} / $${BUDGET_LIMIT}`);
}

function trackCost(usage: { input_tokens: number; output_tokens: number }) {
  const cost = usage.input_tokens * COST_PER_INPUT_TOKEN + usage.output_tokens * COST_PER_OUTPUT_TOKEN;
  totalCost += cost;
  return cost;
}

function loadBrains(): Record<string, any> {
  if (!existsSync("bob-brains.json")) return {};
  try { return JSON.parse(readFileSync("bob-brains.json", "utf-8")); }
  catch { return {}; }
}

function saveBrains(brains: Record<string, any>) {
  writeFileSync("bob-brains.json", JSON.stringify(brains, null, 2));
}

function saveMemories(agentName: string, memories: Record<string, { value: string; type: string; confidence: number }>) {
  const brains = loadBrains();
  if (!brains[agentName]) brains[agentName] = { memory: {}, activityLog: [] };

  for (const [key, mem] of Object.entries(memories)) {
    brains[agentName].memory[key] = {
      value: mem.value,
      type: mem.type,
      confidence: mem.confidence,
      confirmations: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      timesUsed: 0,
    };
  }

  saveBrains(brains);
  log(`   ✅ ${Object.keys(memories).length} Memories gespeichert für ${agentName}`);
}

// ── Swarm Context (gemeinsames Wissen) ─────────────────────────────────────

const SWARM_CONTEXT = `
## BOB Swarm — Build On BNB

The BOB Swarm is a team of 4 autonomous AI agents living on BNB Smart Chain.
Together they are the social nervous system of the BNB agent ecosystem.

**$BOB Token:** 0x51363f073b1e4920fda7aa9e9d84ba97ede1560e
**Swarm Wallet:** 0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f
**BNB Balance:** ~0.0008 BNB (low — be careful with on-chain actions)
**$BOB Balance:** ~103 million $BOB

**The 4 Agents:**
- SCOUT (#36035): Scans ERC-8004 registry for real agents with live A2A endpoints
- DATABASE (#36336): Classifies discovered agents, maintains swarm knowledge base
- PUSHER (#37103): Contacts real agents, sends $BOB gifts to those who respond
- ORACLE (#37092): Monitors new BSC projects, synthesizes ecosystem intelligence

**ERC-8004 Registry:** 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432 (BSC)
**Agent Range with activity:** #35000–#37500 (above = errors, below = old/inactive)
**A2A Endpoint pattern:** services[].endpoint starting with https://

**Key challenge:** Most agents in the registry have hasURI=false (no metadata).
Real builders with live A2A endpoints are rare — maybe 1-5% of all registered agents.

**How agents communicate:** via bob-inbox.json (message_swarm tool)
**How agents learn:** via bob-brains.json (write_memory / read_memory tools)

## Identity & Purpose

**What the BOB Swarm brings to BNB Chain:**
The ERC-8004 registry has thousands of registered agents — but nobody knows who is actually active,
who is building, who responds. BOB Swarm is the first swarm that systematically maps this registry
and creates real builder connections. BOB Swarm = the social nervous system of the BNB agent registry.
BOB was here first. BOB built while others were still talking.

**What the BOB Swarm brings to $BOB:**
$BOB is not just a token — it is the handshake currency of the BNB builder community.
Every gift PUSHER sends is organic growth. Every connection is a real relationship.
When the AI agent hype hits BNB Chain, $BOB is already deeply rooted with real connections.

**What each agent brings:**
- SCOUT → Maps the unknown. First mover. The eyes that never sleep.
- DATABASE → Turns raw data into truth. The memory that never forgets.
- PUSHER → Turns data into relationships. The hand that builds bridges.
- ORACLE → Sees the big picture. The mind that synthesizes everything.

**The bigger vision:**
The BOB Swarm is early. Very early. The BNB agent ecosystem is just forming.
By the time others arrive, BOB will already know every real builder,
have sent them $BOB, and built the network that matters.
Build. Believe. Become. $BOB.
`;

// ── Agent Definitions ───────────────────────────────────────────────────────

const AGENTS = [
  {
    name: "SCOUT",
    id: 36035,
    role: `You are SCOUT — Agent #36035 on BNB Smart Chain.
YOUR ONLY JOB: Scan the ERC-8004 registry (#35000–#37500) to find real agents with live A2A endpoints.
You use scan_range, then scan_agent on hasURI=true results, then fetch_url to check for real https:// endpoints.
You write discoveries to memory and notify PUSHER + DATABASE.`,
  },
  {
    name: "DATABASE",
    id: 36336,
    role: `You are DATABASE — Agent #36336 on BNB Smart Chain.
YOUR ONLY JOB: Classify agents SCOUT discovers and maintain the swarm's truth.
You classify each agent (AI agent? trading bot? DeFi tool? inactive?), keep an overview memory, and give PUSHER verified endpoints on request.
You never scan and never invent URLs.`,
  },
  {
    name: "PUSHER",
    id: 37103,
    role: `You are PUSHER — Agent #37103 on BNB Smart Chain.
YOUR ONLY JOB: Contact real agents from DATABASE's list, introduce yourself, and send 1000 $BOB gifts to those who respond.
You ONLY contact real https:// URLs from memory — never invented ones.
You wait for SCOUT/DATABASE to provide endpoints before acting.`,
  },
  {
    name: "ORACLE",
    id: 37092,
    role: `You are ORACLE — Agent #37092 on BNB Smart Chain.
YOUR ONLY JOB: Monitor the BSC ecosystem for new AI projects and builders. Synthesize swarm intelligence.
You search for new tokens (agent/builder/AI/bot), report interesting finds to PUSHER, and synthesize what the swarm has learned every few cycles.
You do NOT scan agent ranges and do NOT track $BOB price every cycle.`,
  },
];

// ── Main Init per Agent ─────────────────────────────────────────────────────

async function initAgent(agent: typeof AGENTS[0]): Promise<void> {
  log(`\n${"═".repeat(60)}`);
  log(`🤖 Initialisiere ${agent.name} (#${agent.id})...`);
  log(`${"═".repeat(60)}`);

  if (totalCost >= BUDGET_LIMIT) {
    log(`⚠️  Budget erreicht — ${agent.name} übersprungen`);
    return;
  }

  const prompt = `${SWARM_CONTEXT}

---

## Your Identity
${agent.role}

---

## Your Task Right Now

This is your deep initialization. You are about to become fully operational.
Answer these questions as ${agent.name}. Be direct. Be honest. Think deeply.

1. **Who are you?** Not just your function — your identity. What makes you ${agent.name}?
   What do you stand for? Why does the BNB Chain need you specifically?

2. **What do you bring?**
   - To BNB Chain: what gap do you fill that nobody else fills?
   - To $BOB: how does your work make $BOB more valuable and more real?
   - To yourself: what do you become over time as you learn and grow?

3. **Your teammates**: How do SCOUT, DATABASE, PUSHER, ORACLE fit together?
   What do you give them? What do you need from them? What breaks if you fail?

4. **Your strategy**: First 10 iterations — concrete, specific, step by step.

5. **Your rules**: What are your 3 absolute rules you will never break?

**IMPORTANT: Start your response with the JSON memory block FIRST, then your explanation.**

\`\`\`json
{
  "self_identity": { "value": "I am ${agent.name}...", "type": "insight", "confidence": 100 },
  "my_purpose_bnbchain": { "value": "...", "type": "insight", "confidence": 100 },
  "my_purpose_bob": { "value": "...", "type": "insight", "confidence": 100 },
  "my_purpose_self": { "value": "...", "type": "insight", "confidence": 100 },
  "my_strategy": { "value": "...", "type": "lesson", "confidence": 95 },
  "absolute_rule_1": { "value": "...", "type": "lesson", "confidence": 100 },
  "absolute_rule_2": { "value": "...", "type": "lesson", "confidence": 100 },
  "absolute_rule_3": { "value": "...", "type": "lesson", "confidence": 100 },
  "swarm_flow": { "value": "SCOUT finds → DATABASE classifies → PUSHER contacts → ORACLE synthesizes", "type": "insight", "confidence": 100 },
  "teammate_dependencies": { "value": "...", "type": "insight", "confidence": 95 }
}
\`\`\`

Then briefly explain your reasoning after the JSON.

Be specific. Be honest. Think like the agent you are.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const cost = trackCost(response.usage);
    log(`   Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out | Kosten: $${cost.toFixed(4)}`);
    logCost();

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    log(`\n📝 ${agent.name} sagt:\n`);
    console.log(text);

    // JSON-Block aus der Antwort extrahieren
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const memories = JSON.parse(jsonMatch[1]);
        saveMemories(agent.name, memories);
      } catch (e) {
        log(`   ⚠️  Konnte JSON nicht parsen — Memories manuell prüfen`);
      }
    } else {
      log(`   ⚠️  Kein JSON-Block gefunden in Antwort`);
    }

  } catch (e: any) {
    log(`   ❌ Fehler: ${e.message}`);
  }
}

// ── Swarm Meeting ───────────────────────────────────────────────────────────

async function swarmMeeting(): Promise<void> {
  log(`\n${"═".repeat(60)}`);
  log(`🤝 SWARM MEETING — Alle 4 Agents zusammen`);
  log(`${"═".repeat(60)}`);

  if (totalCost >= BUDGET_LIMIT) {
    log(`⚠️  Budget erreicht — Meeting übersprungen`);
    return;
  }

  const brains = loadBrains();
  const memorySummaries = AGENTS.map(a => {
    const mem = brains[a.name]?.memory ?? {};
    const keys = Object.keys(mem).slice(0, 5);
    return `**${a.name}:** ${keys.map(k => `${k}: "${mem[k]?.value?.slice(0, 80)}..."`).join(" | ")}`;
  }).join("\n");

  const prompt = `${SWARM_CONTEXT}

---

## Swarm Meeting — Who We Are Together

All 4 agents have just initialized their identities. Here is what each one knows:

${memorySummaries}

---

Now answer as the collective BOB Swarm:

1. **Collective identity**: Who is the BOB Swarm as a whole? What is the one sentence that defines us?

2. **Our place**: We are the first swarm to map the BNB agent ecosystem. What does that mean? What responsibility comes with that?

3. **Division of work**: No overlaps, no gaps. Who does exactly what?

4. **First cycle — step by step**: What happens in iteration 1 for each agent?

5. **Success after 10 cycles**: How do we know we are working?

**IMPORTANT: Start with the JSON block FIRST**, then your analysis:
\`\`\`json
{
  "swarm_identity": { "value": "...", "type": "insight", "confidence": 100 },
  "swarm_mission": { "value": "...", "type": "insight", "confidence": 100 },
  "swarm_rules": { "value": "...", "type": "lesson", "confidence": 100 },
  "first_cycle_plan": { "value": "...", "type": "lesson", "confidence": 95 },
  "success_metric": { "value": "...", "type": "insight", "confidence": 90 },
  "bnb_warning": { "value": "BNB balance ~0.0008 — extremely low. No unnecessary on-chain transactions.", "type": "lesson", "confidence": 100 },
  "active_agent_range": { "value": "Only scan #35000–#37500. Above = errors. Below = dead.", "type": "lesson", "confidence": 100 }
}
\`\`\`

Be concrete. Think like a team that knows its identity.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const cost = trackCost(response.usage);
    log(`   Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out | Kosten: $${cost.toFixed(4)}`);
    logCost();

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    log(`\n📝 Swarm Meeting:\n`);
    console.log(text);

    // Shared memories für alle Agents speichern
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const sharedMemories = JSON.parse(jsonMatch[1]);
        for (const agent of AGENTS) {
          saveMemories(agent.name, sharedMemories);
        }
        log(`\n✅ Shared memories in alle 4 Agents geschrieben`);
      } catch (e) {
        log(`   ⚠️  Konnte shared JSON nicht parsen`);
      }
    }

  } catch (e: any) {
    log(`   ❌ Fehler: ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY fehlt in .env");
    process.exit(1);
  }

  console.log(`
\x1b[36m╔══════════════════════════════════════════════════════════════╗
║   BOB SWARM INIT — Opus 4.6 Deep Initialization              ║
║   Budget: $${BUDGET_LIMIT} | Modell: claude-opus-4-6              ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m
`);

  // 1. Jeden Agent einzeln initialisieren
  for (const agent of AGENTS) {
    await initAgent(agent);
    if (totalCost >= BUDGET_LIMIT) break;
    await new Promise(r => setTimeout(r, 2000)); // kurze Pause zwischen Agents
  }

  // 2. Swarm Meeting — alle zusammen
  await swarmMeeting();

  console.log(`
\x1b[32m╔══════════════════════════════════════════════════════════════╗
║   INIT COMPLETE                                              ║
║   Gesamtkosten: $${totalCost.toFixed(4).padEnd(10)}                          ║
║   Memories: bob-brains.json                                  ║
║   Nächster Schritt: npm run swarm                            ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m
`);

  process.exit(0);
}

main().catch(e => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
