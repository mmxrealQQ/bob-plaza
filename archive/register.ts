import "dotenv/config";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const AGENT_URI =
  "https://gist.githubusercontent.com/graffabian-ops/c9a2407ed5ada6e13a1aaa2f70d9060d/raw/66e50f93d401470c4ede61dfd34736991661e171/bob-agent-uri.json";

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("ERROR: PRIVATE_KEY not set");
    process.exit(1);
  }

  console.log("⚡ Connecting to BNB Chain...");
  const { client } = await connectBNBChain(process.env.PRIVATE_KEY);
  console.log("✓ Connected\n");

  console.log("📋 Registering BOB as ERC-8004 agent on BSC Mainnet...");
  console.log("   agentURI:", AGENT_URI);
  console.log("");

  const result = await executeTool(client, "register_erc8004_agent", {
    agentURI: AGENT_URI,
    network: "bsc",
  });

  console.log("Result:", result);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
