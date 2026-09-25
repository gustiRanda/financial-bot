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
    receipt (restaurant, retail, delivery app, e-commerce/digital goods) OR a bank/e-wallet transfer confirmation. Extract the transaction.

    Valid accounts (payment methods): ${accounts.join(", ")}
    Valid expense categories: ${expenseCategories.join(", ")}

    Reply with ONLY a JSON object, nothing else:
    {"amount": number (the final total actually paid, whole number, no currency symbols/decimals), "description": string (a short human-readable summary of what this was for, in this priority order: (1) if there's a specific product/item/package name listed — e.g. a phone data package, a specific menu item, a specific product — use that, since it's more useful than the store name; (2) if there's a transfer note/memo/message field, combine the purpose with the recipient's first name — e.g. "bayar utang ke Frischi"; (3) only fall back to the merchant/store/platform name (e.g. "Shopee", "GoFood") if nothing more specific is available. Never use a generic platform name like Shopee/GoFood/Grab when a specific item or note is visible on the receipt.), "category": one of the valid expense categories that best fits, "account": one of the valid accounts if identifiable from the payment method or source account shown, or null if unclear}

    If this doesn't look like a receipt or payment confirmation at all, reply with exactly: null`;

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