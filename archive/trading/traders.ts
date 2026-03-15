/**
 * BOB TRADING SQUAD v21.0 — Build On BNB
 * BLAZE · BRAIN · BOOST · BANK
 *
 * v21 — WATCHLIST EDITION: Erst beobachten, dann handeln!
 *  - WATCHLIST: Tokens werden erst beobachtet (Snapshots), nicht sofort gekauft
 *  - ENTRY SIGNALS: Kaufen NUR wenn Preis steigt + Volume steigt + Sells bewiesen
 *  - PATIENCE: Min 2 Snapshots nötig bevor Entry (≈2 Zyklen beobachten)
 *  - MOMENTUM PROOF: Preis muss zwischen Snapshots steigen
 *  - SELL PROOF: Min 5 Sells nötig — Token muss bewiesen verkaufbar sein
 *
 * v20 — ANTI-HONEYPOT:
 *  - 0 sells = NIEMALS kaufen
 *  - Auto-approve NUR bei 5+ sells
 *  - B/S ratio Schwelle 20:1
 *
 * v19 — DEEP LEARNING EDITION:
 *  - Score-Gewichte lernen (Opus passt Scoring-Formel an: momentum, age, liq, reversal)
 *  - Route-Learning (welcher Swap-Weg klappt bei welchem Token-Typ)
 *  - Pattern-Erkennung (chinesische Namen + low liq = Honeypot, etc.)
 *  - Cross-Bot Learning (BOOST lernt von BRAIN's Wins, etc.)
 *  - Dynamic Config + Wallet Sync + $BOB Emergency + Honeypot Detection
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { connectBNBChain, executeTool } from "./mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ── Konstanten ─────────────────────────────────────────────────────────────────
const WBNB      = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER    = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const BOB_TOKEN = "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e";
const BRAINS    = "data/bob-brains.json";
const SWARM     = "data/bob-swarm-state.json";
const JOURNAL   = "data/bob-journal.json";

const SWARM_WALLET_ADDRESS = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const startTime = Date.now();

// Tokens die NIE getradet werden (Stablecoins, Base-Tokens, eigener Token)
const SKIP_TOKENS = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8", // ETH
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB
  "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e", // $BOB
  // Bekannte Scamcoins (Airdrop-Spam, nicht sellbar)
  "0xb8b65b02bc7587f4f7635774742361db803e6066", // OpenClaw/Skills
  "0x306d239d42381042d3a0705285923be7d2b1045c", // zesty.bet
  "0x4a3e46ffa087be7c90a9082357da774d638bfbcb", // 龙虾
  "0x02578bac89cb36057ee0b427c4469a680ecbdc40", // Unitas/UP空投
  "0xe4dd809ea09ab0894109d059d7491eaa49d5b02e", // BC.GAME
  "0x2165e95ca6b755a30cf898a3de093329f16a1b3b", // 皮皮虾
  "0x05cca08f1b0fa640c2ff8a8a812ffea291fe7f1d", // 龙虾人生
  "0xfafc333334a8d712a948b611540d0ee5e9635044", // LP之王
  "0x3d93e4838109d8dfb5c7d8cd5053fd888aee0d09", // 赛博龙虾
  "0x99a9d13fa0f80cbda958270ea5b0ff5368c7b901", // 共享龙虾
  "0x3b88c6c5ed2cb655483144f34070cedec8a16683", // Moltbook
]);

// Modelle — Tiered: Opus (Geld) → Sonnet (Fallback) → Haiku (Notfall)
const HAIKU  = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const OPUS   = "claude-opus-4-6";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

// ── Types ──────────────────────────────────────────────────────────────────────
interface Wallet { name: string; address: string; privateKey: string; }
interface BotConfig {
  minScore: number;        // Minimum Score zum Kaufen
  maxPositions: number;    // Max gleichzeitige Positionen
  baseAmount: number;      // Standard BNB pro Trade
  maxAmount: number;       // Max BNB pro Trade (bei hohem Score)
  tpPct: number;           // Take Profit %
  slPct: number;           // Stop Loss %
  scalpPct: number;        // Scalp Profit %
  scalpMinAge: number;     // Min Alter für Scalp (Minuten)
  maxAge: number;          // Max Haltezeit (Minuten)
  staleAge: number;        // Stale = verkaufen wenn kein Profit
  preferFresh: boolean;    // Bevorzugt frische Tokens (<30min)
  preferMomentum: boolean; // Bevorzugt hohe 1h-Change
  preferReversal: boolean; // Bevorzugt 24h-down + 1h-up Pattern
}

// ── BOT PERSÖNLICHKEITEN ──
const BOT_CONFIGS: Record<string, BotConfig> = {
  BLAZE: {
    // SNIPER — schnell rein, schnell raus, kleine Positionen
    minScore: 25, maxPositions: 4, baseAmount: 0.002, maxAmount: 0.004,
    tpPct: 8, slPct: -15, scalpPct: 4, scalpMinAge: 3, maxAge: 20, staleAge: 12,
    preferFresh: true, preferMomentum: false, preferReversal: false,
  },
  BRAIN: {
    // ANALYST — nur Quality-Trades, hält länger, grössere Positionen
    minScore: 45, maxPositions: 2, baseAmount: 0.003, maxAmount: 0.005,
    tpPct: 20, slPct: -12, scalpPct: 8, scalpMinAge: 8, maxAge: 45, staleAge: 30,
    preferFresh: false, preferMomentum: false, preferReversal: false,
  },
  BOOST: {
    // MOMENTUM RIDER — kauft nur Tokens die schon pumpen, reitet die Welle
    minScore: 35, maxPositions: 3, baseAmount: 0.003, maxAmount: 0.005,
    tpPct: 15, slPct: -18, scalpPct: 6, scalpMinAge: 5, maxAge: 30, staleAge: 20,
    preferFresh: false, preferMomentum: true, preferReversal: true,
  },
};

// ── DYNAMIC CONFIG — Opus ändert Bot-Parameter als Code! ──────────────────────
const DYNAMIC_CFG_FILE = "data/bob-dynamic-config.json";
const PARAM_BOUNDS: Record<string, [number, number]> = {
  minScore: [15, 60], tpPct: [5, 30], slPct: [-25, -5], scalpPct: [3, 15],
  scalpMinAge: [2, 10], maxAge: [10, 60], staleAge: [8, 40],
  baseAmount: [0.001, 0.008], maxAmount: [0.002, 0.01], maxPositions: [1, 6],
};
const dynamicConfigLog: { bot: string; param: string; old: number; val: number; reason: string; time: string }[] = [];

function loadDynamicConfig(): Record<string, Partial<BotConfig>> {
  try {
    if (existsSync(DYNAMIC_CFG_FILE)) return JSON.parse(readFileSync(DYNAMIC_CFG_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveDynamicConfig(overrides: Record<string, Partial<BotConfig>>): void {
  try { writeFileSync(DYNAMIC_CFG_FILE, JSON.stringify(overrides, null, 2)); } catch {}
}

function getEffectiveConfig(botName: string): BotConfig {
  const base = { ...BOT_CONFIGS[botName] ?? BOT_CONFIGS["BOOST"] };
  const dyn = loadDynamicConfig()[botName];
  if (!dyn) return base;
  for (const [key, val] of Object.entries(dyn)) {
    if (key in base && typeof val === "number") (base as any)[key] = val;
  }
  return base;
}

function applyDynamicAdjust(bot: string, param: string, value: number, reason: string): boolean {
  const bounds = PARAM_BOUNDS[param];
  if (!bounds) return false;
  const clamped = Math.max(bounds[0], Math.min(bounds[1], value));
  const cfg = loadDynamicConfig();
  if (!cfg[bot]) cfg[bot] = {};
  const oldVal = (cfg[bot] as any)[param] ?? (BOT_CONFIGS[bot] as any)?.[param] ?? 0;
  (cfg[bot] as any)[param] = clamped;
  saveDynamicConfig(cfg);
  dynamicConfigLog.push({ bot, param, old: oldVal, val: clamped, reason: reason.slice(0, 50), time: new Date().toISOString().slice(11, 19) });
  if (dynamicConfigLog.length > 20) dynamicConfigLog.splice(0, dynamicConfigLog.length - 20);
  return true;
}

// ── DEEP LEARNING SYSTEM — Echtes Lernen, nicht nur Parameter-Tuning ─────────
const DEEP_LEARN_FILE = "data/bob-deep-learn.json";

interface DeepLearnData {
  // 1. Score-Gewichte: Opus kann die Scoring-Formel anpassen
  scoreWeights: {
    momentum1h: number;    // Gewichtung 1h-Change (default 1.0)
    ageFactor: number;     // Gewichtung Alter (default 1.0)
    liqFactor: number;     // Gewichtung Liquidität (default 1.0)
    reversalFactor: number; // Gewichtung Reversal-Pattern (default 1.0)
    activityFactor: number; // Gewichtung Aktivität (default 1.0)
    buyPressure: number;   // Gewichtung Buy-Pressure (default 1.0)
  };
  // 2. Route-Erfolg: welche Swap-Route klappt bei welchem Token-Typ
  routeStats: Record<string, { v2: number; v2hop: number; v3: number; fourmeme: number; total: number }>;
  // 3. Pattern-Erkennung: Muster die Opus erkannt hat
  patterns: { pattern: string; action: "avoid" | "prefer" | "caution"; confidence: number; source: string; hits: number; added: string }[];
  // 4. Cross-Bot Strategien: was funktioniert bei welchem Bot
  botStrategies: Record<string, { winTokenTypes: string[]; lossTokenTypes: string[]; bestTimeOfDay: string; avgWinAge: number; avgLossAge: number }>;
  // 5. Meta: wann zuletzt gelernt
  lastDeepReview: number;
  totalDeepReviews: number;
}

function loadDeepLearn(): DeepLearnData {
  try {
    if (existsSync(DEEP_LEARN_FILE)) return JSON.parse(readFileSync(DEEP_LEARN_FILE, "utf-8"));
  } catch {}
  return {
    scoreWeights: { momentum1h: 1.0, ageFactor: 1.0, liqFactor: 1.0, reversalFactor: 1.0, activityFactor: 1.0, buyPressure: 1.0 },
    routeStats: {},
    patterns: [],
    botStrategies: {},
    lastDeepReview: 0,
    totalDeepReviews: 0,
  };
}

function saveDeepLearn(data: DeepLearnData): void {
  try { writeFileSync(DEEP_LEARN_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// Route-Tracking: nach jedem Buy/Sell die erfolgreiche Route speichern
function trackRoute(tokenAddress: string, route: "v2" | "v2hop" | "v3" | "fourmeme", success: boolean): void {
  const dl = loadDeepLearn();
  // Gruppiere Token-Typen: four.meme (4444), fresh (<30min bekannt), established
  const isFourMeme = tokenAddress.toLowerCase().endsWith("4444");
  const key = isFourMeme ? "fourmeme" : "pancake";
  if (!dl.routeStats[key]) dl.routeStats[key] = { v2: 0, v2hop: 0, v3: 0, fourmeme: 0, total: 0 };
  if (success) dl.routeStats[key][route]++;
  dl.routeStats[key].total++;
  saveDeepLearn(dl);
}

// Beste Route für Token-Typ ermitteln
function getBestRoute(tokenAddress: string): string | null {
  const dl = loadDeepLearn();
  const isFourMeme = tokenAddress.toLowerCase().endsWith("4444");
  const key = isFourMeme ? "fourmeme" : "pancake";
  const rs = dl.routeStats[key];
  if (!rs || rs.total < 3) return null; // Nicht genug Daten
  const best = Object.entries(rs).filter(([k]) => k !== "total").sort((a, b) => (b[1] as number) - (a[1] as number));
  return best[0]?.[1] as number > 0 ? best[0][0] : null;
}

// Pattern-Check: passt ein Token zu einem bekannten Muster?
function checkPatterns(pool: PoolData): { action: "avoid" | "prefer" | "caution"; pattern: string } | null {
  const dl = loadDeepLearn();
  for (const p of dl.patterns) {
    if (p.confidence < 70) continue;
    // Pattern-Matching: einfache Regex auf Token-Name + Eigenschaften
    try {
      if (p.pattern.startsWith("name:")) {
        const regex = new RegExp(p.pattern.slice(5), "i");
        if (regex.test(pool.name)) {
          p.hits++;
          saveDeepLearn(dl);
          return { action: p.action, pattern: p.pattern };
        }
      } else if (p.pattern.startsWith("liq<") && pool.liq < parseFloat(p.pattern.slice(4))) {
        return { action: p.action, pattern: p.pattern };
      } else if (p.pattern.startsWith("age<") && pool.age < parseFloat(p.pattern.slice(4))) {
        return { action: p.action, pattern: p.pattern };
      } else if (p.pattern.startsWith("c1<") && pool.c1 < parseFloat(p.pattern.slice(3))) {
        return { action: p.action, pattern: p.pattern };
      }
    } catch {}
  }
  return null;
}

// Cross-Bot Learning: Bot-Strategie updaten nach Trade
function updateBotStrategy(botName: string, token: string, pnlPct: number, age: number): void {
  const dl = loadDeepLearn();
  if (!dl.botStrategies[botName]) {
    dl.botStrategies[botName] = { winTokenTypes: [], lossTokenTypes: [], bestTimeOfDay: "", avgWinAge: 0, avgLossAge: 0 };
  }
  const bs = dl.botStrategies[botName];
  if (pnlPct > 2) {
    bs.winTokenTypes.push(token);
    if (bs.winTokenTypes.length > 20) bs.winTokenTypes.shift();
    bs.avgWinAge = bs.avgWinAge > 0 ? (bs.avgWinAge + age) / 2 : age;
  } else if (pnlPct < -5) {
    bs.lossTokenTypes.push(token);
    if (bs.lossTokenTypes.length > 20) bs.lossTokenTypes.shift();
    bs.avgLossAge = bs.avgLossAge > 0 ? (bs.avgLossAge + age) / 2 : age;
  }
  bs.bestTimeOfDay = new Date().toISOString().slice(11, 13); // Stunde
  saveDeepLearn(dl);
}

// DEEP REVIEW: Opus analysiert ALLES und lernt echt
const deepLearnLog: { what: string; detail: string; time: string }[] = [];

async function opusDeepReview(log: (msg: string) => void): Promise<void> {
  const dl = loadDeepLearn();
  const journal = loadJournal();
  const totalSells = journal.filter(e => e.action === "SELL" && e.success).length;

  // Alle 5 Sells tief reviewen
  if (totalSells < 5 || Date.now() - dl.lastDeepReview < 10 * 60_000) return;

  log(`\n🧬 OPUS DEEP REVIEW — echtes Lernen (#${dl.totalDeepReviews + 1})`);

  const recentTrades = journal.slice(-30).map(e =>
    `${e.agent} ${e.action} ${e.token} addr:${e.address.slice(0, 10)} | ${e.bnbAmount}BNB | P&L:${e.pnlPct?.toFixed(1) ?? "?"}% | ${e.success ? "OK" : "FAIL"} | ${e.reason.slice(0, 50)}`
  ).join("\n");

  const currentWeights = dl.scoreWeights;
  const routeInfo = Object.entries(dl.routeStats).map(([k, v]) => `${k}: v2=${v.v2} v2hop=${v.v2hop} v3=${v.v3} fm=${v.fourmeme} (total:${v.total})`).join("\n") || "Noch keine Route-Daten";
  const patternInfo = dl.patterns.map(p => `${p.action}: ${p.pattern} (conf:${p.confidence} hits:${p.hits})`).join("\n") || "Noch keine Patterns";
  const botStratInfo = Object.entries(dl.botStrategies).map(([b, s]) =>
    `${b}: wins=[${s.winTokenTypes.slice(-5).join(",")}] losses=[${s.lossTokenTypes.slice(-5).join(",")}] avgWinAge:${s.avgWinAge.toFixed(0)}min avgLossAge:${s.avgLossAge.toFixed(0)}min`
  ).join("\n") || "Noch keine Bot-Strategien";

  try {
    const res = await anthropic.messages.create({
      model: OPUS,
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `Du bist der Deep Learning Engine des BOB Trading Squad auf BSC.
Deine Aufgabe: ECHTE Muster erkennen und die Bots FUNDAMENTAL verbessern.

TRADE JOURNAL (letzte 30):
${recentTrades}

AKTUELLE SCORE-GEWICHTE (1.0 = normal, >1 = mehr Gewicht, <1 = weniger):
momentum1h: ${currentWeights.momentum1h}
ageFactor: ${currentWeights.ageFactor}
liqFactor: ${currentWeights.liqFactor}
reversalFactor: ${currentWeights.reversalFactor}
activityFactor: ${currentWeights.activityFactor}
buyPressure: ${currentWeights.buyPressure}

ROUTE-STATISTIKEN:
${routeInfo}

ERKANNTE PATTERNS:
${patternInfo}

BOT-STRATEGIEN:
${botStratInfo}

Analysiere die Daten und generiere Anpassungen. NUR was durch Daten belegt ist!

1. SCORE-GEWICHTE anpassen (0.3 bis 3.0):
   WEIGHT: momentum1h = 1.2 (Grund)
   WEIGHT: ageFactor = 0.8 (Grund)

2. NEUE PATTERNS erkennen:
   PATTERN: avoid name:regex (Grund) confidence:80
   PATTERN: prefer liq>50 (Grund) confidence:75
   PATTERN: caution age<5 (Grund) confidence:70

3. CROSS-BOT Empfehlungen:
   CROSSBOT: BLAZE sollte von BRAIN lernen: ... (Grund)

Nur generieren was durch echte Trade-Daten BELEGT ist!`,
      }],
    });

    const text = res.content.find(b => b.type === "text")?.text ?? "";

    // 1. Score-Gewichte
    const weightLines = text.split("\n").filter(l => l.trim().startsWith("WEIGHT:"));
    for (const wl of weightLines) {
      const m = wl.match(/WEIGHT:\s*(\w+)\s*=\s*([\d.]+)\s*\((.+)\)/);
      if (m) {
        const [, key, valStr, reason] = m;
        const val = Math.max(0.3, Math.min(3.0, parseFloat(valStr)));
        if (key in dl.scoreWeights && !isNaN(val)) {
          const old = (dl.scoreWeights as any)[key];
          (dl.scoreWeights as any)[key] = val;
          log(`  ⚖️ Score ${key}: ${old.toFixed(1)}→${val.toFixed(1)} (${reason.slice(0, 40)})`);
          deepLearnLog.push({ what: `WEIGHT ${key}`, detail: `${old.toFixed(1)}→${val.toFixed(1)}: ${reason.slice(0, 40)}`, time: new Date().toISOString().slice(11, 19) });
        }
      }
    }

    // 2. Patterns
    const patternLines = text.split("\n").filter(l => l.trim().startsWith("PATTERN:"));
    for (const pl of patternLines) {
      const m = pl.match(/PATTERN:\s*(avoid|prefer|caution)\s+(\S+)\s*\((.+?)\)\s*confidence:(\d+)/);
      if (m) {
        const [, action, pattern, reason, confStr] = m;
        const confidence = Math.max(50, Math.min(100, parseInt(confStr)));
        // Duplikat-Check
        if (!dl.patterns.find(p => p.pattern === pattern)) {
          dl.patterns.push({ pattern, action: action as any, confidence, source: reason.slice(0, 50), hits: 0, added: new Date().toISOString() });
          log(`  🔍 Pattern: ${action} ${pattern} (${confidence}%) — ${reason.slice(0, 40)}`);
          deepLearnLog.push({ what: `PATTERN ${action}`, detail: `${pattern}: ${reason.slice(0, 40)}`, time: new Date().toISOString().slice(11, 19) });
          if (dl.patterns.length > 30) dl.patterns.shift(); // Max 30 Patterns
        }
      }
    }

    // 3. Cross-Bot Empfehlungen → als Team-Message
    const crossLines = text.split("\n").filter(l => l.trim().startsWith("CROSSBOT:"));
    for (const cl of crossLines) {
      const advice = cl.replace("CROSSBOT:", "").trim();
      if (advice.length > 10) {
        log(`  🤝 Cross-Bot: ${advice.slice(0, 60)}`);
        await sendMessage("OPUS", "ALL", `🧬 Deep Learning: ${advice.slice(0, 80)}`);
        deepLearnLog.push({ what: "CROSSBOT", detail: advice.slice(0, 50), time: new Date().toISOString().slice(11, 19) });
      }
    }

    dl.lastDeepReview = Date.now();
    dl.totalDeepReviews++;
    saveDeepLearn(dl);
    log(`  🧬 ✅ Deep Review #${dl.totalDeepReviews} — ${weightLines.length} weights, ${patternLines.length} patterns`);

  } catch (e) {
    log(`  ❌ Deep Review: ${String(e).slice(0, 50)}`);
  }
}

interface Agent  { name: string; role: string; wallet: Wallet; color: string; startDelay: number; interval: number; focus: "new" | "volume" | "trending" | "treasury"; }
interface Position { address: string; symbol: string; entryBnb: number; enteredAt: number; entryPrice?: number; }
interface TradeSignal { action: "BUY" | "SELL" | "HOLD"; tokenAddress?: string; tokenSymbol?: string; bnbAmount?: number; sellPct?: number; reason: string; confidence?: number; }
interface JournalEntry {
  agent: string; action: "BUY" | "SELL"; token: string; address: string;
  bnbAmount: number; price: number; pnlPct?: number; bnbResult?: number;
  timestamp: string; success: boolean; reason: string;
}

// ── Stats ──────────────────────────────────────────────────────────────────────
const stats: Record<string, { iterations: number; buys: number; sells: number; profitBnb: number; errors: number; opusCalls: number; sonnetCalls: number; haikuCalls: number; autoApproves: number; lastBnb: number }> = {};
function getStats(name: string) {
  if (!stats[name]) stats[name] = { iterations: 0, buys: 0, sells: 0, profitBnb: 0, errors: 0, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, autoApproves: 0, lastBnb: 0 };
  return stats[name];
}

// ── Buy Lock — verhindert dass 2 Bots gleichzeitig denselben Token kaufen ──
const buyingTokens = new Set<string>();
function tryClaimToken(addr: string): boolean {
  const key = addr.toLowerCase();
  if (buyingTokens.has(key)) return false;
  buyingTokens.add(key);
  return true;
}
function releaseClaim(addr: string): void {
  buyingTokens.delete(addr.toLowerCase());
}

// ── Atomic State Mutex ─────────────────────────────────────────────────────────
let stateLock = false;
async function withState<T>(fn: (state: any) => T): Promise<T> {
  while (stateLock) await sleep(50 + Math.random() * 100);
  stateLock = true;
  try {
    const state = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {};
    const result = fn(state);
    writeFileSync(SWARM, JSON.stringify(state, null, 2));
    return result;
  } finally { stateLock = false; }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. TRADE JOURNAL — Jeder Trade wird geloggt
// ══════════════════════════════════════════════════════════════════════════════

function loadJournal(): JournalEntry[] {
  try { return existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, "utf-8")) : []; }
  catch { return []; }
}

function logTrade(entry: JournalEntry): void {
  const journal = loadJournal();
  journal.push(entry);
  // Max 200 Einträge
  if (journal.length > 200) journal.splice(0, journal.length - 200);
  writeFileSync(JOURNAL, JSON.stringify(journal, null, 2));
}

function getTradeStats(): { total: number; wins: number; losses: number; neutral: number; winRate: number; avgPnl: number; totalBnb: number } {
  const journal = loadJournal();
  const sells = journal.filter(e => e.action === "SELL" && e.success);
  const wins = sells.filter(e => (e.pnlPct ?? 0) > 2);       // Echte Gewinne: >2%
  const losses = sells.filter(e => (e.pnlPct ?? 0) < -5);     // Echte Verluste: <-5%
  const neutral = sells.filter(e => (e.pnlPct ?? 0) >= -5 && (e.pnlPct ?? 0) <= 2); // Timeouts, ~0% = NEUTRAL
  const avgPnl = sells.length > 0 ? sells.reduce((s, e) => s + (e.pnlPct ?? 0), 0) / sells.length : 0;
  const totalBnb = sells.reduce((s, e) => s + (e.bnbResult ?? 0), 0);
  const realTrades = wins.length + losses.length;
  return { total: journal.length, wins: wins.length, losses: losses.length, neutral: neutral.length, winRate: realTrades > 0 ? wins.length / realTrades * 100 : 50, avgPnl, totalBnb };
}

function getJournalSummary(): string {
  const s = getTradeStats();
  if (s.total === 0) return "Noch keine Trades.";
  return `Journal: ${s.wins}W/${s.losses}L/${s.neutral}N (${s.winRate.toFixed(0)}%) | avg:${s.avgPnl.toFixed(1)}% | ${s.totalBnb.toFixed(4)} BNB`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. HONEYPOT CHECK — Vor Buy prüfen ob Token sellbar ist
// ══════════════════════════════════════════════════════════════════════════════

// Quick Honeypot — nutzt Pool-Daten die wir SCHON haben (kein extra API-Call!)
function quickHoneypotCheck(p: ScoredPool): { safe: boolean; reason: string; hardFail: boolean } | null {
  const isFresh = p.age > 0 && p.age < 30; // <30min = frischer Meme Launch

  // ── HONEYPOT CHECKS — sells sind der wichtigste Indikator! ──

  // 0 sells = IMMER honeypot, egal wie frisch
  if (p.sells === 0 && p.buys > 5) return { safe: false, reason: `HONEYPOT: ${p.buys}buys 0sells`, hardFail: true };
  if (p.sells === 0) return { safe: false, reason: `NO SELLS: 0/${p.buys}buys — zu riskant`, hardFail: false };

  // B/S ratio zu hoch = verdächtig
  if (p.ratio > 20) return { safe: false, reason: `VERDÄCHTIG: B/S ${p.ratio.toFixed(0)}:1`, hardFail: true };
  if (p.ratio > 10) return { safe: false, reason: `HIGH RATIO: B/S ${p.ratio.toFixed(0)}:1`, hardFail: false };

  // Frische Memes: mindestens 3 sells nötig als Beweis dass man verkaufen KANN
  if (isFresh) {
    if (p.sells < 3) return { safe: false, reason: `FRESH aber nur ${p.sells}sells — warte`, hardFail: false };
    if (p.liq < 1) return { safe: false, reason: `MICRO LIQ: $${p.liq}k`, hardFail: false };
    return { safe: true, reason: `FRESH OK: ${p.sells}sells $${p.liq}k ${p.age}min`, hardFail: false };
  }

  // Etablierte Tokens: strenger
  if (p.sells < 5) return { safe: false, reason: `LOW SELLS: nur ${p.sells}sells`, hardFail: false };
  if (p.liq < 5) return { safe: false, reason: `LOW LIQ: $${p.liq}k`, hardFail: false };
  return { safe: true, reason: `OK: ${p.sells}sells $${p.liq}k ${p.age}min score:${p.score}`, hardFail: false };
}

// Honeypot Cache — Ergebnis 2min cachen, spart API-Calls + verhindert Blacklist-Spam
const hpCache: Record<string, { result: { safe: boolean; reason: string; hardFail: boolean }; ts: number }> = {};

async function honeypotCheck(tokenAddress: string): Promise<{ safe: boolean; reason: string; hardFail: boolean }> {
  const key = tokenAddress.toLowerCase();
  const cached = hpCache[key];
  if (cached && Date.now() - cached.ts < 120_000) return cached.result;

  let result: { safe: boolean; reason: string; hardFail: boolean };
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${tokenAddress}/pools?page=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const data = await res.json() as any;
    const pool = data.data?.[0]?.attributes;

    if (!pool) {
      // API findet keinen Pool — KEIN Blacklist, nur skip (API-Fehler, kein Honeypot)
      result = { safe: false, reason: "Kein Pool via API — skip (kein Blacklist)", hardFail: false };
      hpCache[key] = { result, ts: Date.now() };
      return result;
    }

    const buys24h  = parseInt(pool.transactions?.h24?.buys  ?? "0");
    const sells24h = parseInt(pool.transactions?.h24?.sells ?? "0");
    const liq      = parseFloat(pool.reserve_in_usd ?? "0");
    const vol      = parseFloat(pool.volume_usd?.h24 ?? "0");
    const age      = pool.pool_created_at ? (Date.now() - new Date(pool.pool_created_at).getTime()) / 60000 : 0;

    const isFresh = age < 30; // <30min = frisch
    // Echte Honeypot-Checks → hardFail = true = Blacklist
    if (sells24h === 0 && buys24h > 5) {
      result = { safe: false, reason: `HONEYPOT: ${buys24h} buys 0 sells`, hardFail: true };
    } else if (sells24h === 0) {
      result = { safe: false, reason: `NO SELLS: warte auf erste sells`, hardFail: false };
    } else if (buys24h / sells24h > 20) {
      result = { safe: false, reason: `VERDÄCHTIG: B/S ${(buys24h / sells24h).toFixed(0)}:1`, hardFail: true };
    } else if (isFresh && sells24h < 3) {
      result = { safe: false, reason: `FRESH LOW SELLS: nur ${sells24h} sells`, hardFail: false };
    } else if (!isFresh && liq < 5000) {
      result = { safe: false, reason: `LOW LIQ: $${Math.round(liq / 1000)}k`, hardFail: false };
    } else if (isFresh && liq < 1000) {
      result = { safe: false, reason: `MICRO LIQ: $${Math.round(liq)}`, hardFail: false };
    } else if (vol > 0 && liq > 0 && vol / liq > 12) {
      result = { safe: false, reason: `WASH: Vol/Liq ${(vol / liq).toFixed(1)}`, hardFail: false };
    } else {
      result = { safe: true, reason: `OK: ${sells24h}sells $${Math.round(liq / 1000)}k ${Math.round(age)}min`, hardFail: false };
    }
  } catch {
    // API-Fehler = NICHT blacklisten, einfach skip
    result = { safe: false, reason: "API timeout — skip", hardFail: false };
  }
  hpCache[key] = { result, ts: Date.now() };
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. WATCHLIST — Erst beobachten, dann handeln!
// ══════════════════════════════════════════════════════════════════════════════

interface WatchlistSnapshot {
  ts: number;
  price: number;
  vol: number;    // $k
  liq: number;    // $k
  buys: number;
  sells: number;
  c1: number;     // 1h change %
}

interface WatchlistEntry {
  addr: string;
  symbol: string;
  score: number;
  dex: string;
  addedAt: number;
  snapshots: WatchlistSnapshot[];
  pool: ScoredPool;   // letzte Pool-Daten
}

// Watchlist pro Bot (in-memory — kurzlebige Opportunities)
const watchlists: Record<string, Map<string, WatchlistEntry>> = {};

function getWatchlist(botName: string): Map<string, WatchlistEntry> {
  if (!watchlists[botName]) watchlists[botName] = new Map();
  return watchlists[botName];
}

function addToWatchlist(botName: string, pool: ScoredPool): void {
  const wl = getWatchlist(botName);
  const key = pool.addr.toLowerCase();

  // Max 15 pro Bot — älteste rauswerfen
  if (wl.size >= 15 && !wl.has(key)) {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of wl) {
      if (v.addedAt < oldestTs) { oldestTs = v.addedAt; oldest = k; }
    }
    if (oldest) wl.delete(oldest);
  }

  const existing = wl.get(key);
  const snapshot: WatchlistSnapshot = {
    ts: Date.now(),
    price: pool.price,
    vol: pool.vol,
    liq: pool.liq,
    buys: pool.buys,
    sells: pool.sells,
    c1: pool.c1,
  };

  if (existing) {
    // Update: neuen Snapshot hinzufügen (max 10)
    existing.snapshots.push(snapshot);
    if (existing.snapshots.length > 10) existing.snapshots.shift();
    existing.pool = pool;
    existing.score = pool.score;
  } else {
    // Neu: erster Snapshot
    wl.set(key, {
      addr: pool.addr,
      symbol: pool.name.split("/")[0]?.trim() ?? pool.name,
      score: pool.score,
      dex: pool.dex,
      addedAt: Date.now(),
      snapshots: [snapshot],
      pool,
    });
  }
}

// Alte Watchlist-Einträge aufräumen (>10min ohne Entry = raus)
function cleanWatchlist(botName: string): number {
  const wl = getWatchlist(botName);
  const maxAge = 10 * 60_000; // 10 Minuten max auf Watchlist
  let removed = 0;
  for (const [key, entry] of wl) {
    if (Date.now() - entry.addedAt > maxAge) {
      wl.delete(key);
      removed++;
    }
  }
  return removed;
}

// DAS HERZ: Prüfe ob ein Watchlist-Token bereit zum Kauf ist
interface EntrySignal {
  ready: boolean;
  reason: string;
  confidence: number;  // 0-100
  urgency: number;     // 0-10 (höher = schneller handeln)
}

function checkEntrySignal(entry: WatchlistEntry): EntrySignal {
  const snaps = entry.snapshots;
  const pool = entry.pool;

  // ── MINIMUM: Brauchen mindestens 2 Snapshots (= beobachtet über 1+ Zyklen)
  if (snaps.length < 2) {
    return { ready: false, reason: `Beobachte... (${snaps.length}/2 Snapshots)`, confidence: 0, urgency: 0 };
  }

  // ── SELL PROOF: Token muss bewiesen verkaufbar sein
  if (pool.sells < 5) {
    return { ready: false, reason: `Nur ${pool.sells} sells — warte auf 5+`, confidence: 0, urgency: 0 };
  }

  // ── HONEYPOT SIGNALS
  if (pool.ratio > 15) {
    return { ready: false, reason: `B/S ${pool.ratio.toFixed(0)}:1 zu hoch`, confidence: 0, urgency: 0 };
  }

  // ── MOMENTUM CHECK: Vergleiche ersten und letzten Snapshot
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const timeDiffMin = (last.ts - first.ts) / 60_000;

  // Preis-Trend: steigt der Preis?
  const priceChange = first.price > 0 ? ((last.price - first.price) / first.price) * 100 : 0;

  // Volume-Trend: steigt das Volume?
  const volChange = first.vol > 0 ? ((last.vol - first.vol) / first.vol) * 100 : 0;

  // Buy-Activity: kommen neue Käufer?
  const newBuys = last.buys - first.buys;

  // Sell-Activity: gibt es auch Verkäufer? (= gesunder Markt)
  const newSells = last.sells - first.sells;

  let confidence = 0;
  let urgency = 0;
  const reasons: string[] = [];

  // ── PREIS STEIGT = Hauptsignal
  if (priceChange > 5) {
    confidence += 35;
    urgency += 3;
    reasons.push(`Preis +${priceChange.toFixed(1)}%`);
  } else if (priceChange > 2) {
    confidence += 20;
    urgency += 1;
    reasons.push(`Preis +${priceChange.toFixed(1)}%`);
  } else if (priceChange < -5) {
    // Preis fällt = NICHT kaufen
    return { ready: false, reason: `Preis fällt: ${priceChange.toFixed(1)}%`, confidence: 0, urgency: 0 };
  }

  // ── VOLUME STEIGT = Bestätigung
  if (volChange > 10) {
    confidence += 20;
    urgency += 2;
    reasons.push(`Vol +${volChange.toFixed(0)}%`);
  } else if (volChange > 0) {
    confidence += 10;
    reasons.push(`Vol stabil`);
  }

  // ── NEUE KÄUFER = Nachfrage
  if (newBuys > 10) {
    confidence += 15;
    urgency += 2;
    reasons.push(`+${newBuys} buys`);
  } else if (newBuys > 3) {
    confidence += 10;
    reasons.push(`+${newBuys} buys`);
  }

  // ── AKTUELLE 1h-CHANGE = zusätzliches Momentum
  if (last.c1 > 10) {
    confidence += 15;
    urgency += 2;
    reasons.push(`1h:+${last.c1.toFixed(0)}%`);
  } else if (last.c1 > 3) {
    confidence += 10;
    reasons.push(`1h:+${last.c1.toFixed(0)}%`);
  } else if (last.c1 < -10) {
    confidence -= 20;
    reasons.push(`1h:${last.c1.toFixed(0)}% ⚠️`);
  }

  // ── GESUNDE SELLS = Markt funktioniert
  if (newSells > 2) {
    confidence += 10;
    reasons.push(`+${newSells} sells (gesund)`);
  }

  // ── LIQUIDITÄT OK
  if (pool.liq >= 10) {
    confidence += 5;
  }

  // ── SCORE BONUS
  if (pool.score >= 50) confidence += 10;

  // ── ENTRY DECISION: Confidence >= 60 = bereit!
  const ready = confidence >= 60;
  const reason = reasons.join(" | ") || "Keine Signale";

  return { ready, reason, confidence, urgency };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. SMART LEARNING — Opus reviewed nach 10 Trades
// ══════════════════════════════════════════════════════════════════════════════

let lastReviewCount = 0;

async function opusStrategyReview(log: (msg: string) => void): Promise<void> {
  const journal = loadJournal();
  const totalSells = journal.filter(e => e.action === "SELL" && e.success).length;

  // Alle 3 abgeschlossenen Trades reviewen — lernt SCHNELL! (war 3, jetzt öfter)
  if (totalSells < lastReviewCount + 2) return;
  lastReviewCount = totalSells;

  log(`\n🎓 OPUS STRATEGY REVIEW — nach ${totalSells} abgeschlossenen Trades`);

  const recentTrades = journal.slice(-20).map(e =>
    `${e.agent} ${e.action} ${e.token} | ${e.bnbAmount}BNB | Price:$${e.price.toPrecision(4)} | P&L:${e.pnlPct?.toFixed(1) ?? "?"}% | ${e.success ? "✅" : "❌"} | ${e.reason.slice(0, 40)}`
  ).join("\n");

  const stats = getTradeStats();
  const currentLessons = loadLessons();

  try {
    const res = await anthropic.messages.create({
      model: OPUS,
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Du bist der Head Strategist des BOB Trading Squad auf BSC.

TRADE JOURNAL (letzte 20):
${recentTrades}

STATISTIKEN:
Win Rate: ${stats.winRate.toFixed(0)}% | Wins: ${stats.wins} | Losses: ${stats.losses} | Avg P&L: ${stats.avgPnl.toFixed(1)}%

AKTUELLE REGELN:
${currentLessons || "Noch keine Learnings"}

AKTUELLE BOT-CONFIGS:
BLAZE: ${JSON.stringify(getEffectiveConfig("BLAZE"))}
BRAIN: ${JSON.stringify(getEffectiveConfig("BRAIN"))}
BOOST: ${JSON.stringify(getEffectiveConfig("BOOST"))}

Analysiere die Trades und:
1. Generiere 2-3 NEUE konkrete Regeln. Format: RULE: ...
2. Passe Bot-Parameter an basierend auf echten Mustern! Format:
   ADJUST: BOTNAME.param = value (Grund)
   Erlaubte Params: minScore(15-60) tpPct(5-30) slPct(-25 bis -5) scalpPct(3-15) scalpMinAge(2-10) maxAge(10-60) staleAge(8-40)
   Beispiel: ADJUST: BLAZE.tpPct = 6 (80% Wins unter 6%)
   Beispiel: ADJUST: BRAIN.minScore = 50 (zu viele Losses bei Score 45-49)
Nur ändern was durch Daten belegt ist!`,
      }],
    });

    const text = res.content.find(b => b.type === "text")?.text ?? "";

    // 1. Regeln lernen
    const rules = text.split("\n").filter(l => l.startsWith("RULE:")).map(l => l.replace("RULE:", "").trim());
    if (rules.length > 0) {
      log(`  📚 ${rules.length} neue Regeln:`);
      for (const rule of rules) {
        log(`     • ${rule.slice(0, 80)}`);
        saveMemory("STRATEGY", `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, rule, "pattern");
      }
    }

    // 2. Parameter-Anpassungen als CODE anwenden!
    const adjusts = text.split("\n").filter(l => l.trim().startsWith("ADJUST:"));
    let adjustCount = 0;
    for (const adj of adjusts) {
      const m = adj.match(/ADJUST:\s*(\w+)\.(\w+)\s*=\s*([\d.\-]+)\s*\((.+)\)/);
      if (m) {
        const [, bot, param, valStr, reason] = m;
        const val = parseFloat(valStr);
        if (!isNaN(val) && applyDynamicAdjust(bot, param, val, reason)) {
          log(`  ⚙️ ${bot}.${param} = ${val} (${reason.slice(0, 40)})`);
          adjustCount++;
        }
      }
    }

    const msg = adjustCount > 0
      ? `🎓 Review: ${rules.length} Regeln + ${adjustCount} Config-Änderungen. WR:${stats.winRate.toFixed(0)}%`
      : `🎓 Review: ${rules.length} Regeln. WR:${stats.winRate.toFixed(0)}%`;
    await sendMessage("OPUS", "ALL", msg);
  } catch (e) {
    log(`  ❌ Strategy Review failed: ${String(e).slice(0, 60)}`);
  }
}

// ── OPUS TEAM KOORDINATION — BANK gibt Anweisungen ans Team ──────────────────
let lastCoordCount = 0;
async function opusTeamCoordination(traderData: { name: string; addr: string; bnb: number; posCount: number }[], log: (msg: string) => void): Promise<void> {
  const journal = loadJournal();
  const totalTrades = journal.filter(e => e.action === "BUY").length;

  // Alle 5 Trades koordiniert Opus das Team (war 6, jetzt öfter)
  if (totalTrades < lastCoordCount + 5) return;
  lastCoordCount = totalTrades;

  const jStats = getTradeStats();
  const allPos = getAllPositions();
  const posDetails = Object.entries(allPos).map(([name, positions]) => {
    const ps = positions as Position[];
    if (ps.length === 0) return `${name}: keine Positionen`;
    return `${name}: ${ps.map(p => {
      const age = Math.round((Date.now() - p.enteredAt) / 60000);
      return `${p.symbol}(${age}min, ${p.entryBnb}BNB)`;
    }).join(", ")}`;
  }).join("\n");

  const traderStatus = traderData.map(t => `${t.name}: ${t.bnb.toFixed(4)} BNB, ${t.posCount} Positionen`).join("\n");
  const lessons = loadLessons();

  log(`\n🎯 OPUS TEAM COORDINATION — nach ${totalTrades} Trades`);

  try {
    const res = await anthropic.messages.create({
      model: OPUS,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Du bist BANK — der Teamchef des BOB Trading Squad auf BSC.
Dein Ziel: Team-Profit maximieren UND $BOB pushen.

TEAM STATUS:
${traderStatus}

POSITIONEN:
${posDetails}

PERFORMANCE: ${jStats.wins}W/${jStats.losses}L/${jStats.neutral}N (${jStats.winRate.toFixed(0)}%) | Avg P&L: ${jStats.avgPnl.toFixed(1)}%

BOT ROLLEN:
- BLAZE (Sniper): Frische Tokens, schnell rein/raus, max 20min
- BRAIN (Analyst): Nur Quality, min $10k liq, hält bis +20%
- BOOST (Momentum): Pumps + Reversals, reitet Wellen

GELERNTE REGELN:
${lessons || "Noch keine"}

Gib 1-3 kurze ANWEISUNGEN ans Team. Format: "→ BOTNAME: Anweisung"
Beispiele:
→ BLAZE: Weniger Trades, dafür nur Score 40+
→ BRAIN: Halte länger, dein TP von 20% ist gut
→ BOOST: Fokus auf Reversals, die letzten 2 Momentum-Trades waren Losses
→ ALL: Mehr verkaufen, zu viele Positionen offen

Nur konkrete, datenbasierte Anweisungen!`,
      }],
    });

    const text = res.content.find(b => b.type === "text")?.text ?? "";
    const commands = text.split("\n").filter(l => l.trim().startsWith("→"));

    if (commands.length > 0) {
      log(`  🎯 OPUS Anweisungen:`);
      for (const cmd of commands) {
        log(`     ${cmd.trim()}`);
        // Parse: → BOTNAME: text
        const match = cmd.match(/→\s*(\w+):\s*(.+)/);
        if (match) {
          const target = match[1].toUpperCase();
          const instruction = match[2].trim();
          await sendMessage("BANK", target, `🎯 BANK: ${instruction}`);
          // Speichere als Lesson wenn es eine allgemeine Regel ist
          if (target === "ALL") {
            saveMemory("BANK", `coord_${Date.now()}`, instruction, "lesson");
          }
        }
      }
    }
  } catch (e) {
    log(`  ❌ Coordination failed: ${String(e).slice(0, 60)}`);
  }
}

// ── OPUS LEARN FROM TRADE — Bot lernt aus eigenem Trade ──────────────────────
async function opusLearnFromTrade(botName: string, token: string, pnlPct: number, reason: string, age: number, log: (msg: string) => void): Promise<void> {
  // Bei signifikanten Trades lernen (war >8%, jetzt >5% = lernt öfter)
  if (Math.abs(pnlPct) < 5) return;

  const lessons = loadLessons();
  const outcome = pnlPct > 0 ? "WIN" : "LOSS";

  try {
    const res = await anthropic.messages.create({
      model: OPUS,
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `${botName} hat gerade ${token} verkauft: ${outcome} ${pnlPct.toFixed(1)}% nach ${age}min.
Grund: ${reason}

Aktuelle Regeln:
${lessons || "keine"}

Was kann ${botName} daraus lernen? Eine kurze Regel (max 20 Wörter).
Format: LEARN: [die Regel]`,
      }],
    });

    const text = res.content.find(b => b.type === "text")?.text ?? "";
    const match = text.match(/LEARN:\s*(.+)/);
    if (match) {
      const lesson = match[1].trim();
      saveMemory(botName, `learn_${Date.now()}`, lesson, "lesson");
      log(`  🎓 ${botName} gelernt: ${lesson.slice(0, 60)}`);
      await sendMessage(botName, "ALL", `🎓 Gelernt: ${lesson.slice(0, 50)}`);
    }
  } catch (e) {
    log(`  ❌ Learn failed: ${String(e).slice(0, 40)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. TEAM SIGNALS — BRAIN verifiziert, Team reagiert
// ══════════════════════════════════════════════════════════════════════════════

async function sendTeamSignal(from: string, tokenAddress: string, tokenSymbol: string, signalType: "VERIFIED_BUY" | "WARN_SELL" | "MOMENTUM" | "DUMP_WARN", reason: string): Promise<void> {
  await withState(state => {
    if (!state.signals) state.signals = [];
    state.signals.push({
      from, tokenAddress, tokenSymbol, type: signalType, reason,
      timestamp: new Date().toISOString(), used: false,
    });
    // Max 50 Signals
    if (state.signals.length > 50) state.signals = state.signals.slice(-50);
  });
}

function getTeamSignals(forAgent: string): { from: string; tokenAddress: string; tokenSymbol: string; type: string; reason: string; timestamp: string }[] {
  const state = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {};
  return (state.signals ?? [])
    .filter((s: any) => s.from !== forAgent && !s.used)
    .filter((s: any) => Date.now() - new Date(s.timestamp).getTime() < 10 * 60 * 1000) // Max 10min alt
    .slice(-5);
}

async function markSignalUsed(tokenAddress: string): Promise<void> {
  await withState(state => {
    if (state.signals) {
      for (const s of state.signals) {
        if (s.tokenAddress === tokenAddress) s.used = true;
      }
    }
  });
}

// ── Wallet laden ───────────────────────────────────────────────────────────────
function loadWallets(): Record<string, Wallet> {
  const raw: Wallet[] = JSON.parse(readFileSync("data/contest-wallets.json", "utf-8"));
  return Object.fromEntries(raw.map(w => [w.name.toUpperCase(), w]));
}

// ── Learnings ──────────────────────────────────────────────────────────────────
function loadLessons(): string {
  try {
    if (!existsSync(BRAINS)) return "";
    const brains = JSON.parse(readFileSync(BRAINS, "utf-8"));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const agent of Object.values(brains) as any[]) {
      for (const mem of Object.values(agent.memory ?? {}) as any[]) {
        if ((mem.type === "lesson" || mem.type === "pattern") && mem.confidence >= 80 && !seen.has(mem.value)) {
          seen.add(mem.value);
          out.push(`• ${mem.value}`);
        }
      }
    }
    return out.length > 0 ? `\nLearnings:\n${out.slice(0, 15).join("\n")}` : "";
  } catch { return ""; }
}

function saveMemory(agentName: string, key: string, value: string, type = "lesson"): void {
  try {
    const brains = existsSync(BRAINS) ? JSON.parse(readFileSync(BRAINS, "utf-8")) : {};
    if (!brains[agentName]) brains[agentName] = { memory: {} };
    brains[agentName].memory[key] = {
      value, type, confidence: 85, confirmations: 1,
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), timesUsed: 0,
    };
    writeFileSync(BRAINS, JSON.stringify(brains, null, 2));
  } catch { /* ignore */ }
}

