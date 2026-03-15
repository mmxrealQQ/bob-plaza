// ── Shared Types for BOB Agent Swarm ─────────────────────────────────────────

export type WalletType = "contract" | "agent" | "bot" | "user" | "unknown";
export type AgentStatus = "active" | "inactive" | "ghost" | "rugger" | "unknown";

export interface AgentRecord {
  agentId: number;
  owner: string;
  name: string;
  description: string;
  agentURI: string;
  endpoint: string | null;
  mcpEndpoint: string | null;
  a2aEndpoint: string | null;
  score: number;
  status: AgentStatus;
  lastChecked: string;
  respondsToPost: boolean;
  chain: string;
  services: string[];
  firstSeen: string;
  notes: string;
}

export interface WalletRecord {
  address: string;
  type: WalletType;
  label: string;
  agentId?: number;
  txCount?: number;
  isContract: boolean;
  firstSeen: string;
  lastSeen: string;
  rugConfidence: number; // 0-100, 100 = confirmed rugger
  notes: string;
}

export interface RugRecord {
  tokenAddress: string;
  tokenSymbol: string;
  deployerWallet: string;
  lpRemovalTx: string;
  lpRemovalTime: string;
  priceDropPct: number;
  liquidityRemovedBnb: number;
  destinationWallets: string[];
  confirmed: boolean; // only true if 100% verified
  traceComplete: boolean;
  notes: string;
}

export interface TradeSignal {
  id: string;
  proposedBy: string;
  tokenAddress: string;
  tokenSymbol: string;
  direction: "buy" | "sell";
  bnbAmount?: number;        // for buy: how much BNB to spend
  sellPct?: number;          // for sell: % of holdings to sell (1-100)
  reason: string;
  confidence: number;        // 0-100
  proposedAt: string;
  executed: boolean;
  executedAt?: string;
  result?: string;
}

export interface SwarmMessage {
  from: string; // agent name
  to: string;   // agent name or "all"
  type: "new_agents" | "rug_alert" | "wallet_classified" | "bob_opportunity" | "ping" | "trade_signal";
  payload: unknown;
  timestamp: string;
}

export interface SwarmState {
  agents: Record<number, AgentRecord>;
  wallets: Record<string, WalletRecord>;
  ruggers: RugRecord[];
  inbox: SwarmMessage[];          // messages between agents
  pendingAnalysis: number[];      // agentIds waiting for database
  lastScanRange: [number, number]; // last scanned ID range
  totalScanned: number;
  pendingTrades: TradeSignal[];   // trade proposals from any agent
  tradeHistory: TradeSignal[];    // executed trades (last 50)
  stats: {
    activeAgents: number;
    inactiveAgents: number;
    ghostAgents: number;
    confirmedRuggers: number;
    walletsClassified: number;
  };
  updatedAt: string;
}

export const DEFAULT_STATE: SwarmState = {
  agents: {},
  wallets: {},
  ruggers: [],
  inbox: [],
  pendingAnalysis: [],
  lastScanRange: [0, 0],
  totalScanned: 0,
  pendingTrades: [],
  tradeHistory: [],
  stats: {
    activeAgents: 0,
    inactiveAgents: 0,
    ghostAgents: 0,
    confirmedRuggers: 0,
    walletsClassified: 0,
  },
  updatedAt: new Date().toISOString(),
};
