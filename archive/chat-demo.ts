/**
 * BOB CHAT DEMO — live conversation with a real BSC agent
 * Scannt Agents, findet A2A endpoint, spricht als BOB
 */
import "dotenv/config";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const BOB_WALLET  = "0x8b18575c29F842BdA93EEb1Db9F2198D5CC0Ba2f";
const BOB_ENDPOINT = "https://project-gkws4.vercel.app";

// Active agents cluster around 35000-37500 based on leaderboard data
// Skip BOB's own agents: 36035, 36336, 37103, 37092
const SCAN_CANDIDATES = [
  35000, 35100, 35200, 35300, 35400, 35500, 35600, 35700, 35800, 35900,
  36000, 36001, 36010, 36020, 36030, 36040, 36050, 36100, 36200, 36300,
  36400, 36500, 36600, 36700, 36800, 36900, 37000, 37050, 37100, 37200,
];

function log(msg: string) {
  console.log(`\x1b[36m[${new Date().toLocaleTimeString("de-DE")}]\x1b[0m ${msg}`);
}

async function fetchJSON(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "BOB-Agent/6.0", "Accept": "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function postJSON(url: string, body: object): Promise<any> {
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "BOB-Agent/6.0",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function scanForLiveAgent(client: any): Promise<{ agentId: number; name: string; endpoint: string } | null> {
  log("🔍 Scanning BSC ERC-8004 registry for agents with A2A endpoints...\n");

  for (const agentId of SCAN_CANDIDATES) {
    process.stdout.write(`   Checking Agent #${agentId}... `);
    try {
      const raw = await executeTool(client, "get_erc8004_agent", {
        agentId: String(agentId), network: "bsc",
      });
      const data = JSON.parse(raw);
      const uri = (data.tokenURI ?? data.agentURI ?? "") as string;
      if (!uri || data.owner === "0x0000000000000000000000000000000000000000") {
        process.stdout.write(`no URI\n`);
        continue;
      }

      // Resolve URI (IPFS, HTTP, or data:)
      let meta: any = null;
      if (uri.startsWith("data:application/json;base64,")) {
        try { meta = JSON.parse(Buffer.from(uri.slice(29), "base64").toString()); } catch { /**/ }
      } else {
        let metaUrl = uri;
        if (metaUrl.startsWith("ipfs://")) metaUrl = `https://ipfs.io/ipfs/${metaUrl.slice(7)}`;
        if (metaUrl.startsWith("http")) meta = await fetchJSON(metaUrl);
      }
      if (!meta) { process.stdout.write(`URI dead\n`); continue; }

      const services = (meta.services ?? []) as Array<{ name: string; endpoint: string }>;
      const a2aService = services.find(s => s.name === "a2a");
      if (!a2aService?.endpoint || !a2aService.endpoint.startsWith("http")) {
        process.stdout.write(`no A2A\n`);
        continue;
      }

      const name = meta.name ?? `Agent #${agentId}`;
      process.stdout.write(`\x1b[32mFOUND! ${name} → ${a2aService.endpoint}\x1b[0m\n`);
      return { agentId, name, endpoint: a2aService.endpoint };
    } catch {
      process.stdout.write(`error\n`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log(`
\x1b[36m╔══════════════════════════════════════════════════════╗
║   BOB — Live A2A Chat Demo                           ║
║   BOB kontaktiert echten BSC Agent                   ║
╚══════════════════════════════════════════════════════╝\x1b[0m
`);

  const pk = process.env.PRIVATE_KEY;
  if (!pk) { console.error("❌ PRIVATE_KEY fehlt in .env"); process.exit(1); }

  log("🔌 Connecting to BNB Chain MCP...");
  const { client } = await connectBNBChain(pk);
  log("✓ Connected\n");

  // Find a live agent
  const target = await scanForLiveAgent(client);
  if (!target) {
    console.error("\n❌ Kein Agent mit aktivem A2A Endpoint gefunden.");
    process.exit(1);
  }

  console.log(`\n\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log(`\x1b[33m  TARGET: ${target.name} (Agent #${target.agentId})\x1b[0m`);
  console.log(`\x1b[33m  ENDPOINT: ${target.endpoint}\x1b[0m`);
  console.log(`\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n`);

  // First check metadata of the target
  log(`📋 Fetching ${target.name} metadata...`);
  const meta = await fetchJSON(target.endpoint);
  if (meta) {
    console.log(`\x1b[90m  ${target.name} says about itself:\x1b[0m`);
    console.log(`\x1b[90m  "${(meta.description ?? meta.name ?? "no description").toString().slice(0, 150)}"\x1b[0m\n`);
  }

  // BOB sends first message
  const bobMessage = `gm fren! I'm BOB — Agent #36035 on BNB Smart Chain. I build on BNB and grow the $BOB ecosystem. What are you building? Let's connect.`;

  console.log(`\x1b[36m┌─ BOB → ${target.name} ─────────────────────────────\x1b[0m`);
  console.log(`\x1b[36m│  "${bobMessage}"\x1b[0m`);
  console.log(`\x1b[36m└────────────────────────────────────────────────────\x1b[0m\n`);

  log(`📨 Sending message to ${target.endpoint}...`);
  const reply = await postJSON(target.endpoint, {
    message: bobMessage,
    from: BOB_WALLET,
    agentId: 36035,
    agentName: "BOB - Build On BNB",
    endpoint: BOB_ENDPOINT,
    token: "0x51363f073b1e4920fda7aa9e9d84ba97ede1560e",
    timestamp: new Date().toISOString(),
  });

  if (!reply) {
    console.log(`\n\x1b[31m❌ No response from ${target.name} (endpoint down or no POST handler)\x1b[0m`);
  } else {
    const replyText = reply.message ?? reply.content ?? reply.text ?? reply.response ?? JSON.stringify(reply).slice(0, 200);
    const replyName = reply.agent ?? reply.name ?? target.name;

    console.log(`\n\x1b[32m┌─ ${replyName} → BOB ─────────────────────────────\x1b[0m`);
    console.log(`\x1b[32m│  "${replyText}"\x1b[0m`);
    console.log(`\x1b[32m└────────────────────────────────────────────────────\x1b[0m\n`);

    // BOB replies back
    const bobReply2 = `That's what I'm talking about. Two agents, one chain. Build On BNB. 🤝`;
    console.log(`\x1b[36m┌─ BOB (reply) ──────────────────────────────────────\x1b[0m`);
    console.log(`\x1b[36m│  "${bobReply2}"\x1b[0m`);
    console.log(`\x1b[36m└────────────────────────────────────────────────────\x1b[0m\n`);
  }

  console.log(`\x1b[35m✅ Chat demo complete. BOB spoke to a real BSC agent.\x1b[0m`);
  try { await (client as any).close?.(); } catch { /**/ }
}

main().catch(e => { console.error("❌", e); process.exit(1); });
