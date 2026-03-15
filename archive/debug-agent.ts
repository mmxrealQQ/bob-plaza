import "dotenv/config";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const { client } = await connectBNBChain(process.env.PRIVATE_KEY!);

async function resolveURI(uri: string) {
  if (!uri) return null;
  if (uri.startsWith("data:application/json;base64,")) {
    try { return JSON.parse(Buffer.from(uri.slice(29), "base64").toString()); } catch { return null; }
  }
  let url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Check metadata of several agents to understand structure
for (const id of ["35100", "36000", "36001", "36050", "36100", "36300", "36500", "37000"]) {
  const raw = await executeTool(client, "get_erc8004_agent", { agentId: id, network: "bsc" });
  const data = JSON.parse(raw);
  const uri = data.tokenURI ?? data.agentURI ?? "";
  const meta = await resolveURI(uri);
  console.log(`\n=== #${id} ===`);
  if (meta) {
    console.log("name:", meta.name);
    console.log("services:", JSON.stringify(meta.services));
    console.log("a2a:", JSON.stringify(meta.a2a));
    console.log("endpoint:", meta.endpoint);
    console.log("keys:", Object.keys(meta).join(", "));
  } else {
    console.log("no meta | uri:", uri?.slice(0, 80));
  }
}

try { await (client as any).close?.(); } catch {}

