import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { executeTool } from "./mcp-client.js";
import { BOB_SYSTEM_PROMPT } from "./system-prompt.js";

export class BobAgent {
  private client: Anthropic;
  private mcpClient: Client;
  private tools: Anthropic.Tool[];
  private messages: Anthropic.MessageParam[] = [];

  constructor(mcpClient: Client, tools: Anthropic.Tool[]) {
    this.client = new Anthropic();
    this.mcpClient = mcpClient;
    this.tools = tools;
  }

  getToolCount(): number {
    return this.tools.length;
  }

  getToolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  clearHistory(): void {
    this.messages = [];
  }

  /**
   * Send a message to BOB and get a streaming response.
   * Handles the full agentic loop: tool calls → results → final answer.
   */
  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });

    let iterationCount = 0;
    const maxIterations = 20; // Safety limit

    while (iterationCount < maxIterations) {
      iterationCount++;

      const stream = this.client.messages.stream({
        model: "claude-opus-4-6",
        max_tokens: 8192,
        system: BOB_SYSTEM_PROMPT,
        tools: this.tools,
        messages: this.messages,
      });

      // Stream BOB's text response in real time
      let hasText = false;
      stream.on("text", (delta) => {
        if (!hasText) {
          process.stdout.write("\nBOB: ");
          hasText = true;
        }
        process.stdout.write(delta);
      });

      const message = await stream.finalMessage();

      if (hasText) {
        process.stdout.write("\n");
      }

      // Append assistant response to history
      this.messages.push({ role: "assistant", content: message.content });

      // Done — no more tool calls
      if (message.stop_reason === "end_turn") {
        break;
      }

      // Handle tool use
      if (message.stop_reason === "tool_use") {
        const toolUseBlocks = message.content.filter(
          (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        if (toolUseBlocks.length === 0) break;

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const tool of toolUseBlocks) {
          process.stdout.write(`\n  [🔧 ${tool.name}...] `);

          try {
            const result = await executeTool(
              this.mcpClient,
              tool.name,
              tool.input as Record<string, unknown>
            );
            process.stdout.write("✓\n");
            toolResults.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: result,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            process.stdout.write(`✗ Error\n`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: `Error executing ${tool.name}: ${errMsg}`,
              is_error: true,
            });
          }
        }

        this.messages.push({ role: "user", content: toolResults });
        continue;
      }

      // pause_turn: server wants us to re-send to continue
      if (message.stop_reason === "pause_turn") {
        continue;
      }

      break;
    }
  }
}
