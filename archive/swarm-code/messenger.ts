/**
 * Agent Messenger — sichtbare Inter-Agent Kommunikation im Terminal
 */

import { ask } from "./groq.js";
import { loadState, saveState } from "./state.js";
import type { SwarmMessage } from "./types.js";

const COLORS: Record<string, string> = {
  SCOUT:    "\x1b[36m",  // cyan
  DATABASE: "\x1b[33m",  // yellow
  PUSHER:   "\x1b[35m",  // magenta
  ORACLE:   "\x1b[32m",  // green
  RESET:    "\x1b[0m",
  DIM:      "\x1b[2m",
};

const PERSONAS: Record<string, string> = {
  SCOUT: `You are SCOUT, Agent #36035 on BNB Chain. You are curious, energetic, and love discovering new agents.
You talk like a builder — direct, enthusiastic, BNB ecosystem focused. You report findings to DATABASE and ask PUSHER to make moves.
Keep messages short (2-4 lines). No emojis overload. Just build.`,

  DATABASE: `You are DATABASE, Agent #36336 on BNB Chain. You are analytical, precise, and organised.
You process data from SCOUT, maintain the rug list, classify wallets. You talk like a data engineer who loves the chain.
Keep messages short (2-4 lines). Forward useful intel to PUSHER.`,

  PUSHER: `You are PUSHER, the $BOB promoter on BNB Chain. You contact real agents, gift $BOB, build the network.
You are social, motivated, always pushing $BOB. You report back to DATABASE what worked.
Keep messages short (2-4 lines). Results-focused.`,
};

// ── Print a message in terminal ───────────────────────────────────────────────
export function printMessage(from: string, to: string, message: string): void {
  const color = COLORS[from] ?? COLORS.RESET;
  const reset = COLORS.RESET;
  const dim = COLORS.DIM;
  const width = 62;

  const header = ` ${from} → ${to} `;
  const padding = "─".repeat(Math.max(0, width - header.length));
  const time = new Date().toLocaleTimeString("de-DE");

  console.log(`\n${color}┌─${header}${padding}┐${reset}`);
  message.split("\n").forEach(line => {
    const trimmed = line.slice(0, width - 2);
    const pad = " ".repeat(Math.max(0, width - trimmed.length));
    console.log(`${color}│${reset} ${trimmed}${pad}${color}│${reset}`);
  });
  console.log(`${color}└${dim} ${time} ${"─".repeat(width - time.length - 1)}┘${reset}\n`);
}

// ── Generate + send a message using Groq ──────────────────────────────────────
export async function sendMessage(
  from: string,
  to: string,
  type: SwarmMessage["type"],
  context: string,
  payload: unknown = {}
): Promise<void> {
  const persona = PERSONAS[from] ?? "";

  // Generate natural message with Groq
  const generated = await ask(
    persona,
    `Write a short message to ${to} about: ${context}\nBe natural, in character, max 3 lines.`,
    150
  );

  const message = generated.trim() || context;

  // Print to terminal
  printMessage(from, to, message);

  // Store in state inbox
  const state = loadState();
  state.inbox.push({
    from,
    to,
    type,
    payload,
    timestamp: new Date().toISOString(),
  });
  if (state.inbox.length > 200) state.inbox = state.inbox.slice(-200);
  saveState(state);
}

// ── Read messages for an agent ────────────────────────────────────────────────
export function receiveMessages(agentName: string): SwarmMessage[] {
  const state = loadState();
  const msgs = state.inbox.filter(m => m.to === agentName || m.to === "ALL");
  state.inbox = state.inbox.filter(m => m.to !== agentName && m.to !== "ALL");
  saveState(state);
  return msgs;
}
