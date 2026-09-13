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

    const prompt = `This is a receipt or proof-of-payment (image or PDF). It could be a purchase
        receipt (restaurant, retail, delivery app) OR a bank/e-wallet transfer confirmation. Extract the transaction.

        Valid accounts (payment methods): ${accounts.join(", ")}
        Valid expense categories: ${expenseCategories.join(", ")}

        Reply with ONLY a JSON object, nothing else:
        {"amount": number (the final total actually paid, whole number, no currency symbols/decimals), "description": string (a short human-readable summary of what this was for. For a purchase receipt, use the merchant/store name. For a bank/e-wallet transfer, combine the purpose and the recipient if both are available — e.g. a note "bayar utang makan" sent to "Gusti Randa" should become something like "bayar utang ke Gusti" (use the recipient's first name, not their full formal name). If there's only a note with no recipient, or only a recipient with no note, use whichever is available.), "category": one of the valid expense categories that best fits, "account": one of the valid accounts if identifiable from the payment method or source account shown, or null if unclear}

        If this doesn't look like a receipt or payment confirmation at all, reply with exactly: null`
    ;

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