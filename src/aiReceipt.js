const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger");

let client = null;
function getClient() {
  if (!client && process.env.GEMINI_API_KEY) {
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return client;
}

async function analyzeReceiptWithAI(buffer, mimeType, { accounts, expenseCategories }) {
  const ai = getClient();
  if (!ai) {
    logger.warn("Receipt AI skipped: GEMINI_API_KEY not set");
    return null;
  }

  const prompt = `This is a receipt or proof-of-payment (image or PDF). Extract the transaction.

Valid accounts (payment methods): ${accounts.join(", ")}
Valid expense categories: ${expenseCategories.join(", ")}

Reply with ONLY a JSON object, nothing else:
{"amount": number (the final total actually paid, whole number, no currency symbols/decimals), "description": string (merchant/restaurant/store name, not the platform name like GoFood/Grab), "category": one of the valid expense categories that best fits, "account": one of the valid accounts if identifiable from the payment method shown, or null if unclear}

If this doesn't look like a receipt at all, reply with exactly: null`;

  try {
    const model = ai.getGenerativeModel({ model: "gemini-3.6-flash" });
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: buffer.toString("base64") } }
          ]
        }
      ]
    });
    const raw = result.response.text().trim();
    logger.info("Receipt AI: raw response:", raw);
    if (!raw || raw === "null") return null;

    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!parsed.amount) {
      logger.warn("Receipt AI: no amount in response, treating as failure:", parsed);
      return null;
    }
    logger.info("Receipt AI: parsed:", parsed);
    return parsed;
  } catch (err) {
    logger.error("Receipt AI: call failed:", err.message || err);
    return null;
  }
}

module.exports = { analyzeReceiptWithAI };