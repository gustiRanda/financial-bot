const Anthropic = require("@anthropic-ai/sdk");

let client = null;
function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

async function parseWithAI(text, { accounts, incomeCategories, expenseCategories }) {
  const anthropic = getClient();
  if (!anthropic) return null; // no API key set — silently skip AI

  const prompt = `Extract a financial transaction from this message: "${text}"

Valid accounts: ${accounts.join(", ")}
Valid expense categories: ${expenseCategories.join(", ")}
Valid income categories: ${incomeCategories.join(", ")}

Reply with ONLY a JSON object, nothing else:
{"type": "income" or "expense", "description": string, "amount": number, "category": one of the valid categories for that type, "account": one of the valid accounts}

If you can't confidently fill every field, reply with exactly: null`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }]
  });

  const raw = response.content.find(b => b.type === "text")?.text?.trim();
  if (!raw || raw === "null") return null;
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!parsed.type || !parsed.amount || !parsed.account || !parsed.category) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = { parseWithAI };