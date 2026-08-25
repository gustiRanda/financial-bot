const Tesseract = require("tesseract.js");
const logger = require("./logger");
const { parseAmountFromReceiptText, guessMerchantFromReceiptText, guessAccountFromReceiptText } = require("./receiptParsing");

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