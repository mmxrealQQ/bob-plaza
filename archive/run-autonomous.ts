import "dotenv/config";
import { connectBNBChain } from "./mcp-client.js";
import { BobAutonomous } from "./autonomous.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set in .env");
    process.exit(1);
  }

  if (!process.env.PRIVATE_KEY) {
    console.error("ERROR: PRIVATE_KEY not set — autonomous mode needs write access");
    process.exit(1);
  }

  // Interval in minutes — default 60 (builder mode conserves API budget)
  const intervalMinutes = parseInt(process.env.BOB_INTERVAL ?? "60");
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log("⚡ Connecting to BNB Chain MCP...");

  const connection = await connectBNBChain(process.env.PRIVATE_KEY);
  console.log(`✓ Connected — ${connection.tools.length} tools loaded`);

  const bob = new BobAutonomous(connection.client, connection.tools);
  await bob.start(intervalMs);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
