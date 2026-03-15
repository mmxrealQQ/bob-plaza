import { readFileSync, writeFileSync, existsSync } from "fs";
import type { SwarmState, SwarmMessage } from "./types.js";
import { DEFAULT_STATE } from "./types.js";

const STATE_FILE = "bob-swarm-state.json";

export function loadState(): SwarmState {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: SwarmState): void {
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function postMessage(msg: Omit<SwarmMessage, "timestamp">): void {
  const state = loadState();
  state.inbox.push({ ...msg, timestamp: new Date().toISOString() });
  // Keep inbox max 100 messages
  if (state.inbox.length > 100) state.inbox = state.inbox.slice(-100);
  saveState(state);
}

export function readMessages(agentName: string): SwarmMessage[] {
  const state = loadState();
  const msgs = state.inbox.filter(m => m.to === agentName || m.to === "all");
  // Clear read messages
  state.inbox = state.inbox.filter(m => m.to !== agentName && m.to !== "all");
  saveState(state);
  return msgs;
}

export function updateStats(state: SwarmState): void {
  const agents = Object.values(state.agents);
  state.stats = {
    activeAgents: agents.filter(a => a.status === "active").length,
    inactiveAgents: agents.filter(a => a.status === "inactive").length,
    ghostAgents: agents.filter(a => a.status === "ghost").length,
    confirmedRuggers: state.ruggers.filter(r => r.confirmed).length,
    walletsClassified: Object.values(state.wallets).filter(w => w.type !== "unknown").length,
  };
}