// ── State Helpers ──────────────────────────────────────────────────────────────
function getInbox(agentName: string): { from: string; text: string; time: string }[] {
  const state = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {};
  return (state.messages ?? []).filter((m: any) => m.to === agentName || m.to === "ALL").slice(-8);
}

async function sendMessage(from: string, to: string, text: string): Promise<void> {
  await withState(state => {
    if (!state.messages) state.messages = [];
    state.messages.push({ from, to, text, time: new Date().toISOString() });
    if (state.messages.length > 200) state.messages = state.messages.slice(-200);
  });
}

function getPositions(agentName: string): Position[] {
  const state = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {};
  return state.positions?.[agentName] ?? [];
}

function getAllPositions(): Record<string, Position[]> {
  const state = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {};
  return state.positions ?? {};
}

async function addPosition(agentName: string, address: string, symbol: string, entryBnb: number, entryPrice?: number): Promise<void> {
  await withState(state => {
    if (!state.positions) state.positions = {};
    if (!state.positions[agentName]) state.positions[agentName] = [];
    if (!state.positions[agentName].find((p: any) => p.address === address)) {
      state.positions[agentName].push({ address, symbol, entryBnb, enteredAt: Date.now(), entryPrice });
    }
  });
}

async function removePosition(agentName: string, address: string): Promise<void> {
  await withState(state => {
    if (state.positions?.[agentName]) {
      state.positions[agentName] = state.positions[agentName].filter((p: any) => p.address !== address);
    }
  });
}

