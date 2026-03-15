import "dotenv/config";
import { connectBNBChain, executeTool } from "./mcp-client.js";

const AGENT_ID = "36035";
const NEW_AGENT_URI = "https://bob-agent.graf-fabian.workers.dev";

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("ERROR: PRIVATE_KEY not set");
    process.exit(1);
  }

  console.log("⚡ Connecting to BNB Chain...");
  const { client } = await connectBNBChain(process.env.PRIVATE_KEY);
  console.log("✓ Connected\n");

  console.log("🔄 Updating BOB's agentURI on-chain...");
  console.log("   Agent ID:", AGENT_ID);
  console.log("   New URI:", NEW_AGENT_URI);
  console.log("");

  const result = await executeTool(client, "set_erc8004_agent_uri", {
    agentId: AGENT_ID,
    newURI: NEW_AGENT_URI,
    network: "bsc",
  });

  console.log("Result:", result);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
