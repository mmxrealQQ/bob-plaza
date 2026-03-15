import "dotenv/config";
import readline from "readline";
import { connectBNBChain } from "./mcp-client.js";
import { BobAgent } from "./bob.js";
import { BOB_WELCOME } from "./system-prompt.js";

async function main() {
  console.log(BOB_WELCOME);

  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key.\n");
    process.exit(1);
  }

  const privateKey = process.env.PRIVATE_KEY || undefined;
  const mode = privateKey ? "READ + WRITE" : "READ-ONLY (no PRIVATE_KEY set)";

  console.log(`⚡ Connecting to BNB Chain MCP... (Mode: ${mode})`);

  let connection;
  try {
    connection = await connectBNBChain(privateKey);
  } catch (err) {
    console.error("\nFailed to connect to BNB Chain MCP server.");
    console.error("Make sure Node.js and npx are available.");
    console.error(err);
    process.exit(1);
  }

  const bob = new BobAgent(connection.client, connection.tools);

  console.log(`✓ Connected — ${bob.getToolCount()} BNB Chain tools loaded\n`);

  // Set up readline for interactive input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nYou: ",
  });

  const handleCommand = async (input: string): Promise<boolean> => {
    const cmd = input.trim().toLowerCase();

    if (cmd === "/exit" || cmd === "/quit") {
      console.log("\nBOB: BUIDL on. Catch you on-chain. 🔧\n");
      rl.close();
      process.exit(0);
    }

    if (cmd === "/clear") {
      bob.clearHistory();
      console.log("[Conversation history cleared]\n");
      return true;
    }

    if (cmd === "/tools") {
      const names = bob.getToolNames();
      console.log(`\n${names.length} tools available:\n`);
      names.forEach((name) => console.log(`  • ${name}`));
      console.log();
      return true;
    }

    if (cmd === "/status") {
      console.log(`\nStatus:`);
      console.log(`  Model:   claude-opus-4-6`);
      console.log(`  Tools:   ${bob.getToolCount()} BNB Chain tools`);
      console.log(`  Mode:    ${mode}`);
      console.log(`  Token:   BOB (0x51363f073b1e4920fda7aa9e9d84ba97ede1560e)`);
      console.log();
      return true;
    }

    if (cmd === "/help") {
      console.log(`
Commands:
  /tools    — List all ${bob.getToolCount()} available BNB Chain tools
  /clear    — Clear conversation history
  /status   — Show connection status
  /exit     — Exit BOB
`);
      return true;
    }

    return false;
  };

  // Main input loop
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (input.startsWith("/")) {
      await handleCommand(input);
      rl.prompt();
      return;
    }

    // Send to BOB
    try {
      await bob.chat(input);
    } catch (err) {
      console.error("\n[Error]", err instanceof Error ? err.message : err);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