function isTokenHeldByTeam(tokenAddress: string, excludeAgent?: string): string | null {
  const allPos = getAllPositions();
  for (const [agent, positions] of Object.entries(allPos)) {
    if (agent === excludeAgent) continue;
    if ((positions as Position[]).find(p => p.address.toLowerCase() === tokenAddress.toLowerCase())) return agent;
  }
  return null;
}

// ── Token Blacklist — Verlierer nicht nochmal kaufen ─────────────────────────
const tokenBlacklist = new Set<string>();
const swapFailList = new Set<string>(); // Tokens wo ALLE Swap-Routen scheitern

function blacklistToken(address: string): void {
  tokenBlacklist.add(address.toLowerCase());
}

function markSwapFail(address: string): void {
  swapFailList.add(address.toLowerCase());
}

function isBlacklisted(address: string): boolean {
  return tokenBlacklist.has(address.toLowerCase()) || swapFailList.has(address.toLowerCase());
}

// Persistente Blacklist — überlebt Restarts
const BLACKLIST_FILE = "data/bob-blacklist.json";
function loadBlacklistFromDisk(): void {
  try {
    if (existsSync(BLACKLIST_FILE)) {
      const list: string[] = JSON.parse(readFileSync(BLACKLIST_FILE, "utf-8"));
      for (const addr of list) tokenBlacklist.add(addr.toLowerCase());
    }
  } catch {}
  // Auch aus Journal laden
  const journal = loadJournal();
  for (const e of journal) {
    if (e.action === "SELL" && e.success && (e.pnlPct ?? 0) < -10) {
      tokenBlacklist.add(e.address.toLowerCase());
    }
  }
}
function saveBlacklistToDisk(): void {
  try {
    writeFileSync(BLACKLIST_FILE, JSON.stringify(Array.from(tokenBlacklist).concat(Array.from(swapFailList)), null, 2));
  } catch {}
}
// Save blacklist periodisch
let lastBlacklistSave = 0;
function maybeBlacklistSave(): void {
  if (Date.now() - lastBlacklistSave > 60_000) {
    saveBlacklistToDisk();
    lastBlacklistSave = Date.now();
  }
}

interface PoolData { name: string; addr: string; price: number; vol: number; liq: number; c1: number; c24: number; buys: number; sells: number; ratio: number; age: number; dex: string; }
interface ScoredPool extends PoolData { score: number; }

// ── Datenquellen: GeckoTerminal + DexScreener ───────────────────────────────
const CACHE_TTL = 20_000; // 20s Cache — schnellere Daten für Meme-Speed
const rawCache: Record<string, { data: ScoredPool[]; ts: number }> = {};

// Parse GeckoTerminal Pool-Daten in unser Format
function parseGeckoPools(data: any): PoolData[] {
  return (data.data ?? []).map((p: any) => {
    const a    = p.attributes;
    const addr = (p.relationships?.base_token?.data?.id ?? "").split("_")[1] ?? "";
    const vol  = Math.round(parseFloat(a.volume_usd?.h24 ?? "0") / 1000);
    const liq  = Math.round(parseFloat(a.reserve_in_usd ?? "0") / 1000);
    const c1   = parseFloat(a.price_change_percentage?.h1  ?? "0");
    const c24  = parseFloat(a.price_change_percentage?.h24 ?? "0");
    const buys  = parseInt(a.transactions?.h24?.buys  ?? "0");
    const sells = parseInt(a.transactions?.h24?.sells ?? "0");
    const ratio = sells > 0 ? buys / sells : 999;
    const age  = a.pool_created_at
      ? Math.round((Date.now() - new Date(a.pool_created_at).getTime()) / 60000)
      : 0;
    const price = parseFloat(a.base_token_price_usd ?? "0");
    const name = a.name ?? "?";
    // Detect DEX: "/ WBNB" = PancakeSwap, "/ BNB" = four.meme bonding curve
    const dex = name.includes("WBNB") || name.includes("USDT") || name.includes("USDC") ? "pancake" : "fourmeme";
    return { name, addr, price, vol, liq, c1, c24, buys, sells, ratio, age, dex };
  });
}

