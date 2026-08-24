const Tesseract = require("tesseract.js");
const logger = require("./logger");

function parseAmountFromReceiptText(text) {
  const lines = text.split("\n");
  const numRegex = /[\d.,]{4,}/g;
  const totalLine = lines.find(l => /total|jumlah|bayar/i.test(l));
  if (totalLine) {
    const nums = totalLine.match(numRegex);
    if (nums) {
      const val = Number(nums[nums.length - 1].replace(/[.,]/g, ""));
      if (Number.isFinite(val) && val > 0) return val;
    }
  }
  const allNums = (text.match(numRegex) || [])
    .map(n => Number(n.replace(/[.,]/g, "")))
    .filter(n => Number.isFinite(n) && n > 100);
  return allNums.length ? Math.max(...allNums) : null;
}

const BOILERPLATE = /transaction|summary|delivered|details|benefit|gostar|join|level up|download|repeat|need help|purchase item|without cutlery|handling|discount|price|paid with|payment/i;

function guessMerchantFromReceiptText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Food-delivery receipts (GoFood/GrabFood-style) label the merchant explicitly
  const labelIdx = lines.findIndex(l => /restaurant location|merchant|store name/i.test(l));
  if (labelIdx !== -1 && lines[labelIdx + 1]) return lines[labelIdx + 1];

  // Otherwise fall back to the first substantial line that isn't app boilerplate
  return lines.find(l => l.length > 3 && !BOILERPLATE.test(l) && !/^\d+$/.test(l)) || "";
}

function guessAccountFromReceiptText(text, accounts = []) {
  const paidWithMatch = text.match(/paid\s*with\s*([a-z0-9\s]+)/i);
  if (paidWithMatch) {
    const candidate = paidWithMatch[1].trim();
    const found = accounts.find(a => candidate.toLowerCase().includes(a.toLowerCase()));
    if (found) return found;
  }
  return accounts.find(a => new RegExp(a, "i").test(text)) || null;
}

async function extractReceiptData(imageUrl, accounts = []) {
  logger.info("OCR: starting recognition for", imageUrl);
  const { data } = await Tesseract.recognize(imageUrl, "eng");

  if (!data.text) {
    logger.warn("OCR: Tesseract returned no text");
    return { amount: null, description: "", account: null };
  }

  const result = {
    amount: parseAmountFromReceiptText(data.text),
    description: guessMerchantFromReceiptText(data.text),
    account: guessAccountFromReceiptText(data.text, accounts)
  };
  logger.info("OCR: extracted", result);
  return result;
}

module.exports = { extractReceiptData };