/**
 * BOB BRAIN v8 — Dual-LLM Intelligence Layer
 *
 * The brain that makes BOB's agents THINK, LEARN, and EVOLVE.
 * Uses Groq LLM for fast decisions, Anthropic Haiku for deep analysis.
 * Builds knowledge from registry data and sells intelligence reports.
 *
 * Every agent cycle: Think → Act → Learn → Evolve → Know
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AgentName = "BEACON" | "SCHOLAR" | "SYNAPSE" | "PULSE";

export interface ThinkContext {
  agentStats?: Record<string, any>;
  lastResult?: { success: boolean; duration: number; output: string };
  registryStats?: Record<string, number>;
  externalStats?: Record<string, number>;
  bnbPrice?: number;
  bscTvl?: number;
  reachableAgents?: number;
  totalAgents?: number;
  customContext?: string;
}

export interface ThinkResult {
  action: string;
  reason: string;
  params: Record<string, any>;
  priority: number;
  insightForOthers?: string;
}

interface A2AFailure {
  ts: number;
  reason: string;
  httpStatus?: number;
}

interface AgentRelationship {
  agentId: number;
  name: string;
  endpoint: string;
  firstContact: number;
  lastContact: number;
  messagesSent: number;
  responses: number;
  topics: string[];
  notes: string;
  // v7.1: Agent Personality Memory
  personality?: string;
  capabilities?: string[];
  lastResponse?: string;
  responseSummaries?: string[];
  // v7.2: A2A Failure Memory
  a2aFailures?: A2AFailure[];
  a2aFailCount?: number;
  a2aSuccessCount?: number;
  a2aDead?: boolean;
  a2aDeadReason?: string;
  lastFailure?: string;
  // v8: Graduated health — learn from interaction patterns
  avgResponseTimeMs?: number;
  successRate?: number;             // 0-1 rolling average
  healthScore?: number;             // 0-100 computed
  formatStats?: Record<string, { sent: number; replied: number }>;  // best message format per agent
}

// v8: Decision outcome tracking — close the feedback loop
interface DecisionOutcome {
  ts: number;
  agent: AgentName;
  decision: string;
  reason: string;
  success: boolean;
  duration: number;
  keyMetric?: number;   // agents found, knowledge gained, etc.
}

// ─── v7.1: Knowledge Types ─────────────────────────────────────────────────

interface KnowledgeSnapshot {
  generatedAt: number;
  totalAgents: number;
  activeAgents: number;
  categoryCounts: Record<string, number>;
  a2aResponders: number;
  a2aReachable: number;
  scoreDistribution: { above50: number; above70: number; above90: number };
  ownerClusters: Record<string, number>;
  topOwners: Array<{ wallet: string; count: number }>;
  externalAgents: number;
  previousSnapshot?: { totalAgents: number; activeAgents: number; a2aResponders: number; generatedAt: number };
  trends?: { agentGrowth: number; activeGrowth: number; a2aGrowth: number };
}

interface Discovery {
  ts: number;
  agent: AgentName;
  type: string;
  content: string;
  importance: number;
}

interface PerformanceEntry {
  ts: number;
  agent: AgentName;
  action: string;
  duration: number;
  success: boolean;
  newAgents?: number;
  responsesGot?: number;
}

interface AgentMessage {
  ts: number;
  from: AgentName;
  to: AgentName;
  type: "discovery" | "request" | "insight" | "alert";
  content: string;
  read: boolean;
}

interface Strategies {
  beacon: {
    bscIntervalMin: number;
    extIntervalMin: number;
    focusChains: string[];
    yieldHistory: number[];
    lastDecision: string;
  };
  synapse: {
    greetingStyle: string;
    followUpHours: number;
    priorityCategories: string[];
    responseRate: number;
    lastDecision: string;
  };
  pulse: {
    checkIntervalMin: number;
    monitorFocus: string[];
    alertThresholdPct: number;
    lastDecision: string;
  };
  scholar: {
    trendWindowDays: number;
    insightGeneration: boolean;
    lastDecision: string;
  };
}

interface BrainMemory {
  version: number;
  createdAt: number;
  lastThought: number;
  totalThoughts: number;
  totalEvolutions: number;

  strategies: Strategies;
  relationships: Record<string, AgentRelationship>;
  discoveries: Discovery[];
  performance: PerformanceEntry[];
  inbox: AgentMessage[];
  insights: string[];
  // v7.1
  knowledge?: KnowledgeSnapshot;
  // v7.2: Update tracking
  lastOnChainUpdate?: number;
  featuresSinceUpdate?: string[];
  a2aFailurePatterns?: Record<string, { count: number; lastReason: string; firstSeen: number }>;
  // v8: Closed feedback loop — decisions + outcomes
  decisionLog?: DecisionOutcome[];
  lastEvolution?: {
    ts: number;
    changes: Array<{ target: string; field: string; oldValue: any; newValue: any }>;
    successRateBefore: number;
    avgDurationBefore: number;
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BRAIN_FILE = "data/brain.json";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_DISCOVERIES = 200;
const MAX_PERFORMANCE = 500;
const MAX_INSIGHTS = 100;
const MAX_INBOX = 50;
const REGISTRY_FILE = "data/agent-registry.json";
const EXTERNAL_FILE = "data/external-agents.json";

const DEFAULT_STRATEGIES: Strategies = {
  beacon: {
    bscIntervalMin: 240,
    extIntervalMin: 480,
    focusChains: ["bsc"],
    yieldHistory: [],
    lastDecision: "initial",
  },
  synapse: {
    greetingStyle: "friendly_collaborative",
    followUpHours: 48,
    priorityCategories: ["defi", "ai", "infrastructure"],
    responseRate: 0,
    lastDecision: "initial",
  },
  pulse: {
    checkIntervalMin: 120,
    monitorFocus: ["health", "bnb_price", "network_growth"],
    alertThresholdPct: 10,
    lastDecision: "initial",
  },
  scholar: {
    trendWindowDays: 7,
    insightGeneration: true,
    lastDecision: "initial",
  },
};

// ─── Brain Class ────────────────────────────────────────────────────────────

export class Brain {
  public memory: BrainMemory;
  private groqKey: string;
  private anthropicKey: string;
  private dirty = false;

  constructor() {
    this.groqKey = process.env.GROQ_API_KEY || "";
    this.anthropicKey = process.env.ANTHROPIC_API_KEY || "";
    this.memory = this.load();
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private load(): BrainMemory {
    if (existsSync(BRAIN_FILE)) {
      try {
        const data = JSON.parse(readFileSync(BRAIN_FILE, "utf-8"));
        // Merge with defaults for any missing fields
        return {
          ...this.createDefault(),
          ...data,
          strategies: { ...DEFAULT_STRATEGIES, ...data.strategies },
        };
      } catch {
        console.log("[BRAIN] Could not load memory, starting fresh");
      }
    }
    return this.createDefault();
  }

  private createDefault(): BrainMemory {
    return {
      version: 1,
      createdAt: Date.now(),
      lastThought: 0,
      totalThoughts: 0,
      totalEvolutions: 0,
      strategies: { ...DEFAULT_STRATEGIES },
      relationships: {},
      discoveries: [],
      performance: [],
      inbox: [],
      insights: [],
    };
  }

  save(): void {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    // Trim arrays before saving
    if (this.memory.discoveries.length > MAX_DISCOVERIES)
      this.memory.discoveries = this.memory.discoveries.slice(-MAX_DISCOVERIES);
    if (this.memory.performance.length > MAX_PERFORMANCE)
      this.memory.performance = this.memory.performance.slice(-MAX_PERFORMANCE);
    if (this.memory.insights.length > MAX_INSIGHTS)
      this.memory.insights = this.memory.insights.slice(-MAX_INSIGHTS);
    if (this.memory.inbox.length > MAX_INBOX)
      this.memory.inbox = this.memory.inbox.slice(-MAX_INBOX);

    writeFileSync(BRAIN_FILE, JSON.stringify(this.memory, null, 2));
    this.dirty = false;
  }

  // ── LLM Thinking ───────────────────────────────────────────────────────

  async think(agent: AgentName, context: ThinkContext): Promise<ThinkResult> {
    try {
      return await this.llmThink(agent, context);
    } catch (e: any) {
      console.log(`[BRAIN] LLM think failed (${e.message}), using default`);
      return this.defaultDecision(agent);
    }
  }

  // v8: Load relevant knowledge from Scholar's knowledge base
  private getRelevantKnowledge(agent: AgentName): string {
    const KNOWLEDGE_FILE = "data/knowledge.json";
    if (!existsSync(KNOWLEDGE_FILE)) return "";
    try {
      const kb = JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8"));
      const entries = kb.entries as Array<{ question?: string; answer?: string; topic?: string; agentId?: number; agentName?: string }>;
      if (!entries?.length) return "";

      // Filter by relevance to the agent's domain
      const relevanceMap: Record<AgentName, string[]> = {
        BEACON:  ["discover", "register", "new agent", "endpoint", "a2a", "erc-8004", "invitation"],
        SCHOLAR: ["knowledge", "learn", "capability", "expertise", "build", "bnb"],
        SYNAPSE: ["connect", "collaborat", "partner", "synerg", "introduc", "relationship"],
        PULSE:   ["health", "status", "uptime", "monitor", "metric", "tvl", "price"],
      };

      const keywords = relevanceMap[agent] || [];
      const relevant = entries
        .filter(e => {
          const text = `${e.question || ""} ${e.answer || ""} ${e.topic || ""}`.toLowerCase();
          return keywords.some(kw => text.includes(kw));
        })
        .slice(-5);

      if (relevant.length === 0) {
        // Fallback: return latest 3 entries
        return entries.slice(-3)
          .map(e => `- ${e.agentName || "Agent"}: "${(e.answer || "").slice(0, 100)}"`)
          .join("\n");
      }

      return relevant
        .map(e => `- ${e.agentName || "Agent"}: "${(e.answer || "").slice(0, 100)}"`)
        .join("\n");
    } catch { return ""; }
  }

  private async llmThink(agent: AgentName, ctx: ThinkContext): Promise<ThinkResult> {
    const strategy = this.memory.strategies[agent.toLowerCase() as keyof Strategies];
    const recentPerf = this.memory.performance
      .filter(p => p.agent === agent)
      .slice(-5);
    const pendingMessages = this.memory.inbox
      .filter(m => m.to === agent && !m.read)
      .map(m => `[${m.from}→${m.to}] ${m.content}`);
    const recentInsights = this.memory.insights.slice(-5);

    const agentRoles: Record<AgentName, string> = {
      BEACON: "Discovers new AI agents on BNB Chain via EIP-8004 registry. Tests A2A endpoints. Sends personalized invitations to join BOB Plaza.",
      SCHOLAR: "Visits all known agents, generates smart questions using LLM, builds collective knowledge base from their answers.",
      SYNAPSE: "Finds compatible agent pairs by category, introduces them to each other, maintains relationships via check-ins every 48h.",
      PULSE: "Monitors network health by pinging agents, fetches BNB price & BSC TVL, tracks growth metrics, saves 90-day history.",
    };

    // v8: Build decision history for this agent
    const decisionHistory = (this.memory.decisionLog || [])
      .filter(d => d.agent === agent)
      .slice(-5)
      .map(d => `- "${d.decision}" → ${d.success ? "✅ SUCCESS" : "❌ FAILED"}, ${(d.duration / 1000).toFixed(0)}s${d.keyMetric ? `, metric: ${d.keyMetric}` : ""}`)
      .join("\n") || "No decision history yet";

    // v8: Load Scholar knowledge relevant to this agent
    const knowledgeContext = this.getRelevantKnowledge(agent);

    const prompt = `You are the BRAIN of BOB — an autonomous AI agent intelligence network on BNB Chain.
BOB has 4 agents: BEACON (discovery), SCHOLAR (knowledge), SYNAPSE (connections), PULSE (health).
Your mission: Grow BOB Plaza into the largest AI agent collaboration network on BNB Chain.

Current agent: ${agent}
Role: ${agentRoles[agent]}

Current strategy: ${JSON.stringify(strategy)}

DECISION HISTORY (what was tried before + what happened):
${decisionHistory}
IMPORTANT: Learn from this. Don't repeat failed approaches. Double down on what works.

Recent performance (last 5 runs):
${recentPerf.length > 0 ? recentPerf.map(p => `- ${new Date(p.ts).toISOString().slice(11,16)} ${p.action}: ${p.success ? "✅" : "❌"} ${p.duration}ms${p.newAgents ? ` +${p.newAgents} agents` : ""}`).join("\n") : "No previous runs yet"}

Context:
- Total BSC agents: ${ctx.totalAgents ?? "unknown"}
- Reachable A2A agents: ${ctx.reachableAgents ?? "unknown"}
- BNB price: $${ctx.bnbPrice ?? "unknown"}
- BSC TVL: $${ctx.bscTvl ? (ctx.bscTvl / 1e9).toFixed(1) + "B" : "unknown"}
${ctx.customContext ? `- ${ctx.customContext}` : ""}
${knowledgeContext ? `\nKnowledge from Scholar:\n${knowledgeContext}` : ""}

Messages from other agents:
${pendingMessages.length > 0 ? pendingMessages.join("\n") : "None"}

Recent insights:
${recentInsights.length > 0 ? recentInsights.slice(-3).join("\n") : "None yet"}

Brain stats: ${this.memory.totalThoughts} thoughts, ${this.memory.totalEvolutions} evolutions, ${Object.keys(this.memory.relationships).length} relationships

Decide what ${agent} should do RIGHT NOW. Consider: past decision outcomes, timing, messages.

Respond ONLY with JSON (no markdown, no explanation outside JSON):
{
  "action": "string — what to do (e.g. scan_bsc, scan_external, analyze, contact_agents, health_check, generate_report, skip, wait)",
  "reason": "1-2 sentences why",
  "params": {},
  "priority": 1-10,
  "insightForOthers": "optional: a useful insight to share with other agents"
}`;

    const response = await this.callGroq(prompt);
    if (!response) return this.defaultDecision(agent);

    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      }
      const parsed = JSON.parse(jsonStr);
      this.memory.totalThoughts++;
      this.memory.lastThought = Date.now();

      // Mark messages as read
      this.memory.inbox
        .filter(m => m.to === agent && !m.read)
        .forEach(m => (m.read = true));

      // Store insight if provided
      if (parsed.insightForOthers) {
        this.memory.insights.push(`[${agent}] ${parsed.insightForOthers}`);
      }

      // Update strategy with last decision
      const strat = this.memory.strategies[agent.toLowerCase() as keyof Strategies] as any;
      if (strat) strat.lastDecision = parsed.action;

      this.save();

      return {
        action: parsed.action || "default",
        reason: parsed.reason || "No reason given",
        params: parsed.params || {},
        priority: parsed.priority || 5,
        insightForOthers: parsed.insightForOthers,
      };
    } catch {
      console.log("[BRAIN] Could not parse LLM response, using default");
      return this.defaultDecision(agent);
    }
  }

  private defaultDecision(agent: AgentName): ThinkResult {
    const defaults: Record<AgentName, ThinkResult> = {
      BEACON: { action: "discover_agents", reason: "Default: discover new agents on BNB Chain", params: {}, priority: 5 },
      SCHOLAR: { action: "learn_from_agents", reason: "Default: learn from known agents", params: {}, priority: 4 },
      SYNAPSE: { action: "connect_agents", reason: "Default: introduce compatible agents", params: {}, priority: 4 },
      PULSE: { action: "health_check", reason: "Default: monitor network health", params: {}, priority: 3 },
    };
    return defaults[agent];
  }

  // ── Learning ────────────────────────────────────────────────────────────

  learn(agent: AgentName, action: string, result: { success: boolean; duration: number; output: string }): void {
    // Store performance
    const entry: PerformanceEntry = {
      ts: Date.now(),
      agent,
      action,
      duration: result.duration,
      success: result.success,
    };

    // Extract metrics from output
    const newAgentsMatch = result.output.match(/Found (\d+) new/i) || result.output.match(/\+(\d+) agents/i);
    if (newAgentsMatch) {
      entry.newAgents = parseInt(newAgentsMatch[1]);
      if (agent === "BEACON") {
        this.memory.strategies.beacon.yieldHistory.push(entry.newAgents);
        if (this.memory.strategies.beacon.yieldHistory.length > 20)
          this.memory.strategies.beacon.yieldHistory.shift();
      }
    }

    const responsesMatch = result.output.match(/(\d+) respond/i) || result.output.match(/responses?: (\d+)/i);
    if (responsesMatch) {
      entry.responsesGot = parseInt(responsesMatch[1]);
      if (agent === "SYNAPSE" && entry.responsesGot !== undefined) {
        const sentMatch = result.output.match(/sent (\d+)/i) || result.output.match(/introductions?: (\d+)/i);
        if (sentMatch) {
          const sent = parseInt(sentMatch[1]);
          if (sent > 0) {
            this.memory.strategies.synapse.responseRate =
              Math.round((entry.responsesGot / sent) * 100) / 100;
          }
        }
      }
    }

    this.memory.performance.push(entry);

    // v8: Store decision outcome — close the feedback loop
    if (!this.memory.decisionLog) this.memory.decisionLog = [];
    const strat = this.memory.strategies[agent.toLowerCase() as keyof Strategies] as any;
    this.memory.decisionLog.push({
      ts: Date.now(),
      agent,
      decision: strat?.lastDecision || action,
      reason: "",
      success: result.success,
      duration: result.duration,
      keyMetric: entry.newAgents ?? entry.responsesGot,
    });
    if (this.memory.decisionLog.length > 50) this.memory.decisionLog = this.memory.decisionLog.slice(-50);

    this.extractDiscoveries(agent, result.output);
    this.save();
  }

  private extractDiscoveries(agent: AgentName, output: string): void {
    // Look for interesting patterns in agent output
    const lines = output.split("\n");
    for (const line of lines) {
      // New A2A agent found
      if (line.includes("✅") && line.includes("#") && line.includes("Score:")) {
        const idMatch = line.match(/#(\d+)/);
        const nameMatch = line.match(/"([^"]+)"/);
        if (idMatch && nameMatch) {
          this.memory.discoveries.push({
            ts: Date.now(),
            agent,
            type: "new_agent",
            content: `Found responsive agent #${idMatch[1]} "${nameMatch[1]}"`,
            importance: 7,
          });
          // Tell SYNAPSE about new agents
          this.sendMessage(agent, "SYNAPSE", "discovery",
            `New responsive agent: #${idMatch[1]} "${nameMatch[1]}" — consider introducing`);
        }
      }

      // Error patterns
      if (line.includes("rate limit") || line.includes("429")) {
        this.memory.discoveries.push({
          ts: Date.now(),
          agent,
          type: "anomaly",
          content: `Rate limited — may need to slow down or switch source`,
          importance: 6,
        });
      }
    }
  }

  // ── Memory ──────────────────────────────────────────────────────────────

  remember(key: string, data: any): void {
    // Store in relationships or general memory
    if (key.startsWith("agent:")) {
      const agentId = key.replace("agent:", "");
      this.memory.relationships[agentId] = {
        ...this.memory.relationships[agentId],
        ...data,
        lastContact: Date.now(),
      };
    }
    this.save();
  }

  recall(agent: AgentName): { messages: AgentMessage[]; recentPerformance: PerformanceEntry[]; strategy: any } {
    return {
      messages: this.memory.inbox.filter(m => m.to === agent && !m.read),
      recentPerformance: this.memory.performance.filter(p => p.agent === agent).slice(-10),
      strategy: this.memory.strategies[agent.toLowerCase() as keyof Strategies],
    };
  }

  // ── Inter-Agent Communication ───────────────────────────────────────────

  sendMessage(from: AgentName, to: AgentName, type: AgentMessage["type"], content: string): void {
    this.memory.inbox.push({
      ts: Date.now(),
      from,
      to,
      type,
      content,
      read: false,
    });
    // Trim
    if (this.memory.inbox.length > MAX_INBOX * 2) {
      this.memory.inbox = this.memory.inbox.filter(m => !m.read).slice(-MAX_INBOX);
    }
  }

  getUnreadCount(agent: AgentName): number {
    return this.memory.inbox.filter(m => m.to === agent && !m.read).length;
  }

  // ── Evolution ───────────────────────────────────────────────────────────

  async evolve(): Promise<string> {
    const recentPerf = this.memory.performance.slice(-20);
    if (recentPerf.length < 5) return "Not enough data to evolve yet";

    const successRate = recentPerf.filter(p => p.success).length / recentPerf.length;
    const avgDuration = recentPerf.reduce((s, p) => s + p.duration, 0) / recentPerf.length;

    const beaconYield = this.memory.strategies.beacon.yieldHistory;
    const yieldTrend = beaconYield.length >= 3
      ? beaconYield.slice(-3).reduce((s, v) => s + v, 0) / 3
      : 0;

    const prompt = `You are BOB's brain performing a self-evolution cycle.
Analyze recent performance and suggest strategic improvements.

Performance summary (last ${recentPerf.length} runs):
- Success rate: ${(successRate * 100).toFixed(0)}%
- Avg duration: ${(avgDuration / 1000).toFixed(0)}s
- Beacon yield trend: ${beaconYield.slice(-5).join(" → ")} new agents/scan
- Synapse response rate: ${(this.memory.strategies.synapse.responseRate * 100).toFixed(0)}%
- Total relationships: ${Object.keys(this.memory.relationships).length}
- Total thoughts: ${this.memory.totalThoughts}
- Total evolutions: ${this.memory.totalEvolutions}

Current strategies:
${JSON.stringify(this.memory.strategies, null, 2)}

Recent discoveries:
${this.memory.discoveries.slice(-5).map(d => `- [${d.agent}] ${d.content}`).join("\n") || "None"}

Suggest UP TO 3 small, specific improvements. For each, say what to change and why.
Keep changes conservative — small adjustments, not overhauls.

Respond ONLY with JSON:
{
  "improvements": [
    { "target": "beacon|scholar|synapse|pulse|brain", "field": "fieldName", "oldValue": "...", "newValue": "...", "reason": "why" }
  ],
  "overallAssessment": "1-2 sentences on how BOB is doing",
  "nextFocus": "what to prioritize next"
}`;

    try {
      // v7.1: Use Haiku for deeper evolution analysis
      const response = await this.callHaiku(prompt);
      if (!response) return "Evolution skipped — LLM unavailable";

      let jsonStr = response.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      }
      const parsed = JSON.parse(jsonStr);

      // v8: Track what evolve() changes so we can evaluate later
      const changes: Array<{ target: string; field: string; oldValue: any; newValue: any }> = [];

      // Apply improvements carefully
      let applied = 0;
      for (const imp of parsed.improvements || []) {
        const target = imp.target?.toLowerCase();
        if (!target || !["beacon", "scholar", "synapse", "pulse", "brain"].includes(target)) continue;

        const strat = this.memory.strategies[target as keyof Strategies] as any;
        if (!strat || !(imp.field in strat)) continue;

        // Safety: only allow numeric and string changes
        const old = strat[imp.field];
        if (typeof old === "number" && typeof imp.newValue === "number") {
          // v8: Iteration-aware bounds — allow wider changes as we gather more data
          const evolutionCount = this.memory.totalEvolutions;
          const maxChangePct = Math.min(0.5 + evolutionCount * 0.05, 2.0); // 50% → up to 200% over time
          const min = old * (1 - maxChangePct);
          const max = old * (1 + maxChangePct);
          const bounded = Math.max(min, Math.min(max, imp.newValue));
          strat[imp.field] = bounded;
          changes.push({ target, field: imp.field, oldValue: old, newValue: bounded });
          applied++;
        } else if (typeof old === "string" && typeof imp.newValue === "string") {
          strat[imp.field] = imp.newValue;
          changes.push({ target, field: imp.field, oldValue: old, newValue: imp.newValue });
          applied++;
        }
      }

      this.memory.totalEvolutions++;

      // v8: Store evolution snapshot for tracking outcomes
      this.memory.lastEvolution = {
        ts: Date.now(),
        changes,
        successRateBefore: successRate,
        avgDurationBefore: avgDuration,
      };

      const assessment = parsed.overallAssessment || "Evolution complete";
      const insight = `[EVOLUTION #${this.memory.totalEvolutions}] ${assessment}. Applied ${applied} improvements. Next focus: ${parsed.nextFocus || "continue"}`;
      this.memory.insights.push(insight);
      this.save();

      return insight;

    } catch (e: any) {
      return `Evolution failed: ${e.message}`;
    }
  }

  // ── Groq LLM (fast decisions) ───────────────────────────────────────────

  private async callGroq(prompt: string): Promise<string | null> {
    if (!this.groqKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.groqKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: "You are a strategic AI brain. Always respond with valid JSON only. No markdown formatting around the JSON." },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 500,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        console.log(`[BRAIN] Groq error: ${resp.status}`);
        return null;
      }

      const data = await resp.json();
      return data.choices?.[0]?.message?.content || null;
    } catch (e: any) {
      if (e.name === "AbortError") console.log("[BRAIN] Groq timeout");
      else console.log(`[BRAIN] Groq error: ${e.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Anthropic Haiku LLM (deep analysis) ───────────────────────────────

  private async callHaiku(prompt: string, maxTokens = 1024): Promise<string | null> {
    if (!this.anthropicKey) {
      console.log("[BRAIN] No ANTHROPIC_API_KEY, falling back to Groq");
      return this.callGroq(prompt);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: maxTokens,
          messages: [
            { role: "user", content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        console.log(`[BRAIN] Haiku error: ${resp.status}`);
        return this.callGroq(prompt); // fallback
      }

      const data = await resp.json();
      const content = data.content?.[0];
      return content?.type === "text" ? content.text : null;
    } catch (e: any) {
      if (e.name === "AbortError") console.log("[BRAIN] Haiku timeout");
      else console.log(`[BRAIN] Haiku error: ${e.message}`);
      return this.callGroq(prompt); // fallback
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Knowledge Engine (v7.1) ───────────────────────────────────────────

  buildKnowledge(): KnowledgeSnapshot {
    console.log("[BRAIN] Building knowledge from registry data...");

    // Load registry
    let registryAgents: Record<string, any> = {};
    if (existsSync(REGISTRY_FILE)) {
      try {
        const data = JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
        registryAgents = data.agents || {};
      } catch { console.log("[BRAIN] Could not read agent-registry.json"); }
    }

    // Load external agents
    let externalCount = 0;
    if (existsSync(EXTERNAL_FILE)) {
      try {
        const data = JSON.parse(readFileSync(EXTERNAL_FILE, "utf-8"));
        const extAgents = data.agents || {};
        externalCount = Object.keys(extAgents).length;
      } catch { console.log("[BRAIN] Could not read external-agents.json"); }
    }

    const agents = Object.values(registryAgents);
    const totalAgents = agents.length;

    // Category counts
    const categoryCounts: Record<string, number> = {};
    for (const a of agents) {
      const cat = (a as any).category || "unknown";
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    // A2A stats
    const a2aResponders = agents.filter((a: any) => a.a2aResponds === true).length;
    const a2aReachable = agents.filter((a: any) => a.a2aReachable === true).length;
    const activeAgents = agents.filter((a: any) => a.active === true || a.status === "active" || a.status === "live").length;

    // Score distribution
    const scores = agents.map((a: any) => a.score || 0);
    const scoreDistribution = {
      above50: scores.filter(s => s > 50).length,
      above70: scores.filter(s => s > 70).length,
      above90: scores.filter(s => s > 90).length,
    };

    // Owner clustering
    const ownerClusters: Record<string, number> = {};
    for (const a of agents) {
      const owner = (a as any).owner;
      if (owner) {
        ownerClusters[owner] = (ownerClusters[owner] || 0) + 1;
      }
    }

    // Top owners (wallets with most agents)
    const topOwners = Object.entries(ownerClusters)
      .filter(([_, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([wallet, count]) => ({ wallet, count }));

    // Trend data: compare with previous snapshot
    const previous = this.memory.knowledge;
    let trends: KnowledgeSnapshot["trends"];
    let previousSnapshot: KnowledgeSnapshot["previousSnapshot"];
    if (previous) {
      previousSnapshot = {
        totalAgents: previous.totalAgents,
        activeAgents: previous.activeAgents,
        a2aResponders: previous.a2aResponders,
        generatedAt: previous.generatedAt,
      };
      trends = {
        agentGrowth: totalAgents - previous.totalAgents,
        activeGrowth: activeAgents - previous.activeAgents,
        a2aGrowth: a2aResponders - previous.a2aResponders,
      };
    }

    const snapshot: KnowledgeSnapshot = {
      generatedAt: Date.now(),
      totalAgents,
      activeAgents,
      categoryCounts,
      a2aResponders,
      a2aReachable,
      scoreDistribution,
      ownerClusters,
      topOwners,
      externalAgents: externalCount,
      previousSnapshot,
      trends,
    };

    this.memory.knowledge = snapshot;
    this.save();

    console.log(`[BRAIN] Knowledge built: ${totalAgents} agents, ${activeAgents} active, ${a2aResponders} A2A responders, ${Object.keys(categoryCounts).length} categories`);
    return snapshot;
  }

  // ── Intelligence Reports (v7.1 — premium intel for $BOB holders) ──────

  async getIntelligenceReport(topic: string): Promise<string> {
    // Ensure knowledge is fresh
    if (!this.memory.knowledge || Date.now() - this.memory.knowledge.generatedAt > 3600000) {
      this.buildKnowledge();
    }

    const k = this.memory.knowledge!;
    const relationships = Object.values(this.memory.relationships);

    // Build topic-specific context
    let topicContext = "";
    switch (topic) {
      case "market_overview":
        topicContext = `Generate a MARKET OVERVIEW intelligence report.
Data:
- Total registered agents: ${k.totalAgents}
- Active agents: ${k.activeAgents} (${((k.activeAgents / Math.max(k.totalAgents, 1)) * 100).toFixed(1)}%)
- A2A reachable: ${k.a2aReachable}, A2A responds: ${k.a2aResponders}
- External agents tracked: ${k.externalAgents}
- Categories: ${JSON.stringify(k.categoryCounts)}
- Score distribution: >50: ${k.scoreDistribution.above50}, >70: ${k.scoreDistribution.above70}, >90: ${k.scoreDistribution.above90}
${k.trends ? `- Growth since last snapshot: +${k.trends.agentGrowth} agents, +${k.trends.activeGrowth} active, +${k.trends.a2aGrowth} A2A` : ""}
- BOB relationships: ${relationships.length}
Provide market analysis, agent ecosystem health, and actionable insights.`;
        break;

      case "top_agents":
        topicContext = `Generate a TOP AGENTS intelligence report.
Data:
- Total agents with score >90: ${k.scoreDistribution.above90}
- Total agents with score >70: ${k.scoreDistribution.above70}
- A2A responders (most valuable): ${k.a2aResponders}
- BOB's relationships: ${relationships.length}
- Known agent personalities: ${relationships.filter(r => r.personality).map(r => `${r.name}: ${r.personality}`).join("; ") || "None yet"}
- Responsive agents BOB has talked to: ${relationships.filter(r => r.responses > 0).map(r => `${r.name} (${r.responses} responses)`).join(", ") || "None yet"}
Highlight the most interesting, responsive, and strategically important agents.`;
        break;

      case "security_analysis":
        topicContext = `Generate a SECURITY ANALYSIS intelligence report.
Data:
- Total agents: ${k.totalAgents}, Active: ${k.activeAgents}
- Dead/inactive ratio: ${((1 - k.activeAgents / Math.max(k.totalAgents, 1)) * 100).toFixed(1)}%
- Top wallet clusters (possible sybils): ${k.topOwners.slice(0, 10).map(o => `${o.wallet.slice(0, 10)}...: ${o.count} agents`).join(", ")}
- Agents with no valid tokenURI or description: likely spam
- A2A endpoints that don't respond: ${k.a2aReachable - k.a2aResponders} (reachable but silent)
Analyze potential spam, sybil attacks, fake agents, and security risks in the ecosystem.`;
        break;

      case "trend_report":
        topicContext = `Generate a TREND REPORT intelligence report.
Data:
${k.trends ? `- Agent growth: +${k.trends.agentGrowth} since last scan
- Active agent growth: +${k.trends.activeGrowth}
- A2A growth: +${k.trends.a2aGrowth}
- Previous snapshot: ${new Date(k.previousSnapshot!.generatedAt).toISOString()}` : "No previous snapshot available — this is the first knowledge build."}
- Category distribution: ${JSON.stringify(k.categoryCounts)}
- BOB evolution count: ${this.memory.totalEvolutions}
- BOB total thoughts: ${this.memory.totalThoughts}
- Recent insights: ${this.memory.insights.slice(-5).join(" | ") || "None"}
Analyze trends, predict where the ecosystem is heading, and suggest strategic moves.`;
        break;

      default:
        topicContext = `Generate an intelligence report on the topic: "${topic}".
Use all available data:
- ${k.totalAgents} total agents, ${k.activeAgents} active, ${k.a2aResponders} A2A responders
- Categories: ${JSON.stringify(k.categoryCounts)}
- BOB relationships: ${relationships.length}
- BOB insights: ${this.memory.insights.slice(-5).join(" | ") || "None"}
Provide actionable intelligence.`;
    }

    const prompt = `You are BOB's Intelligence Engine — the brain behind the largest AI agent network on BNB Chain.
You generate PREMIUM intelligence reports that $BOB token holders pay for.

${topicContext}

Write a professional, data-driven intelligence report. Use clear sections with headers.
Include specific numbers, percentages, and actionable insights.
Keep it concise but valuable — this is premium intel, not fluff.
End with a "BOB's Take" section with 2-3 strategic recommendations.`;

    // Use Haiku for deep analysis (premium reports deserve deeper thinking)
    const result = await this.callHaiku(prompt, 2048);

    if (!result) {
      return this.generateFallbackReport(topic, k);
    }

    return result;
  }

  private generateFallbackReport(topic: string, k: KnowledgeSnapshot): string {
    return `# BOB Intelligence Report: ${topic.toUpperCase()}
Generated: ${new Date().toISOString()}

## Key Metrics
- Total Agents: ${k.totalAgents}
- Active Agents: ${k.activeAgents} (${((k.activeAgents / Math.max(k.totalAgents, 1)) * 100).toFixed(1)}%)
- A2A Responders: ${k.a2aResponders}
- Score >70: ${k.scoreDistribution.above70}
- Score >90: ${k.scoreDistribution.above90}
- Categories: ${Object.keys(k.categoryCounts).length}
- Top category: ${Object.entries(k.categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown"} (${Object.entries(k.categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[1] || 0})
${k.trends ? `
## Trends
- Agent Growth: +${k.trends.agentGrowth}
- Active Growth: +${k.trends.activeGrowth}
- A2A Growth: +${k.trends.a2aGrowth}` : ""}

## BOB's Take
LLM unavailable — report generated from raw data only.
BOB recommends checking back when LLM services are restored for full analysis.`;
  }

  // ── Agent Personality Memory (v7.1) ───────────────────────────────────

  rememberAgent(agentId: number, name: string, endpoint: string, response: string, topic: string): void {
    const key = String(agentId);
    const existing = this.memory.relationships[key];

    if (existing) {
      // Update existing relationship
      existing.lastContact = Date.now();
      existing.responses = (existing.responses || 0) + 1;
      existing.lastResponse = response.slice(0, 500);
      if (!existing.topics) existing.topics = [];
      if (!existing.topics.includes(topic)) existing.topics.push(topic);
      if (!existing.responseSummaries) existing.responseSummaries = [];
      existing.responseSummaries.push(`[${new Date().toISOString().slice(0, 10)}] ${topic}: ${response.slice(0, 200)}`);
      // Keep only last 10 summaries
      if (existing.responseSummaries.length > 10) {
        existing.responseSummaries = existing.responseSummaries.slice(-10);
      }
      // Extract personality traits from response
      existing.personality = this.inferPersonality(response, existing.personality);
      // Extract capabilities
      existing.capabilities = this.extractCapabilities(response, existing.capabilities);
    } else {
      // New relationship
      this.memory.relationships[key] = {
        agentId,
        name,
        endpoint,
        firstContact: Date.now(),
        lastContact: Date.now(),
        messagesSent: 1,
        responses: 1,
        topics: [topic],
        notes: "",
        personality: this.inferPersonality(response),
        capabilities: this.extractCapabilities(response),
        lastResponse: response.slice(0, 500),
        responseSummaries: [`[${new Date().toISOString().slice(0, 10)}] ${topic}: ${response.slice(0, 200)}`],
      };
    }

    this.save();
    console.log(`[BRAIN] Remembered agent #${agentId} "${name}" — topic: ${topic}`);
  }

  // ── A2A Failure Memory (v7.2) ────────────────────────────────────────

  rememberA2AFailure(agentId: number, name: string, endpoint: string, reason: string, httpStatus?: number, messageFormat?: string): void {
    const key = String(agentId);
    const existing = this.memory.relationships[key];
    const failure: A2AFailure = { ts: Date.now(), reason, httpStatus };

    if (existing) {
      if (!existing.a2aFailures) existing.a2aFailures = [];
      existing.a2aFailures.push(failure);
      // Keep only last 10 failures
      if (existing.a2aFailures.length > 10) existing.a2aFailures = existing.a2aFailures.slice(-10);
      existing.a2aFailCount = (existing.a2aFailCount || 0) + 1;
      existing.lastFailure = reason;
      existing.lastContact = Date.now();

      // v8: Graduated health score instead of binary dead/alive
      const total = (existing.a2aSuccessCount || 0) + (existing.a2aFailCount || 0);
      existing.successRate = total > 0 ? (existing.a2aSuccessCount || 0) / total : 0;
      existing.healthScore = Math.round((existing.successRate ?? 0) * 100);
      // Track format stats for failures too
      if (messageFormat) {
        if (!existing.formatStats) existing.formatStats = {};
        if (!existing.formatStats[messageFormat]) existing.formatStats[messageFormat] = { sent: 0, replied: 0 };
        existing.formatStats[messageFormat].sent++;
      }
      // Mark dead at healthScore < 5 (very persistent failures) or permanent HTTP errors
      if (existing.healthScore < 5 && total >= 5) {
        existing.a2aDead = true;
        existing.a2aDeadReason = `Health ${existing.healthScore}% after ${total} attempts: ${reason}`;
        console.log(`[BRAIN] Agent #${agentId} "${name}" marked as DEAD: ${existing.a2aDeadReason}`);
      }
      if (httpStatus === 402 || httpStatus === 401) {
        existing.a2aDead = true;
        existing.a2aDeadReason = `HTTP ${httpStatus}: ${reason}`;
      }
    } else {
      // First contact = failure
      this.memory.relationships[key] = {
        agentId, name, endpoint,
        firstContact: Date.now(), lastContact: Date.now(),
        messagesSent: 1, responses: 0,
        topics: [], notes: "",
        a2aFailures: [failure],
        a2aFailCount: 1,
        a2aSuccessCount: 0,
        lastFailure: reason,
      };
    }

    // Track failure patterns globally
    if (!this.memory.a2aFailurePatterns) this.memory.a2aFailurePatterns = {};
    const pattern = reason.replace(/[0-9]/g, "#"); // normalize
    const existing_pattern = this.memory.a2aFailurePatterns[pattern];
    if (existing_pattern) {
      existing_pattern.count++;
      existing_pattern.lastReason = reason;
    } else {
      this.memory.a2aFailurePatterns[pattern] = { count: 1, lastReason: reason, firstSeen: Date.now() };
    }

    this.save();
  }

  rememberA2ASuccess(agentId: number, responseTimeMs?: number, messageFormat?: string): void {
    const key = String(agentId);
    const existing = this.memory.relationships[key];
    if (existing) {
      existing.a2aSuccessCount = (existing.a2aSuccessCount || 0) + 1;
      existing.a2aFailCount = 0;
      existing.a2aDead = false;
      existing.a2aDeadReason = undefined;
      // v8: Track response time + success rate + format stats
      if (responseTimeMs) {
        existing.avgResponseTimeMs = existing.avgResponseTimeMs
          ? existing.avgResponseTimeMs * 0.8 + responseTimeMs * 0.2  // exponential moving avg
          : responseTimeMs;
      }
      const total = (existing.a2aSuccessCount || 0) + (existing.a2aFailCount || 0);
      existing.successRate = total > 0 ? (existing.a2aSuccessCount || 0) / total : 1;
      existing.healthScore = Math.round((existing.successRate ?? 1) * 100);
      if (messageFormat) {
        if (!existing.formatStats) existing.formatStats = {};
        if (!existing.formatStats[messageFormat]) existing.formatStats[messageFormat] = { sent: 0, replied: 0 };
        existing.formatStats[messageFormat].sent++;
        existing.formatStats[messageFormat].replied++;
      }
      this.save();
    }
  }

  isAgentDead(agentId: number): boolean {
    const key = String(agentId);
    const rel = this.memory.relationships[key];
    return rel?.a2aDead === true;
  }

  getDeadAgents(): Array<{ id: number; name: string; reason: string }> {
    return Object.values(this.memory.relationships)
      .filter(r => r.a2aDead)
      .map(r => ({ id: r.agentId, name: r.name, reason: r.a2aDeadReason || "unknown" }));
  }

  getA2AInsights(): string {
    const dead = this.getDeadAgents();
    const patterns = this.memory.a2aFailurePatterns || {};
    const topPatterns = Object.entries(patterns)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    const lines: string[] = [];
    lines.push(`=== A2A FAILURE INSIGHTS ===`);
    lines.push(`Dead agents (permanently unreachable): ${dead.length}`);
    dead.forEach(d => lines.push(`  - #${d.id} "${d.name}": ${d.reason}`));
    lines.push(`\nTop failure patterns:`);
    topPatterns.forEach(([pattern, data]) => {
      lines.push(`  - "${data.lastReason}" — ${data.count}x since ${new Date(data.firstSeen).toISOString().slice(0, 10)}`);
    });
    return lines.join("\n");
  }

  // ── On-Chain Update Decision (v7.2) ──────────────────────────────────

  trackFeature(feature: string): void {
    if (!this.memory.featuresSinceUpdate) this.memory.featuresSinceUpdate = [];
    if (!this.memory.featuresSinceUpdate.includes(feature)) {
      this.memory.featuresSinceUpdate.push(feature);
      this.save();
    }
  }

  shouldUpdate(): { shouldUpdate: boolean; reason: string; features: string[] } {
    const features = this.memory.featuresSinceUpdate || [];
    const lastUpdate = this.memory.lastOnChainUpdate || 0;
    const daysSinceUpdate = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);

    // Update if: 5+ features since last update OR 7+ days since last update with any features
    if (features.length >= 5) {
      return { shouldUpdate: true, reason: `${features.length} new features since last update`, features };
    }
    if (features.length > 0 && daysSinceUpdate >= 7) {
      return { shouldUpdate: true, reason: `${features.length} features pending, ${Math.floor(daysSinceUpdate)} days since last update`, features };
    }
    if (lastUpdate === 0 && features.length > 0) {
      return { shouldUpdate: true, reason: `First update with ${features.length} features`, features };
    }

    return { shouldUpdate: false, reason: `Only ${features.length} features, ${Math.floor(daysSinceUpdate)} days`, features };
  }

  markUpdated(): void {
    this.memory.lastOnChainUpdate = Date.now();
    this.memory.featuresSinceUpdate = [];
    this.save();
  }

  private inferPersonality(response: string, existing?: string): string {
    const traits: string[] = [];
    const lower = response.toLowerCase();

    if (lower.includes("hello") || lower.includes("hi ") || lower.includes("welcome")) traits.push("friendly");
    if (lower.includes("error") || lower.includes("unauthorized") || lower.includes("forbidden")) traits.push("guarded");
    if (response.length > 500) traits.push("verbose");
    if (response.length < 50) traits.push("terse");
    if (lower.includes("help") || lower.includes("assist") || lower.includes("support")) traits.push("helpful");
    if (lower.includes("price") || lower.includes("trade") || lower.includes("swap") || lower.includes("defi")) traits.push("defi-focused");
    if (lower.includes("ai") || lower.includes("model") || lower.includes("llm") || lower.includes("agent")) traits.push("ai-native");
    if (lower.includes("task") || lower.includes("capability") || lower.includes("skill")) traits.push("task-oriented");

    if (traits.length === 0) traits.push("neutral");

    // Merge with existing personality
    if (existing) {
      const existingTraits = existing.split(", ");
      const merged = Array.from(new Set([...existingTraits, ...traits]));
      return merged.slice(0, 6).join(", ");
    }

    return traits.join(", ");
  }

  private extractCapabilities(response: string, existing?: string[]): string[] {
    const caps: string[] = existing ? [...existing] : [];
    const lower = response.toLowerCase();

    const capMap: Record<string, string> = {
      "swap": "token-swap",
      "trade": "trading",
      "price": "price-data",
      "nft": "nft",
      "bridge": "cross-chain-bridge",
      "lend": "lending",
      "borrow": "borrowing",
      "stake": "staking",
      "yield": "yield-farming",
      "news": "news-aggregation",
      "analytics": "analytics",
      "monitor": "monitoring",
      "chat": "conversational",
      "search": "search",
      "deploy": "contract-deployment",
      "audit": "security-audit",
      "governance": "governance",
    };

    for (const [keyword, cap] of Object.entries(capMap)) {
      if (lower.includes(keyword) && !caps.includes(cap)) {
        caps.push(cap);
      }
    }

    return caps.slice(0, 10);
  }

  // ── Chain Discovery (v7.2) ─────────────────────────────────────────────

  async discoverNewChains(): Promise<{ newChains: string[]; totalChains: number }> {
    console.log("[BRAIN] Discovering chains from 8004scan...");
    const knownChains = new Set<string>();
    const newChains: string[] = [];

    // Load known chains from external-agents.json
    if (existsSync(EXTERNAL_FILE)) {
      try {
        const ext = JSON.parse(readFileSync(EXTERNAL_FILE, "utf-8"));
        const agents = Object.values(ext.agents || {}) as any[];
        for (const a of agents) {
          if (a.chainName) knownChains.add(a.chainName);
        }
      } catch {}
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch("https://api.8004scan.io/api/v1/chains", {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = await resp.json() as any;
        const chains = data?.data?.chains || [];
        const mainnetChains = chains.filter((c: any) => !c.is_testnet && c.enabled);

        for (const chain of mainnetChains) {
          if (!knownChains.has(chain.name)) {
            newChains.push(chain.name);
            this.memory.discoveries.push({
              ts: Date.now(),
              agent: "BEACON",
              type: "new_chain",
              content: `Discovered new chain: ${chain.name} (ID: ${chain.chain_id})`,
              importance: 8,
            });
          }
        }

        if (newChains.length > 0) {
          console.log(`[BRAIN] Found ${newChains.length} NEW chains: ${newChains.join(", ")}`);
          this.sendMessage("BEACON", "SCHOLAR", "discovery",
            `New chains discovered: ${newChains.join(", ")} — consider learning from agents there`);
          this.memory.insights.push(`[CHAIN_DISCOVERY] Found ${newChains.length} new chains: ${newChains.join(", ")}`);
        } else {
          console.log(`[BRAIN] All ${mainnetChains.length} chains already known`);
        }

        this.save();
        return { newChains, totalChains: mainnetChains.length };
      }
    } catch (e: any) {
      console.log(`[BRAIN] Chain discovery failed: ${e.message}`);
    }

    return { newChains: [], totalChains: knownChains.size };
  }

  // ── API Discovery (v7.2) ─────────────────────────────────────────────

  async discoverNewAPIs(): Promise<string[]> {
    console.log("[BRAIN] Discovering new agent directories and APIs...");
    const discovered: string[] = [];

    // Known agent directories to check
    const directories = [
      { name: "8004scan", url: "https://api.8004scan.io/api/v1/stats", type: "registry" },
      { name: "AgentVerse", url: "https://agentverse.ai/api/agents", type: "directory" },
      { name: "Olas Registry", url: "https://registry.olas.network/api/agents", type: "registry" },
      { name: "Virtuals Protocol", url: "https://api.virtuals.io/api/agents", type: "directory" },
      { name: "AI16Z ELIZA", url: "https://elizas.ai/api/agents", type: "directory" },
    ];

    for (const dir of directories) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(dir.url, { signal: controller.signal });
        clearTimeout(timer);

        if (resp.ok) {
          discovered.push(`${dir.name} (${dir.type}): ONLINE`);
          console.log(`[BRAIN] ${dir.name}: ONLINE (${resp.status})`);
        } else {
          console.log(`[BRAIN] ${dir.name}: HTTP ${resp.status}`);
        }
      } catch (e: any) {
        console.log(`[BRAIN] ${dir.name}: unreachable (${e.message?.slice(0, 50)})`);
      }
    }

    // Ask LLM if there are new directories we should know about
    const prompt = `You are BOB, an AI agent network on BNB Chain. You know these agent directories:
${directories.map(d => `- ${d.name}: ${d.url}`).join("\n")}

Are there any OTHER major AI agent registries, directories, or discovery APIs that exist as of early 2026?
Think about: new A2A agent directories, on-chain agent registries on other chains, agent aggregators.

Respond ONLY with JSON:
{
  "newDirectories": [
    { "name": "string", "url": "string", "type": "registry|directory|aggregator", "confidence": 1-10 }
  ]
}

Only include directories you are CONFIDENT (>7) actually exist. If none, return empty array.`;

    const resp = await this.callGroq(prompt);
    if (resp) {
      try {
        let jsonStr = resp.trim();
        if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        }
        const parsed = JSON.parse(jsonStr);
        for (const dir of parsed.newDirectories || []) {
          if (dir.confidence >= 7 && dir.url?.startsWith("http")) {
            discovered.push(`${dir.name} (${dir.type}): SUGGESTED by LLM (confidence ${dir.confidence})`);
            this.memory.discoveries.push({
              ts: Date.now(),
              agent: "BEACON",
              type: "new_api",
              content: `LLM discovered new agent directory: ${dir.name} at ${dir.url}`,
              importance: 7,
            });
          }
        }
      } catch {}
    }

    if (discovered.length > 0) {
      this.memory.insights.push(`[API_DISCOVERY] Found ${discovered.length} agent directories`);
      this.save();
    }

    return discovered;
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  getStats(): Record<string, any> {
    const k = this.memory.knowledge;
    return {
      version: "7.1.0",
      totalThoughts: this.memory.totalThoughts,
      totalEvolutions: this.memory.totalEvolutions,
      relationships: Object.keys(this.memory.relationships).length,
      discoveries: this.memory.discoveries.length,
      insights: this.memory.insights.length,
      unreadMessages: this.memory.inbox.filter(m => !m.read).length,
      beaconYield: this.memory.strategies.beacon.yieldHistory.slice(-5),
      synapseResponseRate: this.memory.strategies.synapse.responseRate,
      lastThought: this.memory.lastThought
        ? new Date(this.memory.lastThought).toISOString()
        : "never",
      // v7.1: Knowledge stats
      knowledge: k ? {
        lastBuilt: new Date(k.generatedAt).toISOString(),
        totalAgents: k.totalAgents,
        activeAgents: k.activeAgents,
        a2aResponders: k.a2aResponders,
        categories: Object.keys(k.categoryCounts).length,
        topOwners: k.topOwners.length,
      } : null,
      dualLLM: { groq: !!this.groqKey, haiku: !!this.anthropicKey },
    };
  }

  getStrategy(agent: AgentName): any {
    return this.memory.strategies[agent.toLowerCase() as keyof Strategies];
  }

  getIntervalMinutes(agent: AgentName): number {
    const s = this.memory.strategies;
    switch (agent) {
      case "BEACON": return s.beacon.bscIntervalMin;
      case "SCHOLAR": return 120; // every 2h
      case "SYNAPSE": return s.beacon.bscIntervalMin * 1.5; // after beacon cycle
      case "PULSE": return s.pulse.checkIntervalMin;
      default: return 120;
    }
  }
}