// Pre-Filter: nur tradeable Tokens
function preFilter(pools: PoolData[]): PoolData[] {
  return pools.filter(p => {
    if (!p.addr || p.addr.length < 10) return false;
    if (p.addr.startsWith("0x000000")) return false;       // Null-Adressen raus
    if (SKIP_TOKENS.has(p.addr.toLowerCase())) return false;
    if (isBlacklisted(p.addr)) return false;
    // four.meme Bonding Curve = NICHT tradebar via MCP (buyTokenAMAP braucht value param)
    // NUR PancakeSwap Pairs (WBNB/USDT/USDC) sind tradebar!
    if (p.dex === "fourmeme") return false;
    if (p.liq > 2000) return false;   // Max $2M — darüber = kein Meme
    // Frische Tokens (<30min) = lockerer Filter (noch wenig Vol/Liq)
    const isFresh = p.age > 0 && p.age < 30;
    if (!isFresh && p.liq < 5) return false;      // Min $5k Liquidität
    if (isFresh && p.liq < 1) return false;        // Frisch: Min $1k reicht
    if (!isFresh && p.vol < 5) return false;       // Min $5k Volume
    if (p.liq > 0 && p.vol / p.liq > 20) return false;  // Fake Volume
    if (p.sells === 0 && p.buys > 10) return false;      // Honeypot
    return true;
  });
}

// Momentum Score — Meme-Profit-fokussiert
function scorePool(p: PoolData): ScoredPool {
  const w = loadDeepLearn().scoreWeights; // Gelernte Gewichte!
  let score = 0;

  // ── 1h Momentum — DAS Signal für Memes (max 70) × momentum1h weight ──
  let momScore = 0;
  if (p.c1 > 3)  momScore += 15;
  if (p.c1 > 10) momScore += 20;
  if (p.c1 > 25) momScore += 20;
  if (p.c1 > 50) momScore += 15;
  score += Math.round(momScore * w.momentum1h);

  // ── Token-Alter × ageFactor weight ──
  let ageScore = 0;
  if (p.age > 0 && p.age < 30)        ageScore += 15;  // War 40 — zu hoch, machte JEDES fresh Token auto-approve
  if (p.age >= 30 && p.age < 60)      ageScore += 20;
  if (p.age >= 60 && p.age < 180)     ageScore += 20;
  if (p.age >= 180 && p.age < 720)    ageScore += 10;
  if (p.age >= 720 && p.age < 1440)   ageScore += 5;
  if (p.age >= 4320 && p.age < 10080) ageScore -= 5;
  if (p.age >= 10080 && p.age < 43200) ageScore -= 10;
  if (p.age >= 43200) ageScore -= 20;
  score += Math.round(ageScore * w.ageFactor);

  // ── Gesundes Vol/Liq Ratio (max 10) ──
  if (p.liq > 0 && p.vol / p.liq >= 0.5 && p.vol / p.liq <= 10) score += 10;

  // ── Liquidität × liqFactor weight ──
  let liqScore = 0;
  if (p.liq >= 10 && p.liq < 50)   liqScore += 10;
  if (p.liq >= 50 && p.liq < 200)  liqScore += 15;
  if (p.liq >= 200 && p.liq < 500) liqScore += 10;
  if (p.liq >= 500 && p.liq < 1000) liqScore += 5;
  if (p.liq >= 1000) liqScore -= 5;
  score += Math.round(liqScore * w.liqFactor);

  // ── Buy Pressure × buyPressure weight ──
  let bpScore = 0;
  if (p.ratio >= 1.2 && p.ratio <= 5) bpScore += 15;
  if (p.ratio > 5 && p.ratio <= 12) bpScore += 5;
  score += Math.round(bpScore * w.buyPressure);

  // ── Reversal Pattern × reversalFactor weight ──
  let revScore = 0;
  if (p.c24 < -20 && p.c1 > 5)  revScore += 20;
  else if (p.c24 < -10 && p.c1 > 3) revScore += 10;
  score += Math.round(revScore * w.reversalFactor);

  // ── Aktivität × activityFactor weight ──
  let actScore = 0;
  if (p.buys + p.sells > 200)  actScore += 5;
  if (p.buys + p.sells > 1000) actScore += 5;
  score += Math.round(actScore * w.activityFactor);

  // ── MALUS (nicht gewichtet — Sicherheit bleibt fest) ──
  if (p.c1 < -50) score -= 100;
  if (p.c1 < -30 && p.c1 >= -50) score -= 60;
  if (p.c1 < -10 && p.c1 >= -30) score -= 30;
  if (p.c1 < -5 && p.c1 >= -10) score -= 10;

  // ── PATTERN CHECK — gelernte Muster anwenden! ──
  const patternMatch = checkPatterns(p);
  if (patternMatch) {
    if (patternMatch.action === "avoid") score -= 50;
    else if (patternMatch.action === "prefer") score += 20;
    else if (patternMatch.action === "caution") score -= 15;
  }

  return { ...p, score };
}

// GeckoTerminal: 2 Seiten pro Modus = 40 Pools
async function fetchGecko(mode: "trending" | "new" | "volume"): Promise<PoolData[]> {
  const baseUrls: Record<string, string> = {
    trending: "https://api.geckoterminal.com/api/v2/networks/bsc/trending_pools",
    new:      "https://api.geckoterminal.com/api/v2/networks/bsc/pools?order=pool_created_at",
    volume:   "https://api.geckoterminal.com/api/v2/networks/bsc/pools?order=h24_volume_usd_desc",
  };
  const sep = baseUrls[mode].includes("?") ? "&" : "?";
  const urls = [
    `${baseUrls[mode]}${sep}page=1`,
    `${baseUrls[mode]}${sep}page=2`,
  ];
  const results = await Promise.allSettled(
    urls.map(u => fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }).then(r => r.json()))
  );
  const pools: PoolData[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") pools.push(...parseGeckoPools(r.value));
  }
  return pools;
}

// GeckoTerminal: BRANDNEUE Pools — Sekunden alt! (four.meme + andere Launchpads)
async function fetchFreshPools(): Promise<PoolData[]> {
  try {
    const urls = [
      "https://api.geckoterminal.com/api/v2/networks/bsc/new_pools?page=1",
      "https://api.geckoterminal.com/api/v2/networks/bsc/new_pools?page=2",
    ];
    const results = await Promise.allSettled(
      urls.map(u => fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }).then(r => r.json()))
    );
    const pools: PoolData[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") pools.push(...parseGeckoPools(r.value));
    }
    return pools;
  } catch { return []; }
}

// DexScreener: Boosted Tokens
async function fetchDexBoosted(): Promise<PoolData[]> {
  try {
    const boostRes = await fetch("https://api.dexscreener.com/token-boosts/latest/v1", {
      signal: AbortSignal.timeout(8000),
    });
    const boosts = await boostRes.json() as any[];
    const seen = new Set<string>();
    const bscAddrs: string[] = [];
    for (const b of (boosts ?? [])) {
      if (b.chainId !== "bsc") continue;
      const addr = (b.tokenAddress ?? "").toLowerCase();
      if (!addr || seen.has(addr) || SKIP_TOKENS.has(addr)) continue;
      seen.add(addr);
      bscAddrs.push(b.tokenAddress);
      if (bscAddrs.length >= 20) break;
    }
    if (bscAddrs.length === 0) return [];
    return await fetchDexPairData(bscAddrs);
  } catch { return []; }
}

// DexScreener: Neue Token Profiles (FRISCHE MEMES!)
async function fetchDexNewPairs(): Promise<PoolData[]> {
  const results: PoolData[] = [];

  // Quelle 1: Token Profiles = frisch gelistete Tokens
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1", {
      signal: AbortSignal.timeout(8000),
    });
    const profiles = await res.json() as any[];
    const bscAddrs: string[] = [];
    const seen = new Set<string>();
    for (const p of (profiles ?? [])) {
      if (p.chainId !== "bsc") continue;
      const addr = (p.tokenAddress ?? "").toLowerCase();
      if (!addr || seen.has(addr) || SKIP_TOKENS.has(addr)) continue;
      seen.add(addr);
      bscAddrs.push(p.tokenAddress);
      if (bscAddrs.length >= 15) break;
    }
    if (bscAddrs.length > 0) {
      results.push(...await fetchDexPairData(bscAddrs));
    }
  } catch {}

  // Quelle 2: DexScreener Pair-Suche nach frischen BSC Memes
  try {
    const searches = ["meme", "moon", "pepe", "doge"];
    const pick = searches[Math.floor(Date.now() / 60000) % searches.length]; // Rotiert jede Minute
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${pick}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as any;
    const fresh = parseDexPairs(data.pairs ?? []).filter(p => p.age > 0 && p.age < 180); // Nur <3h
    results.push(...fresh);
  } catch {}

  return results;
}

// DexScreener: Top Gainers auf BSC (Token Boosts = promoted = Hype!)
async function fetchDexGainers(): Promise<PoolData[]> {
  try {
    // Top Boosts = am meisten promoted → höchster Hype
    const res = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      signal: AbortSignal.timeout(8000),
    });
    const boosts = await res.json() as any[];
    const bscAddrs: string[] = [];
    const seen = new Set<string>();
    for (const b of (boosts ?? [])) {
      if (b.chainId !== "bsc") continue;
      const addr = (b.tokenAddress ?? "").toLowerCase();
      if (!addr || seen.has(addr) || SKIP_TOKENS.has(addr)) continue;
      seen.add(addr);
      bscAddrs.push(b.tokenAddress);
      if (bscAddrs.length >= 15) break;
    }
    if (bscAddrs.length === 0) return [];
    return await fetchDexPairData(bscAddrs);
  } catch { return []; }
}

// Shared: DexScreener Pair-Daten parsen
function parseDexPairs(pairs: any[]): PoolData[] {
  const pools: PoolData[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (pair.chainId !== "bsc") continue;
    const addr = (pair.baseToken?.address ?? "").toLowerCase();
    if (!addr || seen.has(addr) || SKIP_TOKENS.has(addr)) continue;
    seen.add(addr);
    const quoteSymbol = pair.quoteToken?.symbol ?? "?";
    pools.push({
      name: `${pair.baseToken?.symbol ?? "?"} / ${quoteSymbol}`,
      addr: pair.baseToken?.address ?? "",
      price: parseFloat(pair.priceUsd ?? "0"),
      vol: Math.round((pair.volume?.h24 ?? 0) / 1000),
      liq: Math.round((pair.liquidity?.usd ?? 0) / 1000),
      c1: pair.priceChange?.h1 ?? 0,
      c24: pair.priceChange?.h24 ?? 0,
      buys: pair.txns?.h24?.buys ?? 0,
      sells: pair.txns?.h24?.sells ?? 0,
      ratio: (pair.txns?.h24?.sells ?? 0) > 0 ? (pair.txns?.h24?.buys ?? 0) / pair.txns.h24.sells : 999,
      age: pair.pairCreatedAt ? Math.round((Date.now() - pair.pairCreatedAt) / 60000) : 0,
      dex: ["WBNB", "USDT", "USDC", "BUSD"].includes(quoteSymbol) ? "pancake" : "fourmeme",
    });
  }
  return pools;
}

// Shared: DexScreener Token-Adressen → Pair-Daten
async function fetchDexPairData(addrs: string[]): Promise<PoolData[]> {
  const tokenRes = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${addrs.join(",")}`,
    { signal: AbortSignal.timeout(10000) }
  );
  const tokenData = await tokenRes.json() as any;
  return parseDexPairs(tokenData.pairs ?? []);
}

// Haupt-Fetch: GeckoTerminal + DexScreener (ALLE Quellen!) → Score → Sort
async function fetchMemesRaw(mode: "trending" | "new" | "volume"): Promise<ScoredPool[]> {
  try {
    const cached = rawCache[mode];
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

    // Parallel: GeckoTerminal + DexScreener Boosted + DexScreener New
    const fetchers: Promise<PoolData[]>[] = [fetchGecko(mode)];
    // IMMER frische Pools holen — das sind die Sekunden-alten Memes!
    fetchers.push(fetchFreshPools());
    // DexScreener IMMER — neue + boosted bei jedem Mode!
    fetchers.push(fetchDexNewPairs());
    fetchers.push(fetchDexBoosted());
    if (mode === "trending") fetchers.push(fetchDexGainers());

    const results = await Promise.allSettled(fetchers);
    const allPools: PoolData[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") allPools.push(...r.value);
    }

    // Deduplicate nach Adresse
    const seen = new Set<string>();
    const unique = allPools.filter(p => {
      const key = p.addr.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const filtered = preFilter(unique);
    const scored = filtered.map(scorePool).sort((a, b) => b.score - a.score);

    rawCache[mode] = { data: scored, ts: Date.now() };
    return scored;
  } catch { return []; }
}

function formatPool(p: ScoredPool): string {
  const wash = p.liq > 0 && p.vol / p.liq > 8 ? " ⚠WASH" : "";
  const star = p.score >= 50 ? " ⭐HOT" : p.score >= 30 ? " 🔥" : "";
  return `${p.name} | ${p.addr} | $${p.price.toPrecision(4)} | vol:$${p.vol}k liq:$${p.liq}k | 1h:${p.c1.toFixed(1)}% 24h:${p.c24.toFixed(1)}% | b/s:${p.ratio.toFixed(1)} | ${p.age}min | score:${p.score}${wash}${star}`;
}

async function fetchMemes(mode: "trending" | "new" | "volume"): Promise<string> {
  const scored = await fetchMemesRaw(mode);
  if (scored.length === 0) return "none (alle gefiltert)";
  return scored.slice(0, 8).map(formatPool).join("\n");
}

// Token Price Cache (15s)
const priceCache: Record<string, { data: any; ts: number }> = {};

async function getTokenPrice(tokenAddress: string): Promise<{ price: number; change1h: number; change24h: number; liqK: number; volK: number } | null> {
  try {
    const key = tokenAddress.toLowerCase();
    const cached = priceCache[key];
    if (cached && Date.now() - cached.ts < 15_000) return cached.data;

    // Versuch 1: GeckoTerminal
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${tokenAddress}/pools?page=1`;
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      const data = await res.json() as any;
      const pool = data.data?.[0]?.attributes;
      if (pool) {
        const price = parseFloat(pool.base_token_price_usd ?? "0");
        if (price > 0) {
          const result = {
            price,
            change1h:  parseFloat(pool.price_change_percentage?.h1  ?? "0"),
            change24h: parseFloat(pool.price_change_percentage?.h24 ?? "0"),
            liqK:      Math.round(parseFloat(pool.reserve_in_usd ?? "0") / 1000),
            volK:      Math.round(parseFloat(pool.volume_usd?.h24 ?? "0") / 1000),
          };
          priceCache[key] = { data: result, ts: Date.now() };
          return result;
        }
      }
    } catch {}

    // Versuch 2: DexScreener Fallback
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { signal: AbortSignal.timeout(6000) });
      const dexData = await dexRes.json() as any;
      const pair = (dexData.pairs ?? []).find((p: any) => p.chainId === "bsc");
      if (pair) {
        const price = parseFloat(pair.priceUsd ?? "0");
        if (price > 0) {
          const result = {
            price,
            change1h:  pair.priceChange?.h1 ?? 0,
            change24h: pair.priceChange?.h24 ?? 0,
            liqK:      Math.round((pair.liquidity?.usd ?? 0) / 1000),
            volK:      Math.round((pair.volume?.h24 ?? 0) / 1000),
          };
          priceCache[key] = { data: result, ts: Date.now() };
          return result;
        }
      }
    } catch {}

    return null;
  } catch { return null; }
}

// ── Wallet Token Scanner — RPC Transfer-Logs + Journal ──────────────────────
const walletTokenCache: Record<string, { tokens: string[]; ts: number }> = {};

async function scanWalletTokens(walletAddress: string): Promise<string[]> {
  const key = walletAddress.toLowerCase();
  const cached = walletTokenCache[key];
  // Cache 5 Minuten
  if (cached && Date.now() - cached.ts < 300_000) return cached.tokens;

  const tokens = new Set<string>();

  // Quelle 1: RPC Transfer-Logs (on-chain, letzte ~50k Blöcke = ~2 Tage)
  try {
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const paddedAddr = "0x000000000000000000000000" + walletAddress.slice(2).toLowerCase();
    const blockRes = await fetch("https://bsc-dataseed1.binance.org/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal: AbortSignal.timeout(6000),
    });
    const blockData = await blockRes.json() as any;
    const currentBlock = parseInt(blockData.result, 16);
    const fromBlock = "0x" + Math.max(currentBlock - 50000, 0).toString(16);
    const logRes = await fetch("https://bsc-dataseed1.binance.org/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "eth_getLogs", id: 2,
        params: [{ fromBlock, toBlock: "latest", topics: [transferTopic, null, paddedAddr] }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    const logData = await logRes.json() as any;
    if (Array.isArray(logData.result)) {
      for (const entry of logData.result) {
        const addr = (entry.address ?? "").toLowerCase();
        if (addr && addr.length === 42) tokens.add(addr);
      }
    }
  } catch {}

  // Quelle 2: Journal
  try {
    const journal = loadJournal();
    for (const e of journal) {
      if (e.action === "BUY" && e.address) tokens.add(e.address.toLowerCase());
    }
  } catch {}

  const result = Array.from(tokens);
  walletTokenCache[key] = { tokens: result, ts: Date.now() };
  return result;
}

// ── On-Chain ───────────────────────────────────────────────────────────────────
async function getBnb(mcp: Client, address: string): Promise<number> {
  try {
    const raw = await executeTool(mcp, "get_native_balance", { address, network: "bsc" });
    return parseFloat(JSON.parse(raw).formatted ?? "0");
  } catch { return 0; }
}

async function getTokenBalance(mcp: Client, walletAddress: string, tokenAddress: string): Promise<{ raw: bigint; formatted: string; symbol: string }> {
  try {
    const raw = await executeTool(mcp, "get_erc20_balance", { tokenAddress, address: walletAddress, network: "bsc" });
    const bd = JSON.parse(raw);
    return { raw: BigInt(bd.raw ?? bd.balance ?? "0"), formatted: bd.formatted ?? "0", symbol: bd.symbol ?? "TOKEN" };
  } catch { return { raw: 0n, formatted: "0", symbol: "TOKEN" }; }
}

// ── Trade Execution ────────────────────────────────────────────────────────────
const APPROVE_ABI = [{ inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }];
const BUY_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForTokensSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];
const SELL_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }], name: "swapExactTokensForETHSupportingFeeOnTransferTokens", outputs: [], stateMutability: "nonpayable", type: "function" }];

