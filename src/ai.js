const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger");

let client = null;
function getClient() {
  if (!client && process.env.GEMINI_API_KEY) {
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return client;
}

async function parseWithAI(text, { accounts, incomeCategories, expenseCategories }) {
  const ai = getClient();
  if (!ai) {
    logger.warn("AI parse skipped: GEMINI_API_KEY is not set in .env");
    return null;
  }

  const prompt = `Extract a financial transaction from this message: "${text}"

Valid accounts: ${accounts.join(", ")}
Valid expense categories: ${expenseCategories.join(", ")}
Valid income categories: ${incomeCategories.join(", ")}

Reply with ONLY a JSON object, nothing else:
{"type": "income" or "expense", "description": string, "amount": number, "category": one of the valid categories for that type, "account": one of the valid accounts}

If you can't confidently fill every field, reply with exactly: null`;

  logger.info("AI parse: sending prompt to Gemini for text:", text);

  let raw;
  try {
    // Create a model instance with the correct name
    const model = ai.getGenerativeModel({ model: "gemini-3.6-flash" });

    // Correct request format
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    });

    raw = result.response.text().trim();
  } catch (err) {
    logger.error("AI parse: Gemini API call threw an error:", err.message || err);
    return null;
  }

  logger.info("AI parse: raw Gemini response:", raw);

  if (!raw || raw === "null") {
    logger.warn("AI parse: Gemini couldn't confidently extract a transaction");
    return null;
  }

  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!parsed.type || !parsed.amount || !parsed.account || !parsed.category) {
      logger.warn("AI parse: response missing required fields:", parsed);
      return null;
    }
    logger.info("AI parse: successfully parsed:", parsed);
    return parsed;
  } catch (err) {
    logger.error("AI parse: failed to JSON.parse Gemini output:", err.message);
    return null;
  }
}

module.exports = { parseWithAI };
