const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger");
const { callGeminiWithFallback, getModelList, envMs } = require("./geminiCall");
const { parseIndoAmount } = require("./chatParser");

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

Indonesian amounts use "." as the thousands separator and "," for cents: "IDR 23.000,00" means 23000.

Valid accounts (payment methods): ${accounts.join(", ")}
Valid expense categories: ${expenseCategories.join(", ")}

Reply with ONLY a JSON object, nothing else:
{"amount": number (the final total actually paid, whole number, no currency symbols/decimals), "description": string (a short human-readable summary of what this was for, in this priority order: (1) if there's a specific product/item/package name listed — e.g. a phone data package, a specific menu item, a specific product — use that, since it's more useful than the store name; (2) if there's a transfer note/memo/message field, combine the purpose with the recipient's first name — e.g. "bayar utang ke Frischi"; (3) only fall back to the merchant/store/platform name (e.g. "Shopee", "GoFood") if nothing more specific is available. Never use a generic platform name like Shopee/GoFood/Grab when a specific item or note is visible on the receipt.), "category": one of the valid expense categories that best fits, "account": one of the valid accounts if identifiable from the payment method or source account shown, or null if unclear}

If this doesn't look like a receipt or payment confirmation at all, reply with exactly: null`;

  const started = Date.now();
  const models = getModelList();
  logger.info(`Receipt AI: sending ${Math.round(buffer.length / 1024)} KB (${mimeType}) — models in order: ${models.join(" → ")}`);

  let raw;
  try {
    const { result, model: usedModel } = await callGeminiWithFallback(
      models,
      modelName =>
        ai.getGenerativeModel({ model: modelName }).generateContent({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }, { inlineData: { mimeType, data: buffer.toString("base64") } }]
            }
          ]
        }),
      {
        label: "Receipt AI",
        // Defaults: 45s per attempt, 90s in total. Tunable from the Vercel env vars, but capped
        // (90s / 120s) so the whole message still finishes inside the 150s function limit.
        attemptTimeoutMs: envMs("GEMINI_ATTEMPT_TIMEOUT_MS", 45000, 90000),
        totalBudgetMs: envMs("GEMINI_TOTAL_BUDGET_MS", 90000, 120000)
      }
    );
    logger.info(`Receipt AI: model used: ${usedModel}`);
    raw = result.response.text().trim();
  } catch (err) {
    logger.error(`Receipt AI: call failed after ${Date.now() - started}ms:`, err.message || err);
    return null;
  }

  logger.info(`Receipt AI: answered in ${Date.now() - started}ms, raw response:`, raw);
  if (!raw || raw === "null") return null;

  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const amount = typeof parsed.amount === "number" ? Math.round(parsed.amount) : parseIndoAmount(parsed.amount);
    if (!amount) {
      logger.warn("Receipt AI: no usable amount in response, treating as failure:", parsed);
      return null;
    }
    parsed.amount = amount;
    logger.info("Receipt AI: parsed:", parsed);
    return parsed;
  } catch (err) {
    logger.error("Receipt AI: couldn't parse Gemini's reply as JSON:", err.message);
    return null;
  }
}

module.exports = { analyzeReceiptWithAI };
