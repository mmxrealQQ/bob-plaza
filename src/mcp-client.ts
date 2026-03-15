import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import type Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MCPConnection {
  client: Client;
  tools: Anthropic.Tool[];
}

/**
 * Creates and connects a MCP client to the BNB Chain MCP server.
 * Private key is optional — without it, BOB runs in read-only mode.
 */
export async function connectBNBChain(privateKey?: string): Promise<MCPConnection> {
  // Build clean environment for the MCP subprocess
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) env[key] = val;
  }
  if (privateKey) {
    env["PRIVATE_KEY"] = privateKey;
  }

  // Use locally installed package to avoid npx download delays
  const mcpEntry = resolve(__dirname, "../node_modules/@bnb-chain/mcp/dist/index.js");

  const transport = new StdioClientTransport({
    command: "node",
    args: [mcpEntry],
    env,
  });

  const client = new Client(
    { name: "bob-agent", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const tools = await loadTools(client);

  return { client, tools };
}

/**
 * Loads all available MCP tools and converts them to Anthropic tool format.
 */
async function loadTools(client: Client): Promise<Anthropic.Tool[]> {
  const result = await client.listTools();

  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? `BNB Chain tool: ${tool.name}`,
    input_schema: (tool.inputSchema as Anthropic.Tool["input_schema"]) ?? {
      type: "object" as const,
      properties: {},
    },
  }));
}

/**
 * Executes an MCP tool call and returns the result as a string.
 */
export async function executeTool(
  client: Client,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name, arguments: input });

  if (!result.content || !Array.isArray(result.content)) {
    return "No result returned from tool.";
  }

  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((b) => {
      if (b.type === "text" && b.text) return b.text;
      return JSON.stringify(b);
    })
    .join("\n");

  if (result.isError) {
    return `Tool error: ${text}`;
  }

  return text || "Tool executed successfully (no output).";
}
