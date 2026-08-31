const pdfParseModule = require("pdf-parse");
const pdfParse = typeof pdfParseModule === "function" ? pdfParseModule : pdfParseModule.default;
const logger = require("./logger");
const { parseAmountFromReceiptText, guessMerchantFromReceiptText, guessAccountFromReceiptText } = require("./receiptParsing");

async function extractReceiptDataFromPDF(buffer, accounts = []) {
  logger.info("PDF OCR: parsing PDF");
  let data;
  try {
    console.log(Buffer.isBuffer(buffer)); // should print true
    console.log(pdfParse);
    console.log(typeof pdfParse);


    data = await pdfParse(buffer);
  } catch (err) {
    logger.error("PDF OCR: failed to parse PDF:", err);
    return { amount: null, description: "", account: null };
  }

  const text = data.text || "";
  if (!text.trim()) {
    logger.warn("PDF OCR: no extractable text — likely a scanned/image-only PDF (not supported yet)");
    return { amount: null, description: "", account: null };
  }

  const result = {
    amount: parseAmountFromReceiptText(text),
    description: guessMerchantFromReceiptText(text),
    account: guessAccountFromReceiptText(text, accounts)
  };
  logger.info("PDF OCR: extracted", result);
  return result;
}

module.exports = { extractReceiptDataFromPDF };