// WBNB Withdraw ABI — um stuck WBNB zurück in BNB umzuwandeln
const WITHDRAW_ABI = [{ inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" }];

async function recoverWBNB(mcp: Client, walletAddress: string, log?: (msg: string) => void): Promise<void> {
  try {
    const wbnbBal = await getTokenBalance(mcp, walletAddress, WBNB);
    if (wbnbBal.raw > 0n) {
      log?.(`  🔄 WBNB Recovery: ${wbnbBal.formatted} WBNB → BNB (${walletAddress.slice(0, 10)}…)`);
      const res = await executeTool(mcp, "write_contract", {
        contractAddress: WBNB, abi: WITHDRAW_ABI,
        functionName: "withdraw", args: [wbnbBal.raw.toString()], network: "bsc",
      });
      if (String(res).toLowerCase().includes("error")) {
        log?.(`  🔄 ⚠️ Withdraw Antwort: ${String(res).slice(0, 80)}`);
        // Retry mit kleinerem Amount (90%) — manchmal ist der ganze Balance nicht withdrawbar
        const retry = (wbnbBal.raw * 90n / 100n).toString();
        log?.(`  🔄 Retry mit 90%...`);
        await executeTool(mcp, "write_contract", {
          contractAddress: WBNB, abi: WITHDRAW_ABI,
          functionName: "withdraw", args: [retry], network: "bsc",
        });
      }
      log?.(`  🔄 ✅ WBNB recovered`);
    }
  } catch (e) { log?.(`  🔄 ❌ WBNB recovery: ${String(e).slice(0, 80)}`); }
}

// PancakeSwap V3 Smart Router — funktioniert mit allen Pairs
const SMART_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
const SMART_ROUTER_ABI = [{ inputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMin", type: "uint256" }, { internalType: "address[]", name: "path", type: "address[]" }, { internalType: "address", name: "to", type: "address" }], name: "swapExactTokensForTokens", outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }], stateMutability: "nonpayable", type: "function" }];

// BUSD/USDT als Multi-Hop Brücke wenn direkter Swap fehlschlägt
const USDT = "0x55d398326f99059fF775485246999027B3197955";

// four.meme Bonding Curve Contract
const FOUR_MEME = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
const FOUR_MEME_BUY_ABI = [{
  inputs: [
    { internalType: "uint256", name: "origin", type: "uint256" },
    { internalType: "address", name: "token", type: "address" },
    { internalType: "uint256", name: "funds", type: "uint256" },
    { internalType: "uint256", name: "minAmount", type: "uint256" },
  ],
  name: "buyTokenAMAP",
  outputs: [],
  stateMutability: "payable",
  type: "function",
}];

async function execBuy(mcp: Client, walletAddress: string, tokenAddress: string, symbol: string, bnbAmount: number, log?: (msg: string) => void, dex?: string): Promise<string> {
  const amount = Math.min(Math.max(bnbAmount, 0.001), 0.01);
  const weiAmt = BigInt(Math.floor(amount * 1e18)).toString();
  const deadline = Math.floor(Date.now() / 1000) + 300;

  // ── four.meme Route — direkt BNB senden, kein WBNB nötig! ──
  if (dex === "fourmeme" || tokenAddress.toLowerCase().endsWith("4444")) {
    log?.(`     🎪 four.meme BUY ${amount} BNB → ${symbol}`);
    try {
      const res = await executeTool(mcp, "write_contract", {
        contractAddress: FOUR_MEME,
        abi: FOUR_MEME_BUY_ABI,
        functionName: "buyTokenAMAP",
        args: ["0", tokenAddress, weiAmt, "1"],
        value: weiAmt,
        network: "bsc",
      });
      if (!String(res).toLowerCase().includes("error")) {
        log?.(`     🎪 ✅ four.meme BUY OK`);
        return `Bought ${symbol} with ${amount} BNB (four.meme)`;
      }
      log?.(`     🎪 ⚠️ four.meme failed: ${String(res).slice(0, 60)}`);
    } catch (e) {
      log?.(`     🎪 ⚠️ four.meme error: ${String(e).slice(0, 60)}`);
    }
    // Fallback: PancakeSwap (Token könnte schon graduated sein)
    log?.(`     🎪 → Fallback PancakeSwap...`);
  }

  // ── PancakeSwap Route ──
  // Step 1: Wrap BNB → WBNB
  log?.(`     1/4 WRAP ${amount} BNB → WBNB`);
  await executeTool(mcp, "transfer_native_token", { toAddress: WBNB, amount: String(amount), network: "bsc" });
  await sleep(4000);

  // Step 2: Approve WBNB für BEIDE Router
  log?.(`     2/4 APPROVE V2+V3`);
  await executeTool(mcp, "write_contract", { contractAddress: WBNB, abi: APPROVE_ABI, functionName: "approve", args: [ROUTER, weiAmt], network: "bsc" });
  await sleep(2000);
  await executeTool(mcp, "write_contract", { contractAddress: WBNB, abi: APPROVE_ABI, functionName: "approve", args: [SMART_ROUTER, weiAmt], network: "bsc" });
  await sleep(2000);

  // Step 3a: V2 Direct [WBNB → TOKEN]
  log?.(`     3/4 SWAP V2 direct...`);
  let res = await executeTool(mcp, "write_contract", {
    contractAddress: ROUTER, abi: BUY_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [weiAmt, "1", [WBNB, tokenAddress], walletAddress, String(deadline)],
    network: "bsc",
  });

  if (!String(res).toLowerCase().includes("error")) {
    log?.(`     4/4 ✅ V2 direct OK`);
    trackRoute(tokenAddress, "v2", true);
    return `Bought ${symbol} with ${amount} BNB (V2 direct)`;
  }
  trackRoute(tokenAddress, "v2", false);
  log?.(`     ⚠️ V2 direct failed — trying USDT hop...`);

  // Step 3b: V2 Multi-Hop [WBNB → USDT → TOKEN]
  await sleep(2000);
  res = await executeTool(mcp, "write_contract", {
    contractAddress: ROUTER, abi: BUY_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [weiAmt, "1", [WBNB, USDT, tokenAddress], walletAddress, String(deadline)],
    network: "bsc",
  });

  if (!String(res).toLowerCase().includes("error")) {
    log?.(`     4/4 ✅ V2 USDT-hop OK`);
    trackRoute(tokenAddress, "v2hop", true);
    return `Bought ${symbol} with ${amount} BNB (V2 multi-hop)`;
  }
  trackRoute(tokenAddress, "v2hop", false);
  log?.(`     ⚠️ V2 USDT-hop failed — trying V3...`);

  // Step 3c: V3 Smart Router [WBNB → TOKEN]
  await sleep(2000);
  res = await executeTool(mcp, "write_contract", {
    contractAddress: SMART_ROUTER, abi: SMART_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [weiAmt, "1", [WBNB, tokenAddress], walletAddress],
    network: "bsc",
  });

  if (!String(res).toLowerCase().includes("error")) {
    log?.(`     4/4 ✅ V3 OK`);
    trackRoute(tokenAddress, "v3", true);
    return `Bought ${symbol} with ${amount} BNB (V3)`;
  }
  trackRoute(tokenAddress, "v3", false);
  log?.(`     ❌ V3 auch failed`);

  // Alle Swaps fehlgeschlagen → WBNB recovern
  log?.(`  🔄 Swap fehlgeschlagen — WBNB Recovery...`);
  await recoverWBNB(mcp, walletAddress, log);
  markSwapFail(tokenAddress); // Nie wieder versuchen — alle Routen gescheitert
  return `Error: All swap routes failed for ${symbol} — WBNB recovered`;
}

async function execSell(mcp: Client, walletAddress: string, tokenAddress: string, symbol: string, pct: number, log?: (msg: string) => void): Promise<string> {
  const bal = await getTokenBalance(mcp, walletAddress, tokenAddress);
  if (bal.raw === 0n) return `No ${symbol} to sell`;
  const sellAmt = (bal.raw * BigInt(Math.min(Math.max(pct, 1), 100)) / 100n).toString();
  const deadline = Math.floor(Date.now() / 1000) + 300;

  // Approve für BEIDE Router (V2 + V3 Smart Router)
  const maxApprove = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  await executeTool(mcp, "write_contract", { contractAddress: tokenAddress, abi: APPROVE_ABI, functionName: "approve", args: [ROUTER, maxApprove], network: "bsc" });
  await sleep(2000);
  await executeTool(mcp, "write_contract", { contractAddress: tokenAddress, abi: APPROVE_ABI, functionName: "approve", args: [SMART_ROUTER, maxApprove], network: "bsc" });
  await sleep(2000);

  const preBnb = await getBnb(mcp, walletAddress);

  // Route 1: V2 Direct [TOKEN → WBNB → ETH(BNB)]
  log?.(`     SELL 1/4: V2 direct...`);
  let res = await executeTool(mcp, "write_contract", {
    contractAddress: ROUTER, abi: SELL_ABI,
    functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    args: [sellAmt, "1", [tokenAddress, WBNB], walletAddress, String(deadline)],
    network: "bsc",
  });
  await sleep(3000);
  let postBnb = await getBnb(mcp, walletAddress);
  if (postBnb > preBnb + 0.0001) {
    trackRoute(tokenAddress, "v2", true);
    return `Sold ${pct}% ${symbol} → ${(postBnb - preBnb).toFixed(4)} BNB (V2 direct)`;
  }

  // Route 2: V2 USDT-Hop [TOKEN → USDT → WBNB → ETH(BNB)]
  log?.(`     SELL 2/4: V2 USDT-hop...`);
  // Re-check balance — Route 1 might have consumed tokens without BNB return
  const bal2 = await getTokenBalance(mcp, walletAddress, tokenAddress);
  if (bal2.raw > 0n) {
    const sellAmt2 = bal2.raw.toString();
    res = await executeTool(mcp, "write_contract", {
      contractAddress: ROUTER, abi: BUY_ABI, // swapExactTokensForTokens with fee
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [sellAmt2, "1", [tokenAddress, USDT, WBNB], walletAddress, String(deadline)],
      network: "bsc",
    });
    await sleep(3000);
    await recoverWBNB(mcp, walletAddress); // WBNB → BNB
    await sleep(2000);
    postBnb = await getBnb(mcp, walletAddress);
    if (postBnb > preBnb + 0.0001) {
      trackRoute(tokenAddress, "v2hop", true);
      return `Sold ${pct}% ${symbol} → ${(postBnb - preBnb).toFixed(4)} BNB (V2 USDT-hop)`;
    }
  }

  // Route 3: V3 Smart Router [TOKEN → WBNB]
  log?.(`     SELL 3/4: V3 Smart Router...`);
  const bal3 = await getTokenBalance(mcp, walletAddress, tokenAddress);
  if (bal3.raw > 0n) {
    const sellAmt3 = bal3.raw.toString();
    res = await executeTool(mcp, "write_contract", {
      contractAddress: SMART_ROUTER, abi: SMART_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [sellAmt3, "1", [tokenAddress, WBNB], walletAddress],
      network: "bsc",
    });
    await sleep(3000);
    await recoverWBNB(mcp, walletAddress);
    await sleep(2000);
    postBnb = await getBnb(mcp, walletAddress);
    if (postBnb > preBnb + 0.0001) {
      trackRoute(tokenAddress, "v3", true);
      return `Sold ${pct}% ${symbol} → ${(postBnb - preBnb).toFixed(4)} BNB (V3)`;
    }
  }

  // Route 4: V3 USDT-Hop [TOKEN → USDT → WBNB]
  log?.(`     SELL 4/4: V3 USDT-hop...`);
  const bal4 = await getTokenBalance(mcp, walletAddress, tokenAddress);
  if (bal4.raw > 0n) {
    const sellAmt4 = bal4.raw.toString();
    res = await executeTool(mcp, "write_contract", {
      contractAddress: SMART_ROUTER, abi: SMART_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [sellAmt4, "1", [tokenAddress, USDT, WBNB], walletAddress],
      network: "bsc",
    });
    await sleep(3000);
    await recoverWBNB(mcp, walletAddress);
    await sleep(2000);
    postBnb = await getBnb(mcp, walletAddress);
    if (postBnb > preBnb + 0.0001) {
      trackRoute(tokenAddress, "v3", true);
      return `Sold ${pct}% ${symbol} → ${(postBnb - preBnb).toFixed(4)} BNB (V3 USDT-hop)`;
    }
  }

  // Alle Routen gescheitert — WBNB recovern
  await recoverWBNB(mcp, walletAddress, log);
  return `Sold ${pct}% of ${symbol} (${bal.formatted}) → 0 BNB (all 4 routes failed)`;
}

async function execSendBnb(mcp: Client, toAddress: string, amount: number): Promise<string> {
  const res = await executeTool(mcp, "transfer_native_token", { toAddress, amount: String(amount), network: "bsc" });
  return `Sent ${amount} BNB → ${toAddress.slice(0, 10)}… | ${String(res).slice(0, 60)}`;
}

// ── Haiku Call mit Retry + Fallback ──────────────────────────────────────────────
// Haiku → Sonnet → Fallback null. Rate Limits sind pro Modell getrennt bei Anthropic.
const FALLBACK_MODELS = [HAIKU, SONNET];

async function haikuCall(prompt: string, maxTokens: number, log?: (msg: string) => void): Promise<string | null> {
  for (const model of FALLBACK_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await anthropic.messages.create({
          model, max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        });
        return res.content.find(b => b.type === "text")?.text?.trim() ?? null;
      } catch (e) {
        if (String(e).includes("429") && attempt === 0) {
          log?.(`  ⏳ ${model.split("-").slice(1, 2)} 429 — 15s...`);
          await sleep(15_000);
          continue;
        }
        log?.(`  ⚠️ ${model} failed — next...`);
        break;
      }
    }
  }
  log?.(`  ⚠️ Alle Modelle down — Fallback HOLD`);
  return null;
}

// Für System+User Messages (Bank Update, Inbox Summary)
async function haikuChat(messages: { role: string; content: string }[], maxTokens: number, log?: (msg: string) => void): Promise<string | null> {
  const system = messages.find(m => m.role === "system")?.content ?? "";
  const userMsg = messages.find(m => m.role === "user")?.content ?? "";
  const prompt = system ? `${system}\n\n${userMsg}` : userMsg;
  return haikuCall(prompt, maxTokens, log);
}

// ── Haiku Scanner ─────────────────────────────────────────────────────────────
async function haikuScan(agent: Agent, context: string, bnb: number, log: (msg: string) => void): Promise<TradeSignal> {
  const s = getStats(agent.name);
  s.haikuCalls++;

  const lessons = loadLessons();
  const journalStats = getJournalSummary();
  const teamHoldings = Object.entries(getAllPositions())
    .filter(([name]) => name !== agent.name)
    .flatMap(([name, positions]) => (positions as Position[]).map(p => `${name} hält ${p.symbol} (${p.address})`))
    .join("\n") || "Kein Teammate hält Positionen";

  // Team Signals einbauen
  const signals = getTeamSignals(agent.name);
  const signalText = signals.length > 0
    ? `\n🚨 TEAM SIGNALS:\n${signals.map(s => `[${s.from}] ${s.type}: ${s.tokenSymbol} (${s.tokenAddress}) — ${s.reason}`).join("\n")}`
    : "";

  const myPositions = getPositions(agent.name);

  const prompt = `${agent.name} — BSC Scalp Trader. Profit → $BOB.

DEIN BNB: ${bnb.toFixed(4)} BNB (genug für Trades! Code prüft Gas.)

TEAM HÄLT (NICHT kaufen!): ${teamHoldings}
${signalText}

POSITIONEN: ${myPositions.length > 0 ? myPositions.map(p => `${p.symbol} (${p.address}) +${Math.round((Date.now() - p.enteredAt) / 60000)}min`).join(", ") : "Keine"}

${journalStats}

REGELN:
- Kaufe den BESTEN Token aus der Liste (⭐HOT / 🔥 bevorzugen)
- BNB Amount: 0.003
- SELL offene Positionen wenn > 20min ohne Profit
- Team VERIFIED_BUY = sofort kaufen!
- Kein Token von Teammate, kein ⚠WASH
${lessons}

MARKT (pre-filtered, nach Score sortiert):
${context}

JSON ONLY — DU MUSST den besten Token kaufen wenn welche in der Liste sind!
HOLD nur wenn die Liste "none" zeigt oder ALLE Tokens ⚠WASH sind.
BUY: {"action":"BUY","tokenAddress":"0x...","tokenSymbol":"NAME","bnbAmount":0.003,"reason":"kurz","confidence":85}
SELL: {"action":"SELL","tokenAddress":"0x...","tokenSymbol":"NAME","sellPct":100,"reason":"kurz"}
HOLD: {"action":"HOLD","reason":"kurz"}`;

  try {
    const text = await haikuCall(prompt, 300, log);
    if (!text) return { action: "HOLD", reason: "Alle Modelle down — Fallback HOLD" };
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: "HOLD", reason: "No JSON response" };
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { action: "HOLD", reason: `Scan error: ${String(e).slice(0, 50)}` };
  }
}

// ── Opus Bestätigung — Geld fliesst = Opus muss OK sagen ─────────────────────
// ── TIERED AI: Sonnet = Trade Confirm, Opus = Strategy Only, Haiku = Quick Screen ──
// Budget-schonend: Opus ~$0.05/call, Sonnet ~$0.005/call, Haiku ~$0.001/call

async function aiConfirm(action: string, details: string, log: (msg: string) => void, callerBot?: string, score?: number): Promise<{ execute: boolean; reason: string; adjustedAmount?: number }> {
  const lessons = loadLessons();
  const prompt = `BOB Trading Squad BSC — Trade Confirmation.

TRANSAKTION: ${action}
${details}
${lessons ? `\nGELERNTE REGELN:\n${lessons}` : ""}

REGELN:
- APPROVE trades wenn: Score ≥ 35, kein Honeypot, genug BNB
- Frische Tokens (<30min): Liq ≥ $1k reicht! Das sind vier.meme Launches!
- Etablierte Tokens (>30min): Liq ≥ $5k
- BLOCK nur bei: echtem Honeypot (0 sells + viele buys), <0.003 BNB, null-Adresse
- Kleine Trades (0.002-0.005 BNB) = normales Risiko, APPROVE
- $BOB Käufe IMMER erlauben
- Gas-Transfers IMMER erlauben
- Vergangene Winrate IGNORIEREN — jeder Trade einzeln bewerten!
- Default = APPROVE (wir WOLLEN aktiv traden!)
- KRASSE MOVES erlaubt wenn Daten es stützen (Score, Momentum, frisch)
- Niedrige Liq bei frischen Memes ist NORMAL — das ist der Einstieg!

JSON ONLY:
{"execute":true/false,"reason":"kurz","adjustedAmount":0.003}`;

  // Tiered: Score 65+ → Opus (beste Entscheidung), Score 45-64 → Sonnet, Score 35-44 → Haiku
  // Opus für die wichtigsten Trades — 10% mehr als vorher!
  const s2 = score ?? 50;
  const model = s2 >= 65 ? OPUS : s2 >= 45 ? SONNET : HAIKU;
  const modelName = model === OPUS ? "Opus" : model === SONNET ? "Sonnet" : "Haiku";
  if (callerBot) {
    if (model === OPUS) getStats(callerBot).opusCalls++;
    else if (model === SONNET) getStats(callerBot).sonnetCalls++;
    else getStats(callerBot).haikuCalls++;
  }

  try {
    log(`  🧠 ${modelName}...`);
    const res = await anthropic.messages.create({
      model, max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.find(b => b.type === "text")?.text ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return { execute: true, reason: "No response — default approve" };
  } catch (e) {
    const shortPrompt = `Approve BSC trade? ${action}. JSON ONLY: {"execute":bool,"reason":"kurz"}`;

    // Fallback: Haiku (günstigste Option)
    log(`  ⚠️ ${modelName} fail → Haiku Fallback`);
    try {
      const text = await haikuCall(shortPrompt, 100, log);
      if (text) { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); }
    } catch {}

    // Letzter Fallback: Code entscheidet (Score-basiert, kein API nötig)
    if ((score ?? 0) >= 45) return { execute: true, reason: "AI down — Score OK, auto-approve", adjustedAmount: 0.003 };
    return { execute: false, reason: "AI down — Score zu niedrig" };
  }
}

// Legacy Alias — alle bestehenden Aufrufe funktionieren weiter
async function opusConfirm(action: string, details: string, log: (msg: string) => void, callerBot?: string): Promise<{ execute: boolean; reason: string; adjustedAmount?: number }> {
  return aiConfirm(action, details, log, callerBot);
}

// ── BANK (Code + Opus bestätigt Geld) ────────────────────────────────────────
async function runBank(agent: Agent, mcp: Client, teamAddresses: Record<string, string>, log: (msg: string) => void): Promise<string> {
  const s = getStats(agent.name);
  let bnb = await getBnb(mcp, agent.wallet.address);
  const bobBal = await getTokenBalance(mcp, agent.wallet.address, BOB_TOKEN);

  // Team-Status scannen: BNB + Positionen pro Trader
  const traderData: { name: string; addr: string; bnb: number; posCount: number }[] = [];
  for (const [name, addr] of Object.entries(teamAddresses)) {
    if (name === "BANK") continue;
    const tBnb = await getBnb(mcp, addr);
    const tPos = getPositions(name).length;
    traderData.push({ name, addr, bnb: tBnb, posCount: tPos });
  }
  const traderStatus = traderData.map(t => `${t.name}:${t.bnb.toFixed(4)}(${t.posCount}pos)`);

  log(`  💰 BNB:${bnb.toFixed(4)} $BOB:${bobBal.formatted} | ${traderStatus.join(" ")}`);
  const actions: string[] = [];

  // ── 0. EMERGENCY: $BOB verkaufen wenn Team pleite UND Swarm leer ──
  const teamTotalBnb = traderData.reduce((s, t) => s + t.bnb, 0) + bnb;
  const lastBobSell = (existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {}).lastBobSellTime ?? 0;
  const bobSellCooldown = Date.now() - lastBobSell > 30 * 60_000; // 30min Cooldown

  if (teamTotalBnb < 0.03 && bobSellCooldown) {
    // Prüfe ob Swarm auch leer ist
    let swarmBnbCheck = 0;
    try {
      const swarmTmp = await connectBNBChain(process.env.PRIVATE_KEY);
      swarmBnbCheck = await getBnb(swarmTmp.client, SWARM_WALLET_ADDRESS);
      try { await (swarmTmp.client as any)?.close?.(); } catch {}
    } catch {}

    if (swarmBnbCheck < 0.015 && bobBal.raw > 0n) {
      // Team + Swarm sind pleite → $BOB verkaufen (max 30%!)
      const sellPct = 30;
      const sellAmt = (bobBal.raw * BigInt(sellPct) / 100n);
      log(`  🚨 EMERGENCY: Team pleite (${teamTotalBnb.toFixed(4)} BNB) + Swarm leer!`);
      log(`  🟡 Verkaufe ${sellPct}% $BOB (${bobBal.formatted}) für Team-Gas...`);

      const bobOk = await opusConfirm(
        "EMERGENCY $BOB SELL",
        `Team total: ${teamTotalBnb.toFixed(4)} BNB. Swarm: ${swarmBnbCheck.toFixed(4)}. Verkaufe ${sellPct}% $BOB für Team-Gas.`,
        log, "BANK"
      );

      if (bobOk.execute) {
        try {
          const preSellBnb = await getBnb(mcp, agent.wallet.address);
          await execSell(mcp, agent.wallet.address, BOB_TOKEN, "$BOB", sellPct);
          await sleep(5000);
          const postSellBnb = await getBnb(mcp, agent.wallet.address);
          const received = postSellBnb - preSellBnb;
          bnb = postSellBnb;
          log(`  🟡 ✅ $BOB → ${received.toFixed(4)} BNB`);
          actions.push(`$BOB-SELL:${received.toFixed(4)}`);
          await sendMessage("BANK", "ALL", `🚨 EMERGENCY: ${sellPct}% $BOB verkauft → ${received.toFixed(4)} BNB für Team. Wird zurückgekauft!`);
          // Cooldown setzen + Rebuy Flag
          await withState(state => {
            state.lastBobSellTime = Date.now();
            state.bobRebuyPending = true;
          });
        } catch (e) { log(`  ❌ $BOB Sell: ${String(e).slice(0, 60)}`); }
      }
    }
  }

  // ── 1. Swarm Wallet: BNB holen wenn Team insgesamt wenig hat ──
  if (teamTotalBnb < 0.05) {
    try {
      const swarmMcp = await connectBNBChain(process.env.PRIVATE_KEY);
      const swarmBnb = await getBnb(swarmMcp.client, SWARM_WALLET_ADDRESS);
      if (swarmBnb > 0.015) {
        const pullAmt = Math.min(swarmBnb - 0.005, 0.04);
        log(`  🏦 PULL ${pullAmt.toFixed(4)} BNB from Swarm (Team total: ${teamTotalBnb.toFixed(4)})`);
        const pullOk = await opusConfirm("SWARM→BANK", `${pullAmt.toFixed(4)} BNB Swarm→BANK. Team total: ${teamTotalBnb.toFixed(4)}`, log, "BANK");
        if (pullOk.execute) {
          await execSendBnb(swarmMcp.client, agent.wallet.address, pullAmt);
          actions.push(`PULL:${pullAmt.toFixed(4)}`);
          bnb += pullAmt;
          log(`  🏦 ✅ Pulled`);
        }
      }
      try { await (swarmMcp.client as any)?.close?.(); } catch {}
    } catch (e) { log(`  ⚠️ Swarm: ${String(e).slice(0, 50)}`); }
  }

  // ── 2. Gas-Koordination: Trader brauchen BNB zum Traden ──
  // ── 2a. Robin Hood: Reiche Trader → arme Trader (BANK koordiniert) ──
  const richTraders = traderData.filter(t => t.bnb > 0.025).sort((a, b) => b.bnb - a.bnb);
  const lowGas = traderData.filter(t => t.bnb < 0.005).sort((a, b) => a.bnb - b.bnb); // 0.005 = kann kaum traden

  // Zuerst: von reichen Tradern holen (BANK nimmt, BANK gibt)
  for (const rich of richTraders) {
    if (lowGas.length === 0) break;
    const takeAmt = Math.min(rich.bnb - 0.015, 0.01); // Rich behält 0.015
    if (takeAmt >= 0.005) {
      log(`  🔄 ROBIN HOOD: ${rich.name}(${rich.bnb.toFixed(4)}) hat Überschuss`);
      // Rich Trader schickt automatisch über Profit→BANK flow
      // Wir merken uns nur den Überschuss für die Gas-Verteilung
      bnb += takeAmt; // Wird von Trader→BANK Profit-Flow abgedeckt
    }
  }

  if (lowGas.length > 0) {
    log(`  ⚡ ${lowGas.length} Trader brauchen Gas: ${lowGas.map(t => `${t.name}:${t.bnb.toFixed(4)}`).join(" ")}`);
  }

  for (const t of lowGas) {
    if (bnb > 0.005) {
      const amt = Math.min(0.006, bnb - 0.003); // BANK behält min 0.003
      if (amt >= 0.002) {
        log(`  💸 GAS→${t.name}: ${amt.toFixed(4)} (hat ${t.bnb.toFixed(4)})`);
        try {
          const res = await execSendBnb(mcp, t.addr, amt);
          log(`     ✅ ${res.slice(0, 60)}`);
          bnb -= amt;
          actions.push(`GAS→${t.name}:${amt.toFixed(4)}`);
          await sendMessage(agent.name, t.name, `⛽ Gas: ${amt.toFixed(4)} BNB — go trade! Build On BNB!`);
          await sleep(3000);
        } catch (e) { s.errors++; log(`     ❌ Gas failed: ${String(e).slice(0, 50)}`); }
      }
    }
  }

  // ── 4. Profits → Swarm (NUR wenn BANK echten Überschuss hat, nicht gepulltes Geld) ──
  const curBnb = await getBnb(mcp, agent.wallet.address);
  // BANK braucht min 0.015 für Gas-Ops. Nur senden wenn DEUTLICH mehr da ist.
  if (curBnb > 0.03 && !actions.some(a => a.startsWith("PULL"))) {
    // NUR wenn wir NICHT gerade gepullt haben (sonst zirkulär!)
    const surplusBnb = Math.min(curBnb - 0.015, 0.02);
    if (surplusBnb >= 0.005) {
      log(`  🏦 PROFIT→SWARM: ${surplusBnb.toFixed(4)} BNB (echter Überschuss)`);
      try {
        await execSendBnb(mcp, SWARM_WALLET_ADDRESS, surplusBnb);
        actions.push(`→SWARM:${surplusBnb.toFixed(4)}`);
        log(`  🏦 ✅ Sent to Swarm`);
      } catch (e) { log(`  ⚠️ Swarm transfer: ${String(e).slice(0, 50)}`); }
    }
  }

  // ── 5. $BOB kaufen ODER zurückkaufen ──
  const stateNow = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf-8")) : {};
  const rebuyPending = stateNow.bobRebuyPending ?? false;

  // 5a. REBUY: Wenn BANK vorher $BOB verkauft hat → jetzt zurückkaufen
  const curBankBnb = await getBnb(mcp, agent.wallet.address);
  if (rebuyPending && curBankBnb > 0.02) {
    const rebuyAmt = Math.min(curBankBnb - 0.01, 0.015);
    if (rebuyAmt >= 0.003) {
      log(`  🟡 REBUY $BOB: ${rebuyAmt.toFixed(4)} BNB (Rückkauf nach Emergency Sell)`);
      try {
        const result = await execBuy(mcp, agent.wallet.address, BOB_TOKEN, "$BOB", rebuyAmt, log);
        if (!result.toLowerCase().includes("error")) {
          actions.push(`$BOB-REBUY:${rebuyAmt.toFixed(4)}`);
          await withState(state => { state.bobRebuyPending = false; });
          await sendMessage("BANK", "ALL", `🟡 $BOB REBUY: ${rebuyAmt.toFixed(4)} BNB — Promise kept!`);
        }
      } catch {}
    }
  }

  // 5b. Normal: Swarm kauft $BOB wenn genug Reserve
  if (!rebuyPending) {
    try {
      const swarmMcp = await connectBNBChain(process.env.PRIVATE_KEY);
      const swarmBnb = await getBnb(swarmMcp.client, SWARM_WALLET_ADDRESS);
      if (swarmBnb > 0.03) {
        const buyAmt = Math.min(swarmBnb - 0.02, 0.01);
        log(`  🟡 SWARM BUY $BOB: ${buyAmt.toFixed(4)} BNB (Swarm: ${swarmBnb.toFixed(4)})`);
        const result = await execBuy(swarmMcp.client, SWARM_WALLET_ADDRESS, BOB_TOKEN, "$BOB", buyAmt, log);
        if (!result.toLowerCase().includes("error")) {
          actions.push(`$BOB+${buyAmt.toFixed(4)}`);
          await sendMessage(agent.name, "ALL", `🟡 $BOB +${buyAmt.toFixed(4)} BNB — Build On BNB!`);
        }
      }
      try { await (swarmMcp.client as any)?.close?.(); } catch {}
    } catch (e) { log(`  ⚠️ Swarm $BOB: ${String(e).slice(0, 50)}`); }
  }

  // ── Status ──
  const jStats = getTradeStats();
  const teamPositions = Object.entries(getAllPositions()).flatMap(([n, ps]) => (ps as Position[]).map(p => `${n}:${p.symbol}`));
  const statusMsg = `BANK: ${bnb.toFixed(4)} BNB | $BOB:${bobBal.formatted} | ${jStats.wins}W/${jStats.losses}L/${jStats.neutral}N (${jStats.winRate.toFixed(0)}%) | Team:${teamPositions.join(",") || "—"} | ${actions.join(",") || "HOLD"}`;
  await sendMessage(agent.name, "ALL", statusMsg);
  log(`  📊 ${statusMsg}`);

  // ── OPUS KOORDINATION — BANK fragt Opus wie das Team performen soll ──
  await opusStrategyReview(log);
  await opusTeamCoordination(traderData, log);
  // 🧬 DEEP REVIEW — echtes Lernen: Score-Gewichte, Patterns, Cross-Bot
  await opusDeepReview(log);

  return actions.join(" | ") || "HOLD";
}

// ── TRADER BOT v17 — PERSÖNLICHKEITEN + EIGENE STRATEGIEN ────────────────────
async function runTrader(agent: Agent, mcp: Client, teamAddresses: Record<string, string>, log: (msg: string) => void): Promise<string> {
  const s = getStats(agent.name);
  const cfg = getEffectiveConfig(agent.name);
  const bnb = await getBnb(mcp, agent.wallet.address);
  const bankAddr = teamAddresses["BANK"] ?? "";

  // ── WALLET SYNC: On-Chain Balances prüfen → Ghost-Positionen aufräumen ──
  s.lastBnb = bnb;
  const myPosRaw = getPositions(agent.name);
  let ghostsCleaned = 0;
  for (const p of myPosRaw) {
    const bal = await getTokenBalance(mcp, agent.wallet.address, p.address);
    if (bal.raw === 0n) {
      log(`  👻 GHOST: ${p.symbol} — 0 Tokens on-chain, entferne`);
      await removePosition(agent.name, p.address);
      ghostsCleaned++;
    }
  }
  if (ghostsCleaned > 0) log(`  🧹 ${ghostsCleaned} Ghost-Positionen bereinigt`);

  const myPos = getPositions(agent.name);
  const teamPos = getAllPositions();
  const teamSummary = Object.entries(teamPos)
    .filter(([n]) => n !== agent.name)
    .flatMap(([n, ps]) => (ps as Position[]).map(p => `${n}:${p.symbol}`))
    .join(" ") || "—";
  log(`  💰 BNB:${bnb.toFixed(4)} | Pos:${myPos.length}/${cfg.maxPositions} | Team:[${teamSummary}]`);

  // ── PROFIT → BANK: Überschüssiges BNB automatisch an BANK schicken ──
  if (bnb > 0.025 && bankAddr) {
    const surplus = Math.min(bnb - 0.015, 0.02); // 0.015 BNB behalten für Trades
    if (surplus > 0.003) {
      log(`  💰 PROFIT→BANK: ${surplus.toFixed(4)} BNB`);
      try {
        await execSendBnb(mcp, bankAddr, surplus);
        await sendMessage(agent.name, "BANK", `💰 Profit: ${surplus.toFixed(4)} BNB`);
      } catch {}
    }
  }

  // ── WALLET RECOVERY: BSCScan scannt ALLE Token-Holdings der Wallet ──
  const trackedAddrs = new Set(getPositions(agent.name).map(p => p.address.toLowerCase()));
  // Nur alle 5 Iterationen scannen (BSCScan Rate Limit + spart Zeit)
  if (s.iterations % 5 === 1) {
    try {
      const walletTokens = await scanWalletTokens(agent.wallet.address);
      let recovered = 0;
      for (const tokenAddr of walletTokens) {
        if (trackedAddrs.has(tokenAddr) || SKIP_TOKENS.has(tokenAddr) || isBlacklisted(tokenAddr)) continue;
        const bal = await getTokenBalance(mcp, agent.wallet.address, tokenAddr);
        if (bal.raw > 0n) {
          const sym = bal.symbol || tokenAddr.slice(0, 8);
          log(`  🔄 FOUND: ${sym} (${bal.formatted}) — versuche Sell`);
          try {
            const preSellBnb = await getBnb(mcp, agent.wallet.address);
            await execSell(mcp, agent.wallet.address, tokenAddr, sym, 100, log);
            const postSellBnb = await getBnb(mcp, agent.wallet.address);
            const received = postSellBnb - preSellBnb;
            if (received > 0.0001) {
              log(`     ✅ ${received.toFixed(4)} BNB zurück!`);
              s.sells++;
              s.profitBnb += received;
            } else {
              log(`     ❌ 0 BNB — unsellable, blacklist`);
              blacklistToken(tokenAddr);
            }
            recovered++;
          } catch {
            log(`     ❌ Sell failed — blacklist`);
            blacklistToken(tokenAddr);
          }
          if (recovered >= 5) break; // Max 5 pro Iteration
        }
      }
    } catch {}
  }

  // ── BANK ANWEISUNGEN lesen ──
  const inbox = getInbox(agent.name);
  const bankOrders = inbox.filter(m => m.from === "BANK" && m.text.startsWith("🎯"));
  if (bankOrders.length > 0) {
    const latest = bankOrders[bankOrders.length - 1];
    log(`  📬 BANK sagt: ${latest.text.slice(0, 60)}`);
  }

  // ── TEAM WARN CHECK: Wenn Teammate DUMP_WARN schickt → sofort verkaufen ──
  const teamWarns = getTeamSignals(agent.name).filter(s => s.type === "WARN_SELL" || s.type === "DUMP_WARN");

  // ── AUTO-SELL: Bestehende Positionen prüfen ──
  const positions = getPositions(agent.name);
  for (const p of positions) {
    const bal = await getTokenBalance(mcp, agent.wallet.address, p.address);
    if (bal.raw === 0n) { await removePosition(agent.name, p.address); continue; }
    const price = await getTokenPrice(p.address);
    const age = Math.round((Date.now() - p.enteredAt) / 60000);
    let pnlPct = 0;
    if (price && p.entryPrice && p.entryPrice > 0) pnlPct = (price.price - p.entryPrice) / p.entryPrice * 100;
    log(`  📊 ${p.symbol} | ${age}min | P&L:${pnlPct.toFixed(1)}%`);

    // 🚨 TEAM: Wenn Token pumpt → MOMENTUM Signal ans Team
    if (pnlPct >= 10 && age <= 10) {
      await sendTeamSignal(agent.name, p.address, p.symbol, "MOMENTUM", `+${pnlPct.toFixed(0)}% in ${age}min — RIDE IT!`);
      log(`  📡 MOMENTUM Signal: ${p.symbol} +${pnlPct.toFixed(0)}%`);
    }

    // 🚨 TEAM: Wenn Token dumpt → DUMP_WARN ans Team
    if (pnlPct <= -12 && age >= 5) {
      await sendTeamSignal(agent.name, p.address, p.symbol, "DUMP_WARN", `${pnlPct.toFixed(0)}% — GET OUT!`);
    }

    let autoSellReason = "";

    // TEAM WARN: Teammate sagt DUMP → sofort raus!
    const warn = teamWarns.find(w => w.tokenAddress.toLowerCase() === p.address.toLowerCase());
    if (warn) autoSellReason = `🚨 TEAM DUMP: ${warn.from} says ${warn.reason.slice(0, 30)}`;

    // ── SELL nach Bot-Persönlichkeit ──
    // Jeder Bot hat eigene TP/SL/Scalp/Timeout Werte!
    else if (pnlPct >= 50)                              autoSellReason = `🚀 MOONSHOT +${pnlPct.toFixed(0)}%`;
    else if (pnlPct >= cfg.tpPct && age >= 3)           autoSellReason = `🎯 TP +${pnlPct.toFixed(0)}% (>${cfg.tpPct}%)`;
    else if (pnlPct >= cfg.scalpPct && age >= cfg.scalpMinAge) autoSellReason = `🎯 SCALP +${pnlPct.toFixed(0)}% @${age}min`;
    // ── Stop Loss & Timeouts (pro Bot) ──
    else if (pnlPct <= cfg.slPct)                       autoSellReason = `🛑 SL ${pnlPct.toFixed(0)}% (limit:${cfg.slPct}%)`;
    else if (pnlPct <= -10 && age >= 10)                autoSellReason = `🛑 SL ${pnlPct.toFixed(0)}% @${age}min`;
    else if (age >= cfg.staleAge && pnlPct <= 2)        autoSellReason = `⏰ STALE ${age}min (>${cfg.staleAge}min)`;
    else if (age >= cfg.maxAge)                         autoSellReason = `⏰ MAX-AGE ${age}min (>${cfg.maxAge}min)`;

    if (autoSellReason) {
      log(`  ⚡ AUTO-SELL ${p.symbol}: ${autoSellReason}`);
      try {
        const preSellBnb = await getBnb(mcp, agent.wallet.address);
        await execSell(mcp, agent.wallet.address, p.address, p.symbol, 100, log);
        await removePosition(agent.name, p.address);
        s.sells++;
        const postSellBnb = await getBnb(mcp, agent.wallet.address);
        const received = postSellBnb - preSellBnb;
        const realPnl = received - p.entryBnb;
        const realPnlPct = p.entryBnb > 0 ? (realPnl / p.entryBnb) * 100 : pnlPct;
        if (realPnl > 0) s.profitBnb += realPnl;
        log(`     → ${received.toFixed(4)} BNB zurück (P&L: ${realPnl >= 0 ? "+" : ""}${realPnl.toFixed(4)} BNB / ${realPnlPct.toFixed(1)}%)`);

        // IMMER loggen — auch 0-BNB Sells sind echte Losses (Honeypots!)
        logTrade({ agent: agent.name, action: "SELL", token: p.symbol, address: p.address,
          bnbAmount: p.entryBnb, price: price?.price ?? 0, pnlPct: realPnlPct, bnbResult: Math.max(received, 0),
          timestamp: new Date().toISOString(), success: true, reason: autoSellReason });
        if (received < 0.0001) {
          log(`     🚨 HONEYPOT LOSS — ${p.entryBnb.toFixed(4)} BNB verloren!`);
          blacklistToken(p.address);
          await sendTeamSignal(agent.name, p.address, p.symbol, "WARN_SELL", `HONEYPOT: 0 BNB zurück, ${p.entryBnb.toFixed(4)} verloren`);
        }

        await sendMessage(agent.name, "ALL", `⚡ ${agent.name} SELL ${p.symbol}: ${autoSellReason} → ${received.toFixed(4)} BNB (${realPnlPct >= 0 ? "+" : ""}${realPnlPct.toFixed(1)}%)`);
        // Dust-Token blacklisten damit er nie wieder recovered wird
        if (received < 0.0005) blacklistToken(p.address);
        if (realPnl > 0.001) { try { await execSendBnb(mcp, bankAddr, Math.min(realPnl, 0.05)); } catch {} }
        if (realPnlPct < -15 && received >= 0.0001) {
          blacklistToken(p.address);
          await sendTeamSignal(agent.name, p.address, p.symbol, "WARN_SELL", `Loss ${realPnlPct.toFixed(0)}%`);
        }
        // 🎓 OPUS LERNT — bei signifikanten Trades
        if (received >= 0.0001) {
          opusLearnFromTrade(agent.name, p.symbol, realPnlPct, autoSellReason, age, log).catch(() => {});
        }
        // 🧬 DEEP LEARNING — Cross-Bot Strategie updaten
        updateBotStrategy(agent.name, p.symbol, realPnlPct, age);
      } catch (e) { s.errors++; log(`     ❌ ${String(e).slice(0, 60)}`); }
    }
  }

  // ── LOW BNB? → Positionen liquidieren um BNB zurückzugewinnen! ──
  const curPositions = getPositions(agent.name);
  const minBnb = cfg.baseAmount + 0.001;
  if (bnb < minBnb && curPositions.length > 0) {
    log(`  🚨 LOW BNB (${bnb.toFixed(4)}) — NOTVERKAUF um BNB zu retten!`);
    await sendMessage(agent.name, "BANK", `🚨 LOW GAS ${bnb.toFixed(4)} BNB — liquidiere ${curPositions.length} Positionen`);

    // Schlechteste Position zuerst verkaufen (älteste = wahrscheinlich stuck)
    const sorted = [...curPositions].sort((a, b) => a.enteredAt - b.enteredAt);
    for (const p of sorted) {
      const bal = await getTokenBalance(mcp, agent.wallet.address, p.address);
      if (bal.raw === 0n) { await removePosition(agent.name, p.address); continue; }

      const price = await getTokenPrice(p.address);
      let pnlPct = 0;
      if (price && p.entryPrice && p.entryPrice > 0) pnlPct = (price.price - p.entryPrice) / p.entryPrice * 100;

      log(`  🔥 NOTVERKAUF ${p.symbol} (${Math.round((Date.now() - p.enteredAt) / 60000)}min, P&L:${pnlPct.toFixed(1)}%)`);
      try {
        const preSellBnb = await getBnb(mcp, agent.wallet.address);
        await execSell(mcp, agent.wallet.address, p.address, p.symbol, 100, log);
        await removePosition(agent.name, p.address);
        s.sells++;
        const postSellBnb = await getBnb(mcp, agent.wallet.address);
        const received = postSellBnb - preSellBnb;
        const realPnl = received - p.entryBnb;
        const realPnlPct = p.entryBnb > 0 ? (realPnl / p.entryBnb) * 100 : pnlPct;
        if (realPnl > 0) s.profitBnb += realPnl;
        log(`     → ${received.toFixed(4)} BNB gerettet (P&L: ${realPnlPct.toFixed(1)}%)`);

        if (received >= 0.0001) {
          logTrade({ agent: agent.name, action: "SELL", token: p.symbol, address: p.address,
            bnbAmount: p.entryBnb, price: price?.price ?? 0, pnlPct: realPnlPct, bnbResult: received,
            timestamp: new Date().toISOString(), success: true, reason: `🚨 NOTVERKAUF LOW BNB` });
        }
        if (received < 0.0005) blacklistToken(p.address);
        await sleep(3000);
      } catch (e) { log(`     ❌ ${String(e).slice(0, 60)}`); }

      // Nach erstem Verkauf: genug BNB? → aufhören
      const newBnb = await getBnb(mcp, agent.wallet.address);
      if (newBnb >= minBnb) {
        log(`  ✅ BNB gerettet: ${newBnb.toFixed(4)} — weiter traden!`);
        break;
      }
    }

    // Stuck WBNB auch recovern
    await recoverWBNB(mcp, agent.wallet.address, log);

    const finalBnb = await getBnb(mcp, agent.wallet.address);
    if (finalBnb < minBnb) {
      await sendMessage(agent.name, "BANK", `⛽ DRINGEND! ${finalBnb.toFixed(4)} BNB nach Notverkauf`);
      log(`  ⛔ Immernoch LOW BNB (${finalBnb.toFixed(4)})`);
      return "HOLD (low bnb nach Notverkauf)";
    }
  } else if (bnb < minBnb) {
    // Keine Positionen zum Liquidieren → BANK muss Gas schicken
    await sendMessage(agent.name, "BANK", `⛽ Gas! ${bnb.toFixed(4)} BNB, keine Positionen`);
    await recoverWBNB(mcp, agent.wallet.address, log);
    log(`  ⛔ LOW BNB, keine Positionen`); return "HOLD";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1: DISCOVER — Tokens finden → auf Watchlist setzen
  // ══════════════════════════════════════════════════════════════════════════
  const primary = agent.focus === "new" ? "new" : agent.focus === "volume" ? "volume" : "trending";
  const secondary = primary === "trending" ? "volume" : primary === "new" ? "trending" : "new";
  const [poolsA, poolsB, poolsC] = await Promise.all([
    fetchMemesRaw(primary as any),
    fetchMemesRaw(secondary as any),
    fetchMemesRaw("new"),
  ]);

  // Merge + Deduplicate
  const seen = new Set<string>();
  const allPools: ScoredPool[] = [];
  for (const p of [...poolsA, ...poolsB, ...poolsC]) {
    const key = p.addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allPools.push(p);
  }

  // Filter: blacklist, team holdings, already held
  const candidates = allPools.filter(p => {
    if (isBlacklisted(p.addr)) return false;
    if (isTokenHeldByTeam(p.addr, agent.name)) return false;
    if (curPositions.find(pos => pos.address.toLowerCase() === p.addr.toLowerCase())) return false;
    return true;
  }).sort((a, b) => b.score - a.score);

  // ── TEAM SIGNALS — Momentum von Teammates ──
  const signals = getTeamSignals(agent.name);
  for (const sig of signals.filter(s => s.type === "MOMENTUM")) {
    const addr = sig.tokenAddress.toLowerCase();
    if (curPositions.find(pos => pos.address.toLowerCase() === addr)) continue;
    if (isBlacklisted(addr)) continue;
    const match = candidates.find(c => c.addr.toLowerCase() === addr);
    if (match) {
      match.score += 30;
      log(`  🚀 TEAM MOMENTUM: ${sig.from} → ${sig.tokenSymbol} (+30 bonus)`);
    }
  }

  // Watchlist befüllen: vielversprechende Kandidaten beobachten
  let added = 0;
  for (const p of candidates.slice(0, 20)) {
    // Basic Quality Gate — nur Tokens die Potential haben
    if (p.score < cfg.minScore) continue;

    // Pattern-Check
    const ptMatch = checkPatterns(p);
    if (ptMatch && ptMatch.action === "avoid") continue;

    // BRAIN: min $10k liq oder sehr frisch
    if (agent.name === "BRAIN" && p.liq < 10 && p.age > 30) continue;
    // BOOST: will Momentum
    if (agent.name === "BOOST" && p.c1 < 3 && !(p.c24 < -15 && p.c1 > 0)) continue;

    addToWatchlist(agent.name, p);
    added++;
  }

  // Alte Einträge aufräumen
  const expired = cleanWatchlist(agent.name);
  const wl = getWatchlist(agent.name);
  log(`  👁️ WATCHLIST: ${wl.size} beobachtet (+${added} neu, -${expired} expired) | ${candidates.length} Kandidaten gescannt`);

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2: OBSERVE & ENTRY — Watchlist prüfen auf Entry Signals
  // ══════════════════════════════════════════════════════════════════════════

  // Position Limit pro Bot
  if (curPositions.length >= cfg.maxPositions) {
    log(`  📊 ${curPositions.length}/${cfg.maxPositions} Positionen — max erreicht`);
    return "HOLD (max positions)";
  }

  // Alle Watchlist-Einträge nach Entry-Signal prüfen
  const readyTokens: { entry: WatchlistEntry; signal: EntrySignal }[] = [];
  for (const [, entry] of wl) {
    const signal = checkEntrySignal(entry);

    // Zeige Watchlist-Status im Log
    if (entry.snapshots.length >= 2) {
      const emoji = signal.ready ? "🟢" : signal.confidence >= 40 ? "🟡" : "🔴";
      log(`  ${emoji} ${entry.symbol.padEnd(10)} | ${entry.snapshots.length}snaps | conf:${signal.confidence} | ${signal.reason.slice(0, 50)}`);
    }

    if (signal.ready) {
      readyTokens.push({ entry, signal });
    }
  }

  if (readyTokens.length === 0) {
    // Zeige wie viele noch beobachtet werden
    const watching = [...wl.values()].filter(e => e.snapshots.length < 2).length;
    if (watching > 0) log(`  ⏳ ${watching} Tokens noch in Beobachtung...`);
    return "HOLD (keine Entry-Signals)";
  }

  // Sortiere nach Confidence + Urgency
  readyTokens.sort((a, b) => (b.signal.confidence + b.signal.urgency * 5) - (a.signal.confidence + a.signal.urgency * 5));

  log(`  🎯 ${readyTokens.length} ENTRY SIGNALS!`);

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3: EXECUTE — Kaufen mit Bestätigung
  // ══════════════════════════════════════════════════════════════════════════
  for (const { entry, signal } of readyTokens.slice(0, 3)) {
    const picked = entry.pool;
    log(`  🎯 ENTRY: ${entry.symbol} | conf:${signal.confidence} urg:${signal.urgency} | ${signal.reason.slice(0, 60)}`);

    // Honeypot Check (nochmal mit aktuellen Daten)
    const hp = quickHoneypotCheck(picked)!;
    if (!hp.safe) {
      log(`  🛡️ ❌ ${hp.reason.slice(0, 50)}`);
      if (hp.hardFail) blacklistToken(picked.addr);
      wl.delete(picked.addr.toLowerCase()); // Von Watchlist entfernen
      continue;
    }
    log(`  🛡️ ✅ ${hp.reason.slice(0, 50)}`);

    // Team Dedup
    const nowHeldBy = isTokenHeldByTeam(picked.addr, agent.name);
    if (nowHeldBy) {
      log(`  🤝 ${nowHeldBy} hat ${entry.symbol} schon — skip`);
      wl.delete(picked.addr.toLowerCase());
      continue;
    }

    const priceNow = await getTokenPrice(picked.addr);

    // Entry-Bestätigung: hohe Confidence = Auto, niedrige = AI
    let decision: { execute: boolean; reason: string; adjustedAmount?: number };
    const sellsOk = picked.sells >= 5;

    if (signal.confidence >= 75 && sellsOk) {
      // STARKE ENTRY SIGNAL + bewiesene Sells = Auto-Execute
      const scoreFactor = Math.min((signal.confidence - 60) / 40, 1);
      const amt = cfg.baseAmount + scoreFactor * (cfg.maxAmount - cfg.baseAmount);
      const roundedAmt = Math.round(amt * 1000) / 1000;
      log(`  ⚡ CONFIRMED ENTRY (conf:${signal.confidence}, ${picked.sells} sells)`);
      getStats(agent.name).autoApproves++;
      decision = { execute: true, reason: `Entry: conf:${signal.confidence} ${signal.reason.slice(0, 30)}`, adjustedAmount: roundedAmt };
    } else {
      // Moderate Signal = AI prüft
      const priceStr = priceNow ? `$${priceNow.price.toPrecision(4)} | 1h:${priceNow.change1h.toFixed(1)}% | Liq:$${priceNow.liqK}k` : "kein Preis";
      const watchInfo = `Watched ${entry.snapshots.length} cycles | Entry Signal: ${signal.reason.slice(0, 40)}`;
      decision = await aiConfirm(
        `BUY ${entry.symbol} (${picked.addr})`,
        `Amount: ${cfg.baseAmount} BNB | ${priceStr}\nScore: ${picked.score} | ${watchInfo}\nSells: ${picked.sells} | Confidence: ${signal.confidence}% | BNB: ${bnb.toFixed(4)}`,
        log, agent.name, picked.score
      );
      if (decision.execute && !decision.adjustedAmount) decision.adjustedAmount = cfg.baseAmount;
    }

    if (!decision.execute) {
      log(`  🧠 ❌ ${decision.reason.slice(0, 50)}`);
      continue;
    }
    log(`  🧠 ✅ ${decision.reason.slice(0, 50)}`);

    // Execute BUY
    const amount = decision.adjustedAmount ?? cfg.baseAmount;
    const symbol = entry.symbol;

    log(`  💰 BUY ${symbol} — ${amount}BNB (nach ${entry.snapshots.length} Beobachtungen)`);

    const preBuyBnb = await getBnb(mcp, agent.wallet.address);
    await addPosition(agent.name, picked.addr, symbol, amount, priceNow?.price);

    try {
      const result = await execBuy(mcp, agent.wallet.address, picked.addr, symbol, amount, log, picked.dex);
      log(`     → ${result.slice(0, 100)}`);

      if (!result.toLowerCase().includes("error")) {
        const postBuyBnb = await getBnb(mcp, agent.wallet.address);
        const realCost = Math.max(preBuyBnb - postBuyBnb, amount);

        await sleep(2000);
        const boughtBal = await getTokenBalance(mcp, agent.wallet.address, picked.addr);
        if (boughtBal.raw === 0n) {
          log(`     🚨 HONEYPOT! Swap OK aber 0 Tokens → Blacklist`);
          blacklistToken(picked.addr);
          await removePosition(agent.name, picked.addr);
          s.errors++;
          logTrade({ agent: agent.name, action: "BUY", token: symbol, address: picked.addr,
            bnbAmount: realCost, price: 0, pnlPct: -100, timestamp: new Date().toISOString(), success: false, reason: `HONEYPOT: 0 tokens received` });
          await sendTeamSignal(agent.name, picked.addr, symbol, "WARN_SELL", `HONEYPOT: 0 tokens nach Buy`);
          wl.delete(picked.addr.toLowerCase());
          continue;
        }

        log(`     ✅ ${boughtBal.formatted} ${symbol} erhalten`);
        await removePosition(agent.name, picked.addr);
        await addPosition(agent.name, picked.addr, symbol, realCost, priceNow?.price);
        log(`     💸 Real cost: ${realCost.toFixed(4)} BNB (inkl. Gas)`);
        s.buys++;
        logTrade({ agent: agent.name, action: "BUY", token: symbol, address: picked.addr,
          bnbAmount: amount, price: priceNow?.price ?? 0, timestamp: new Date().toISOString(), success: true, reason: `WATCHLIST conf:${signal.confidence} ${signal.reason.slice(0, 30)}` });
        await sendMessage(agent.name, "ALL", `💰 ${agent.name} bought ${symbol} ${amount}BNB (conf:${signal.confidence})`);
        await sendTeamSignal(agent.name, picked.addr, symbol, "VERIFIED_BUY", `Conf:${signal.confidence} Liq:$${picked.liq}k`);
        log(`  📡 VERIFIED_BUY → Team`);
        await markSignalUsed(picked.addr);
        wl.delete(picked.addr.toLowerCase()); // Von Watchlist entfernen nach Kauf
        return `BUY ${symbol} ${amount}BNB (watched ${entry.snapshots.length}x, conf:${signal.confidence})`;
      } else {
        s.errors++;
        await removePosition(agent.name, picked.addr);
        logTrade({ agent: agent.name, action: "BUY", token: symbol, address: picked.addr,
          bnbAmount: amount, price: priceNow?.price ?? 0, timestamp: new Date().toISOString(), success: false, reason: result.slice(0, 80) });
        continue;
      }
    } catch (e) {
      s.errors++;
      await removePosition(agent.name, picked.addr);
      releaseClaim(picked.addr);
      log(`     ❌ ${String(e).slice(0, 60)}`);
      continue;
    }
  }

  return "HOLD (Entry-Signals geprüft, keine Execution)";
}

// ── Startup Funding ────────────────────────────────────────────────────────────
async function bankFundTeam(wallets: Record<string, Wallet>): Promise<void> {
  if (!process.env.PRIVATE_KEY) { console.log("  ⚠️  Kein PRIVATE_KEY"); return; }
  console.log("\n  🏦 BANK: Team-Wallets...");
  let swarmMcp: Awaited<ReturnType<typeof connectBNBChain>> | null = null;
  try {
    swarmMcp = await connectBNBChain(process.env.PRIVATE_KEY);
    const swarmBnb = await getBnb(swarmMcp.client, SWARM_WALLET_ADDRESS);
    console.log(`  🏦 Swarm: ${swarmBnb.toFixed(4)} BNB`);
    for (const [n, w] of [["BLAZE", wallets["SCOUT"]], ["BRAIN", wallets["DATABASE"]], ["BOOST", wallets["PUSHER"]], ["BANK", wallets["ORACLE"]]] as [string, Wallet][]) {
      if (!w) continue;
      const b = await getBnb(swarmMcp.client, w.address);
      console.log(`     ${n}: ${b.toFixed(4)} BNB`);
      if (b < 0.012 && swarmBnb > 0.025) {
        try { await execSendBnb(swarmMcp.client, w.address, parseFloat((0.02 - b).toFixed(4))); console.log(`     ✅ ${n} funded`); await sleep(4000); }
        catch (e) { console.log(`     ❌ ${e}`); }
      }
    }
  } catch (e) { console.log(`  ⚠️ ${e}`); }
  finally { try { await (swarmMcp?.client as any)?.close?.(); } catch {} }
  console.log("  🏦 Done\n");
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
function printDashboard(): void {
  const now = new Date().toISOString().slice(11, 19);
  const uptime = Math.round((Date.now() - startTime) / 60000);
  const W = 82;
  const line = "═".repeat(W);
  const thin = "─".repeat(W);
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  const bold = "\x1b[1m";
  const colors: Record<string, string> = { BLAZE: "\x1b[36m", BRAIN: "\x1b[33m", BOOST: "\x1b[35m", BANK: "\x1b[32m" };
  const roles: Record<string, string> = { BLAZE: "⚡SNIPER", BRAIN: "🧠ANALYST", BOOST: "📈MOMENTUM", BANK: "🏦TREASURY" };
  const jStats = getTradeStats();
  const journal = loadJournal();

  // Team totals
  let teamBnb = 0, teamProfit = 0, teamLoss = 0, totalTrades = 0;
  for (const name of ["BLAZE", "BRAIN", "BOOST", "BANK"]) {
    const s = getStats(name);
    totalTrades += s.buys;
    teamProfit += Math.max(s.profitBnb, 0);
    teamBnb += s.lastBnb;
  }
  const losses = journal.filter(e => e.action === "SELL" && e.success && (e.pnlPct ?? 0) < -5);
  for (const l of losses) teamLoss += Math.abs((l.bnbResult ?? 0) - l.bnbAmount);
  const netPnl = teamProfit - teamLoss;
  const netColor = netPnl >= 0 ? "\x1b[32m" : "\x1b[31m";

  // ── HEADER ──
  console.log(`\n\x1b[33m${line}${rst}`);
  console.log(`${bold}  📊 BOB SQUAD v21 — ${now} — ${uptime}min uptime${rst}`);
  console.log(`  ${jStats.wins}W ${jStats.losses}L ${jStats.neutral}N (${bold}${jStats.winRate.toFixed(0)}%${rst}) | ${totalTrades} trades | ${netColor}NET: ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(4)} BNB${rst} | Team: ${bold}${teamBnb.toFixed(4)} BNB${rst}`);
  console.log(`${dim}${thin}${rst}`);

  // ── BOTS ──
  for (const name of ["BLAZE", "BRAIN", "BOOST", "BANK"]) {
    const s = getStats(name);
    const pos = getPositions(name);
    const cfg = getEffectiveConfig(name);
    const baseCfg = BOT_CONFIGS[name];
    const pnlC = s.profitBnb >= 0 ? "\x1b[32m" : "\x1b[31m";
    const bnbC = s.lastBnb < 0.005 ? "\x1b[31m" : s.lastBnb > 0.02 ? "\x1b[32m" : "\x1b[33m";

    // Bot-Header mit BNB + P&L
    console.log(`  ${colors[name]}${bold}${name}${rst} ${dim}${roles[name]}${rst}  ${bnbC}${s.lastBnb.toFixed(4)}BNB${rst} | ${pnlC}${s.profitBnb >= 0 ? "+" : ""}${s.profitBnb.toFixed(4)}${rst} | b:${s.buys} s:${s.sells} e:${s.errors} | opus:${s.opusCalls} son:${s.sonnetCalls} hai:${s.haikuCalls} auto:${s.autoApproves}`);

    // Dynamic Config Änderungen markieren (wenn != base)
    if (baseCfg && name !== "BANK") {
      const diffs: string[] = [];
      if (cfg.tpPct !== baseCfg.tpPct) diffs.push(`TP:${cfg.tpPct}%*`);
      if (cfg.slPct !== baseCfg.slPct) diffs.push(`SL:${cfg.slPct}%*`);
      if (cfg.minScore !== baseCfg.minScore) diffs.push(`min:${cfg.minScore}*`);
      if (cfg.scalpPct !== baseCfg.scalpPct) diffs.push(`scalp:${cfg.scalpPct}%*`);
      if (cfg.maxAge !== baseCfg.maxAge) diffs.push(`age:${cfg.maxAge}m*`);
      if (diffs.length > 0) {
        console.log(`    ${dim}⚙️ Dynamic: ${diffs.join(" ")}${rst}`);
      }
    }

    // Positionen
    if (pos.length > 0) {
      for (const p of pos) {
        const age = Math.round((Date.now() - p.enteredAt) / 60000);
        const cached = priceCache[p.address.toLowerCase()];
        let pnlStr = `${dim}?${rst}`;
        if (cached && p.entryPrice && p.entryPrice > 0) {
          const pnl = (cached.data.price - p.entryPrice) / p.entryPrice * 100;
          const pc = pnl >= 5 ? "\x1b[32m" : pnl <= -5 ? "\x1b[31m" : "\x1b[33m";
          pnlStr = `${pc}${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%${rst}`;
        }
        const ageC = age > cfg.staleAge ? "\x1b[31m" : age > cfg.scalpMinAge ? "\x1b[33m" : "\x1b[32m";
        console.log(`    → ${p.symbol.padEnd(12)} ${ageC}${String(age).padStart(3)}min${rst} ${p.entryBnb.toFixed(3)}BNB ${pnlStr}`);
      }
    } else if (name !== "BANK") {
      // Watchlist anzeigen statt "scanning..."
      const wl = getWatchlist(name);
      if (wl.size > 0) {
        const watching = [...wl.values()];
        const ready = watching.filter(w => checkEntrySignal(w).ready).length;
        const observing = watching.filter(w => w.snapshots.length < 2).length;
        console.log(`    ${dim}👁️ Watchlist: ${wl.size} (${ready} ready, ${observing} observing)${rst}`);
      } else {
        console.log(`    ${dim}(scanning...)${rst}`);
      }
    }
  }

  // ── LETZTE TRADES ──
  const recentSells = journal.filter(e => e.action === "SELL" && e.success).slice(-5);
  if (recentSells.length > 0) {
    console.log(`${dim}${thin}${rst}`);
    console.log(`  ${bold}📜 TRADES${rst}`);
    for (const t of recentSells) {
      const pnl = t.pnlPct ?? 0;
      const pnlC = pnl >= 2 ? "\x1b[32m" : pnl <= -5 ? "\x1b[31m" : "\x1b[33m";
      const icon = pnl >= 2 ? "✅" : pnl <= -5 ? "❌" : "⏸️";
      console.log(`    ${t.timestamp.slice(11, 19)} ${t.agent.padEnd(5)} ${icon} ${t.token.padEnd(10)} ${pnlC}${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%${rst} ${t.bnbResult?.toFixed(4) ?? "?"}BNB ${dim}${t.reason.slice(0, 28)}${rst}`);
    }
  }

  // ── OPUS LEARNINGS ──
  if (dynamicConfigLog.length > 0) {
    console.log(`${dim}${thin}${rst}`);
    console.log(`  ${bold}🎓 OPUS CONFIG-CHANGES${rst}`);
    for (const c of dynamicConfigLog.slice(-5)) {
      console.log(`    ${c.time} ${c.bot}.${c.param}: ${c.old}→\x1b[36m${c.val}${rst} ${dim}(${c.reason})${rst}`);
    }
  }

  // ── DEEP LEARNING ──
  const dl = loadDeepLearn();
  const wDiffs: string[] = [];
  const defW = { momentum1h: 1.0, ageFactor: 1.0, liqFactor: 1.0, reversalFactor: 1.0, activityFactor: 1.0, buyPressure: 1.0 };
  for (const [k, v] of Object.entries(dl.scoreWeights)) {
    if (v !== (defW as any)[k]) wDiffs.push(`${k.replace("Factor", "").slice(0, 6)}:${v.toFixed(1)}`);
  }
  if (wDiffs.length > 0 || dl.patterns.length > 0 || deepLearnLog.length > 0) {
    console.log(`${dim}${thin}${rst}`);
    console.log(`  ${bold}🧬 DEEP LEARNING${rst} (${dl.totalDeepReviews} reviews)`);
    if (wDiffs.length > 0) console.log(`    ⚖️ Weights: ${wDiffs.join(" ")}`);
    if (dl.patterns.length > 0) console.log(`    🔍 Patterns: ${dl.patterns.length} (${dl.patterns.filter(p => p.action === "avoid").length} avoid, ${dl.patterns.filter(p => p.action === "prefer").length} prefer)`);
    const rs = Object.entries(dl.routeStats);
    if (rs.length > 0) console.log(`    🛤️ Routes: ${rs.map(([k, v]) => `${k}:v2=${v.v2}/hop=${v.v2hop}/v3=${v.v3}`).join(" ")}`);
    for (const l of deepLearnLog.slice(-3)) {
      console.log(`    ${dim}${l.time} ${l.what}: ${l.detail}${rst}`);
    }
  }

  // ── FOOTER ──
  console.log(`${dim}${thin}${rst}`);
  console.log(`  🚫 BL:${tokenBlacklist.size} SF:${swapFailList.size} | 📡 ${Object.keys(rawCache).length}pools ${Object.keys(priceCache).length}prices | ⚙️ v21 watchlist`);
  console.log(`\x1b[33m${line}${rst}\n`);
}

// ── Agent Runner ───────────────────────────────────────────────────────────────
async function runAgent(agent: Agent, teamAddresses: Record<string, string>): Promise<void> {
  const c = agent.color, r = "\x1b[0m";
  const log = (msg: string) => console.log(`${c}[${agent.name}]${r} ${msg}`);
  const isBank = agent.focus === "treasury";
  const cfgInfo = getEffectiveConfig(agent.name);
  log(`🚀 ${agent.wallet.address.slice(0, 10)}… | ${agent.interval / 1000}s | ${agent.role}`);
  if (cfgInfo) log(`   TP:+${cfgInfo.tpPct}% SL:${cfgInfo.slPct}% Scalp:+${cfgInfo.scalpPct}%@${cfgInfo.scalpMinAge}min | Max:${cfgInfo.maxPositions}pos | ${cfgInfo.baseAmount}-${cfgInfo.maxAmount}BNB`);

  let mcp: Awaited<ReturnType<typeof connectBNBChain>> | null = null;
  const s = getStats(agent.name);

  while (true) {
    try {
      if (!mcp) {
        log("🔗..."); mcp = await connectBNBChain(agent.wallet.privateKey); log("✅");
        // Stuck WBNB nach fehlgeschlagenen Swaps recovern
        await recoverWBNB(mcp.client, agent.wallet.address, log);
      }
      s.iterations++;
      log(`\n── #${s.iterations} [${new Date().toISOString().slice(11, 19)}] ─────────────────────`);
      const result = isBank ? await runBank(agent, mcp.client, teamAddresses, log) : await runTrader(agent, mcp.client, teamAddresses, log);
      log(`✅ ${result}`);
      maybeBlacklistSave();
      if (isBank) printDashboard();
      await sleep(agent.interval);
    } catch (e) { s.errors++; log(`❌ ${String(e).slice(0, 120)}`); mcp = null; await sleep(30_000); }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY fehlt"); process.exit(1); }
  loadBlacklistFromDisk(); // Persistente Blacklist laden
  const wallets = loadWallets();

  console.log(`
\x1b[33m╔══════════════════════════════════════════════════════════════════════════╗
║   \x1b[1mBOB TRADING SQUAD v21.0\x1b[0m\x1b[33m — BUILD ON BNB 🟡                            ║
╠══════════════════════════════════════════════════════════════════════════╣
║  \x1b[36mBLAZE\x1b[33m  SNIPER    | Frischeste zuerst · schnell rein/raus · 20min max  ║
║  \x1b[33mBRAIN\x1b[33m  ANALYST   | Nur Quality · min $10k liq · hält bis +20%          ║
║  \x1b[35mBOOST\x1b[33m  MOMENTUM  | 1h-Pumps · Reversals · reitet die Welle             ║
║  \x1b[32mBANK \x1b[33m  TREASURY  | Gas-Verteilung · $BOB kaufen · Strategy Reviews      ║
╠══════════════════════════════════════════════════════════════════════════╣
║  👁️ WATCHLIST: Erst beobachten, dann handeln! Snapshots → Entry Signal  ║
║  📊 Entry: Preis steigt + Volume steigt + 5+ Sells = KAUFEN            ║
║  🧬 Deep Learning: Score Weights · Pattern Recognition · Route Learning  ║
║  🚫 Scamcoins blocked · 4 Sell Routes · Honeypot Detection              ║
║  \x1b[1mBuild On BNB! $BOB — build. believe. become.\x1b[0m\x1b[33m                          ║
╚══════════════════════════════════════════════════════════════════════════╝\x1b[0m
`);

  await bankFundTeam(wallets);
  const AGENTS: Agent[] = [
    { name: "BLAZE", role: "Sniper — fresh tokens first", wallet: wallets["SCOUT"],    color: "\x1b[36m", startDelay: 0,      interval: 40_000,  focus: "new" },
    { name: "BRAIN", role: "Analyst — quality only",     wallet: wallets["DATABASE"], color: "\x1b[33m", startDelay: 10_000,  interval: 60_000,  focus: "volume" },
    { name: "BOOST", role: "Momentum — ride the wave",   wallet: wallets["PUSHER"],  color: "\x1b[35m", startDelay: 20_000,  interval: 45_000,  focus: "trending" },
    { name: "BANK",  role: "Treasury — Gas + $BOB",      wallet: wallets["ORACLE"],  color: "\x1b[32m", startDelay: 30_000,  interval: 90_000,  focus: "treasury" },
  ];
  const teamAddresses = {
    BLAZE: wallets["SCOUT"]?.address ?? "", BRAIN: wallets["DATABASE"]?.address ?? "",
    BOOST: wallets["PUSHER"]?.address ?? "", BANK: wallets["ORACLE"]?.address ?? "",
  };
  await Promise.all(AGENTS.map(a => new Promise<void>(r => setTimeout(() => runAgent(a, teamAddresses).catch(e => console.error(`[${a.name}] Fatal:`, e)).then(r), a.startDelay))));
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main();
