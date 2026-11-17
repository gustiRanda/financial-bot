const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger");
const { parseIndoAmount } = require("./chatParser");

// Same model your working version used. Set GEMINI_MODEL in the env to switch
// models without touching code (handy when one model is overloaded).
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

let client = null;
function getClient() {
  if (!client && process.env.GEMINI_API_KEY) {
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return client;
}

// ---- retry on temporary Gemini errors (503 "high demand", 429 rate limit) ----
function isRetryableError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("503") || msg.includes("overloaded") || msg.includes("high demand") || msg.includes("429") || msg.includes("rate limit");
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        const delayMs = 1000 * (attempt + 1);
        logger.warn(`AI parse: temporary Gemini error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms:`, err.message);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---- make sure the AI's answer only contains things that really exist in the sheet ----
function matchCI(list, value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  return list.find(x => String(x).toLowerCase() === v) || null;
}

function normalizeAIResult(parsed, { accounts, incomeCategories, expenseCategories }) {
  if (!parsed || typeof parsed !== "object") return null;

  const type = String(parsed.type || "").toLowerCase();
  if (type !== "income" && type !== "expense") return null;

  const amount = typeof parsed.amount === "number" ? Math.round(parsed.amount) : parseIndoAmount(parsed.amount);
  if (!amount || amount <= 0) return null;

  const categories = type === "income" ? incomeCategories : expenseCategories;
  const category = matchCI(categories, parsed.category) || matchCI(categories, "other") || categories[0] || null;
  if (!category) return null;

  return {
    type,
    amount,
    category,
    account: matchCI(accounts, parsed.account), // null when the message didn't name a valid account
    description: String(parsed.description || "").trim()
  };
}

// Returns { type, amount, category, account|null, description } or null.
async function parseWithAI(text, { accounts, incomeCategories, expenseCategories }) {
  const ai = getClient();
  if (!ai) {
    logger.warn("AI parse skipped: GEMINI_API_KEY is not set");
    return null;
  }

  const prompt = `You extract ONE financial transaction from a casual chat message.
The message may be Indonesian, English, or mixed, informal, in any word order.
Examples: "Cash 5000 gorengan", "gajian 7jt masuk bri", "kemarin makan 25rb pake gopay", "dikasih temen 300rb ke dana".

Message: "${text}"

Valid accounts: ${accounts.join(", ")}
Valid expense categories: ${expenseCategories.join(", ")}
Valid income categories: ${incomeCategories.join(", ")}

Rules:
- type: "income" if money came IN (salary/gaji, bonus, refund, someone paid or gave me money, received/dapat/terima/dikasih). Otherwise "expense".
- amount: whole rupiah as a plain number. Convert Indonesian shorthand: "2k" / "2rb" / "2 ribu" = 2000, "300rb" = 300000, "7jt" / "7 juta" = 7000000, "1,5jt" / "1.5jt" = 1500000, "setengah juta" = 500000, "5.000" = 5000.
- account: one of the valid accounts if the message names one (match loosely: "sea bank" = SeaBank, "tunai" = Cash). If none is named, use null. Never invent an account.
- category: the best-fitting one from the valid categories for that type; use "Other" if nothing fits.
- description: short and clean (1-5 words) saying what it was for, without the amount or account. Keep the user's language.

Reply with ONLY a JSON object, nothing else:
{"type": "income" or "expense", "description": string, "amount": number, "category": string, "account": string or null}

If the message contains no transaction amount at all, reply with exactly: null`;

  logger.info("AI parse: sending to Gemini:", text);

  let raw;
  try {
    const model = ai.getGenerativeModel({ model: MODEL });
    const result = await withRetry(() =>
      model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
    );
    raw = result.response.text().trim();
  } catch (err) {
    logger.error("AI parse: Gemini API call failed:", err.message || err);
    return null;
  }

  logger.info("AI parse: raw Gemini response:", raw);
  if (!raw || raw === "null") {
    logger.warn("AI parse: Gemini found no transaction in this message");
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (err) {
    logger.error("AI parse: couldn't JSON.parse Gemini's reply:", err.message);
    return null;
  }

  const result = normalizeAIResult(parsed, { accounts, incomeCategories, expenseCategories });
  if (!result) {
    logger.warn("AI parse: reply failed validation:", parsed);
    return null;
  }
  logger.info("AI parse: success:", result);
  return result;
}

module.exports = { parseWithAI, normalizeAIResult };
