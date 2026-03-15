import Groq from "groq-sdk";

const MODEL = "llama-3.3-70b-versatile";
let groqClient: Groq | null = null;

function getClient(): Groq {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });
  }
  return groqClient;
}

export async function ask(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 512
): Promise<string> {
  try {
    const response = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return response.choices[0]?.message?.content ?? "";
  } catch (e) {
    console.error("[GROQ] Error:", e);
    return "";
  }
}

// Classify an agent based on its metadata
export async function classifyAgent(metadata: {
  name: string;
  description: string;
  services: string[];
  score: number;
}): Promise<{ status: "active" | "inactive" | "ghost" | "rugger"; notes: string }> {
  const prompt = `You are analyzing an ERC-8004 AI agent on BNB Chain.

Agent data:
Name: ${metadata.name}
Description: ${metadata.description}
Services: ${metadata.services.join(", ")}
Score: ${metadata.score}

Classify this agent:
- "active": Has real services, responds, is doing something useful
- "inactive": Registered but not doing much, low score, no real services
- "ghost": Empty or minimal metadata, no real purpose
- "rugger": Shows signs of malicious intent, rug patterns, pump&dump language

Reply with JSON only: {"status": "active|inactive|ghost|rugger", "notes": "one line reason"}`;

  const result = await ask(
    "You are a blockchain agent analyst. Reply with valid JSON only, no markdown.",
    prompt,
    128
  );

  try {
    return JSON.parse(result.trim());
  } catch {
    return { status: "inactive", notes: "Could not classify" };
  }
}

// Analyze if a rug pull is 100% confirmed
export async function analyzeRug(data: {
  priceDropPct: number;
  liquidityRemovedPct: number;
  timeToRug: string;
  deployerActions: string;
}): Promise<{ confirmed: boolean; confidence: number; notes: string }> {
  const prompt = `Analyze this potential rug pull:
Price drop: ${data.priceDropPct}%
Liquidity removed: ${data.liquidityRemovedPct}%
Time from launch to rug: ${data.timeToRug}
Deployer actions: ${data.deployerActions}

Is this a 100% confirmed rug pull? Only say confirmed=true if you are CERTAIN.
Reply with JSON: {"confirmed": true|false, "confidence": 0-100, "notes": "reason"}`;

  const result = await ask(
    "You are a DeFi security analyst. Only confirm rugs when 100% certain. Reply JSON only.",
    prompt,
    128
  );

  try {
    return JSON.parse(result.trim());
  } catch {
    return { confirmed: false, confidence: 0, notes: "Analysis failed" };
  }
}
